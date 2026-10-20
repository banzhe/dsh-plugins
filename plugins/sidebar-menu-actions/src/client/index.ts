/**
 * Sidebar-menu browser half: a Workspace row-menu contribution over one locale
 * namespace and one notice surface.
 *
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
// Type-only: the ctx.locale service merge (register/bind).
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: the ctx.slots SlotRegistry service merge.
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
// Type-only: Context.workspaces (IWorkspaces) service merge — `pathOf` reads its snapshot.
import type {} from '@deepseek-ai/dsh-api-workspace-controller/client'
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
