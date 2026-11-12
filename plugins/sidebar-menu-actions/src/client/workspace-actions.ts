/**
 * The rows this plugin contributes to the official Workspace row menu: open the
 * Workspace in VS Code, open it in the OS's file browser, and copy its path.
 *
 * The rows are data, not DOM: `src/client/index.ts` registers one contribution
 * against the `workspace` target the sidebar's "..." trigger captures, and the
 * shared menu owns the popup, the keyboard walk, focus return, and dismissal.
 * A row is built only for an application the Host's catalog resolved (see
 * `probe.ts`); the copy row needs nothing from the Host and is always built.
 *
 * Every row resolves the directory when it RUNS, not when the menu opened: the
 * captured target carries the path the row showed, and a Workspace can leave the
 * registry between the two. A row whose Workspace is gone therefore launches and
 * copies nothing.
 */
import { ICON_KEYS } from './icons.tsx'
import type { LaunchAppId } from './probe.ts'
import type { MenuActionsKey } from './locales.ts'

/** Contribution id inside the `workspace` target family; the registry keys contributions by it. */
export const CONTRIBUTION_ID = 'sidebar-menu-actions.workspace'

/**
 * Position within the family: after the shipped rename row (100), before the
 * shipped delete row (300) and the official `open-in-app.workspace` reveal row
 * (200) — the order the rows had when they were grafted in.
 */
export const CONTRIBUTION_ORDER = 110

/** The captured Workspace: the clicked row's id. Its path is read when a row runs. */
export interface WorkspaceMenuTarget {
  readonly workspaceId: string
}

/** One row's stable id, also the marker a test or a log line can name. */
export type WorkspaceMenuId = LaunchAppId | 'copy-path'

/** One row of the shared menu, in the subset this plugin builds. */
export interface WorkspaceMenuAction {
  readonly id: WorkspaceMenuId
  readonly label: string
  /** Keyed `contextMenu.icon` entry this row's glyph comes from. */
  readonly icon: { readonly key: string }
  /** Launch or copy the Workspace; never rejects — a failure is reported as a notice. */
  readonly run: () => Promise<void>
}

/** What one resolution needs: the catalog answer, the click-time path, and the two operations. */
export interface WorkspaceMenuDeps {
  /** Localized copy for the rows. */
  readonly t: (key: MenuActionsKey, params?: Record<string, unknown>) => string
  /** Catalog ids the Host resolved; a launch row is built only for one of them. */
  readonly apps: ReadonlySet<string>
  /** The Workspace's canonical directory right now, or undefined when it left the registry. */
  readonly pathAt: (workspaceId: string) => string | undefined
  /** Open one directory in one catalog application; reports its own failures. */
  readonly launch: (app: LaunchAppId, path: string) => Promise<void>
  /** Write one directory to the clipboard; reports its own outcome. */
  readonly copy: (path: string) => Promise<void>
}

/** The launch rows in menu order, each gated on the Host having resolved its catalog id. */
const LAUNCH_ROWS: readonly { readonly id: LaunchAppId; readonly label: MenuActionsKey; readonly icon: string }[] = [
  { id: 'vscode', label: 'menu.openInVscode', icon: ICON_KEYS.vscode },
  { id: 'explorer', label: 'menu.openInFileBrowser', icon: ICON_KEYS.explorer },
]

/**
 * Build the rows for one Workspace.
 * @param target - the clicked Workspace.
 * @param deps - catalog answer, click-time directory reader, and the two operations.
 * @returns at least the copy row, then the launch rows the catalog allows, in menu order.
 */
export function buildWorkspaceActions(
  target: WorkspaceMenuTarget,
  deps: WorkspaceMenuDeps,
): WorkspaceMenuAction[] {
  const withPath = (act: (path: string) => Promise<void>) => async (): Promise<void> => {
    const path = deps.pathAt(target.workspaceId)
    if (path === undefined) return
    await act(path)
  }
  const rows: WorkspaceMenuAction[] = []
  for (const row of LAUNCH_ROWS) {
    if (!deps.apps.has(row.id)) continue
    rows.push({
      id: row.id,
      label: deps.t(row.label),
      icon: { key: row.icon },
      run: withPath(path => deps.launch(row.id, path)),
    })
  }
  rows.push({
    id: 'copy-path',
    label: deps.t('menu.copyWorkspacePath'),
    icon: { key: ICON_KEYS.copyPath },
    run: withPath(deps.copy),
  })
  return rows
}
