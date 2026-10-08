/**
 * Sidebar-menu browser half: two row-menu contributions over one locale
 * namespace and one notice surface.
 *
 * - **Copy session ID** — an ordinary `sidebar.workspaces.session.menu.item`
 *   slot entry (order 500: after the shipped pin/rename/fork/archive at
 *   100–400). Registered unconditionally: it needs nothing from the Host.
 * - **Open a Workspace in VS Code** — DOM graft into the Workspace "..." menu,
 *   which ships with **no slot**. Arms only after `GET open-in-app/apps`
 *   resolves `vscode`; otherwise the whole half stays inert. See
 *   `workspaceMenu.ts` for the DOM contract.
 *
 * Both routes report through the plugin's notice surface: the shipped `Toast`
 * primitive, mounted by a `shell.overlay` entry. Nothing is self-owned — no
 * stylesheet, no element, no timer — so the entry leaves with its slot
 * registration and the primitive owns the banner's styling and hold.
 */

import type { Context } from '@deepseek-ai/cordis'
import { useSyncExternalStore } from 'react'
// Runtime platform external (see tsdown.config.ts): the shell seeds this module.
import { writeClipboard } from '@deepseek-ai/dsh-client-ui-primitives'
// Type-only: the ctx.locale service merge (register/bind).
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: the ctx.slots SlotRegistry service merge.
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
// Type-only: Context.workspaces (IWorkspaces) service merge — `pathOf` reads its snapshot.
import type {} from '@deepseek-ai/dsh-api-workspace-controller/client'
// Type-only: the session.menu.item SlotMap entry + `GlobalStandardProps` seat
// the composed row props resolve against.
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import { CopySessionIdMenuItem, type CopySessionIdInjected } from './CopySessionIdMenuItem.tsx'
import { NoticeToast, type NoticeToastInjected } from './NoticeToast.tsx'
import { createNoticeStore, type Notice } from './noticeStore.ts'
import { en, NS, zh, type MenuActionsKey } from './locales.ts'
import { installWorkspaceMenu, probeVscode } from './workspaceMenu.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    'menu-actions': MenuActionsKey
  }
}

export const inject = ['workspaces', 'locale', 'slots']

export function apply(ctx: Context): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'menu-actions: dictionaries')
  const t = ctx.locale.bind(NS)
  const notices = createNoticeStore()
  /**
   * The store's members read as unbound methods to the linter, so the pair is
   * wrapped once here instead of inline at the call site. It must keep this
   * identity across renders: `useSyncExternalStore` resubscribes whenever
   * `subscribe` changes.
   */
  const subscribeNotices = (listener: () => void): (() => void) => notices.subscribe(listener)
  const snapshotNotices = (): Notice | null => notices.snapshot()
  /** Stable render-time reader, invoked by the overlay entry on every render. */
  const useNotice = (): Notice | null => useSyncExternalStore(subscribeNotices, snapshotNotices)
  /** Surface one resolved notice; the overlay entry renders it through `Toast`. */
  const showToast = (text: string): void => { notices.show(text) }
  const noticeInjected = (): NoticeToastInjected => ({
    useNotice,
    dismiss: (seq: number) => { notices.dismiss(seq) },
  })

  // The notice surface is the shell's overlay seat, registered unconditionally:
  // with no notice pending the entry renders nothing at all.
  ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay',
    id: 'sidebar-menu-actions.notice',
    locale: NS,
    inject: noticeInjected,
  }, NoticeToast))

  /** Canonical directory of a Workspace by its row-key id, or undefined when gone. */
  const pathOf = (workspaceId: string): string | undefined =>
    ctx.workspaces.list.getSnapshot().items
      .find(item => String(item.workspaceId) === workspaceId)?.path

  /** Clipboard write answering itself: success and failure each raise one notice. */
  const copy = async (sessionId: string): Promise<void> => {
    if (await writeClipboard(sessionId)) {
      showToast(t('toast.copied'))
      return
    }
    // The helper never throws, so a refused write is the only failure there is.
    console.warn('sidebar-menu-actions: copy session id failed: the clipboard refused the write')
    showToast(t('toast.copyFailed'))
  }
  // The injected face declares `copy` as void, but handing over the async
  // function itself is what lets a spec await the notice update inside `act()`
  // (tests/browser-plugin.spec.ts reads the returned promise).
  // oxlint-disable-next-line typescript/no-misused-promises
  const copyInjected = (): CopySessionIdInjected => ({ copy })

  // Slot registration waits for ui-workspace's declaration; the entry leaves with it.
  ctx.slots.inject('sidebar.workspaces.session.menu.item', () => ctx.slots.register({
    name: 'sidebar.workspaces.session.menu.item',
    id: 'sidebar-menu-actions.copy-session-id',
    order: 500,
    locale: NS,
    inject: copyInjected,
  }, CopySessionIdMenuItem))

  // Workspace-menu half: probe first, install only on a positive answer, and
  // tear the listeners down with the fiber — whichever side settles first.
  let teardown: (() => void) | undefined
  let disposed = false
  ctx.effect(() => () => {
    disposed = true
    teardown?.()
  }, 'menu-actions: workspace menu lifetime')
  void probeVscode().then((ready) => {
    if (disposed) return
    if (!ready) {
      console.warn('sidebar-menu-actions: VS Code is not available on this host; the workspace menu item stays disabled')
      return
    }
    teardown = installWorkspaceMenu({ t, pathOf, showToast })
  })
}
