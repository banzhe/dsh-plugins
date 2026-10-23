/**
 * Sidebar-menu browser half: a Workspace row-menu contribution over one locale
 * namespace and one notice surface.
 *
 * - **Copy workspace path** — a DOM graft into the Workspace "..." menu, which
 *   ships with **no slot**. Always grafted: a clipboard write is browser-local.
 * - **Open a Workspace in VS Code** and **Open in the file browser** — the same
 *   graft, each added only once `GET open-in-app/apps` resolves its catalog id.
 *   The file-browser row (`explorer`) is declared on Windows alone by the
 *   official catalog, so it appears only on a Windows Host and launches the
 *   user's configured default handler for a directory. See `workspaceMenu.ts`
 *   for the DOM contract.
 *
 * Every route reports through the plugin's notice surface: the shipped `Toast`
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
import { NoticeToast, type NoticeToastInjected } from './NoticeToast.tsx'
import { createNoticeStore, type Notice } from './noticeStore.ts'
import { en, NS, zh, type MenuActionsKey } from './locales.ts'
import { installWorkspaceMenu, LAUNCH_APP_IDS, probeOpenInApps } from './workspaceMenu.ts'

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
  const useNotice = (): Notice | null => useSyncExternalStore(subscribeNotices, snapshotNotices)
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

  const copyPath = (path: string): void => {
    void writeClipboard(path).then((accepted) => {
      if (accepted) {
        showToast(t('toast.pathCopied'))
        return
      }
      // The helper never throws, so a refused write is the only failure there is.
      console.warn('sidebar-menu-actions: copy workspace path failed: the clipboard refused the write')
      showToast(t('toast.copyFailed'))
    })
  }

  // The copy row needs nothing from the Host, so the install is immediate; the
  // launch rows join it only after the probe answers, read at graft time.
  let launchable: ReadonlySet<string> = new Set()
  let tornDown = false
  const teardown = installWorkspaceMenu({
    t,
    pathOf,
    showToast,
    launchableApps: () => launchable,
    copyPath,
  })
  ctx.effect(() => () => {
    tornDown = true
    teardown()
  }, 'menu-actions: workspace menu lifetime')
  void probeOpenInApps().then((apps) => {
    // After teardown the warning below would be a lie: no menu survives to keep
    // any row. The flag guards that log line, not the install, which is already done.
    if (tornDown) return
    launchable = apps
    // One line per missing launch row, so a Host that resolved neither says so
    // explicitly instead of leaving two rows silently absent.
    for (const app of LAUNCH_APP_IDS) {
      if (apps.has(app)) continue
      console.warn(`sidebar-menu-actions: ${app} is not available on this host; the workspace menu omits that row`)
    }
  })
}
