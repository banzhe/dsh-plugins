/**
 * Sidebar-menu browser half: three Workspace row-menu actions contributed to the
 * official `workspace` context menu.
 *
 * - **Open in VS Code** and **Open in File Browser** POST the open-in-app Host
 *   route (`{app, path}`). Each is built only once the Host's catalog resolved
 *   its id (see `probe.ts`), and `explorer` is declared on `win32` alone, so the
 *   file-browser row appears only on a Windows Host — launching the OS's open
 *   verb for a directory, i.e. whichever file browser the user configured, not
 *   a hard-coded `explorer.exe`.
 * - **Copy workspace path** is browser-local and always built.
 *
 * The menu itself belongs to `@deepseek-ai/dsh-client-ui-context-menu`: this
 * plugin registers a contribution against the target the sidebar's "..." trigger
 * captures (`{workspaceId, path, displayTitle}`), so it inherits the shared
 * popup's positioning, keyboard walk, focus return, and dismissal, and owns no
 * element, stylesheet, listener, or timer. Rows carry a keyed icon; the glyphs
 * arrive from this plugin's `contextMenu.icon` registrations (`icons.tsx`).
 *
 * Feedback goes through the shared `ctx.contextMenus.notify` toast. A failing
 * row catches its own error and reports it once with the HTTP status or error
 * message — it never rejects, because a rejected action would raise the menu's
 * own failure notice on top of it.
 */
import type { Context } from '@deepseek-ai/cordis'
import { writeClipboard } from '@deepseek-ai/dsh-client-ui-primitives'
// Type-only: the ctx.locale service merge (register/bind).
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: the ctx.contextMenus service merge, the 'contextMenu.icon' SlotMap
// key, and the MenuAction row shape.
import type { MenuAction } from '@deepseek-ai/dsh-client-ui-context-menu/client'
// Type-only: the ctx.slots SlotRegistry service merge.
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
// Type-only: Context.workspaces (IWorkspaces) service merge — `pathAt` reads its snapshot.
import type {} from '@deepseek-ai/dsh-api-workspace-controller/client'
// Type-only: the 'workspace' ContextMenuTargetMap family the sidebar trigger captures.
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import {
  OPEN_IN_APP_OPEN_ROUTE,
  type OpenInAppOpenPayload,
} from '@deepseek-ai/dsh-host-open-in-app/shared'
import { ICON_ENTRIES } from './icons.tsx'
import { en, NS, zh, type MenuActionsKey } from './locales.ts'
import { createLaunchProbe, type LaunchAppId } from './probe.ts'
import { buildWorkspaceActions, CONTRIBUTION_ID, CONTRIBUTION_ORDER } from './workspace-actions.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    'menu-actions': MenuActionsKey
  }
}

/** Required services: the Workspace catalog, localization, the Slot registry, and the menu registry. */
export const inject = ['workspaces', 'locale', 'slots', 'contextMenus']

/** Per-row failure copy and the console prefix that goes with it. */
const LAUNCH_FAILURES: Record<LaunchAppId, { readonly copy: MenuActionsKey; readonly log: string }> = {
  vscode: { copy: 'toast.vscodeFailed', log: 'sidebar-menu-actions: open in VS Code failed:' },
  explorer: { copy: 'toast.fileBrowserFailed', log: 'sidebar-menu-actions: open in the file browser failed:' },
}

/** @param ctx - plugin-owned Client context. */
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'menu-actions: dictionaries')
  const t = ctx.locale.bind(NS)

  ctx.slots.inject('contextMenu.icon', function* () {
    for (const [key, Icon] of ICON_ENTRIES) {
      yield ctx.slots.register({ name: 'contextMenu.icon', key }, Icon)
    }
  })

  const probe = createLaunchProbe({
    warn: (line, detail) => {
      if (detail === undefined) console.warn(line)
      else console.warn(line, detail)
    },
  })
  // Warm the read at activation, so the first menu answers from the memo instead
  // of waiting on a cold request.
  probe.warm()

  /** Canonical directory of a Workspace by id, or undefined when it left the registry. */
  const pathAt = (workspaceId: string): string | undefined =>
    ctx.workspaces.list.getSnapshot().items
      .find(item => String(item.workspaceId) === workspaceId)?.path

  const report = (text: string, success?: boolean): void => { ctx.contextMenus.notify(text, success) }

  const failed = (app: LaunchAppId, detail: string): void => {
    const row = LAUNCH_FAILURES[app]
    console.warn(row.log, detail)
    report(t(row.copy, { detail }))
  }

  const launch = async (app: LaunchAppId, path: string): Promise<void> => {
    try {
      const response = await fetch(OPEN_IN_APP_OPEN_ROUTE, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ app, path } satisfies OpenInAppOpenPayload),
      })
      if (!response.ok) failed(app, `HTTP ${String(response.status)}`)
    } catch (cause) {
      failed(app, cause instanceof Error ? cause.message : String(cause))
    }
  }

  const copy = async (path: string): Promise<void> => {
    if (await writeClipboard(path)) {
      report(t('toast.pathCopied'), true)
      return
    }
    // The helper never throws, so a refused write is the only failure there is.
    console.warn('sidebar-menu-actions: copy workspace path failed: the clipboard refused the write')
    report(t('toast.copyFailed'))
  }

  ctx.effect(() => ctx.contextMenus.register({
    id: CONTRIBUTION_ID,
    target: 'workspace',
    order: CONTRIBUTION_ORDER,
    // `appsFor` owns the abort contract: a dismissed resolution rejects with the
    // AbortSignal's own reason, which the registry ignores as a cancellation.
    resolve: async (target, signal): Promise<readonly MenuAction[]> =>
      buildWorkspaceActions(
        { workspaceId: target.workspaceId },
        { t, apps: await probe.appsFor(signal), pathAt, launch, copy },
      ),
  }), 'menu-actions: workspace context menu')
}
