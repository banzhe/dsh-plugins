/**
 * The rows this plugin contributes to the official `file` context menu, as a
 * pure function of the clicked destination, the two app probes, and the
 * callbacks the plugin body supplies.
 *
 * Three groups, in this order: the line the link named (as a non-selectable
 * heading), the editors that can open the file, then the relative-path copy
 * row. The contribution always starts with a separator, because the shared menu
 * already holds the official rows above these, and a separator opens the copy
 * row whenever an editor row precedes it.
 *
 * The official `open-in-app.file` contribution (order 100) already offers
 * "reveal in file manager" and "copy path" for this same target, so this plugin
 * contributes neither: duplicating them showed the user two identical rows. The
 * editor rows are what the official menu does not have, and `copy-rel` copies
 * the workspace-relative path where the official row copies the absolute one.
 *
 * An editor is offered only when BOTH the official probe and this plugin's own
 * resolution verified it: the two resolver copies (the host dsh's and this
 * plugin's pinned one) may differ in version, and this intersection makes the
 * "menu shows it, click 400s" failure impossible. A host that answered
 * `/info` without `available` keeps the official intersection alone.
 */
import { EDITOR_IDS, type EditorId } from '../editors.ts'
import type { Translator } from './locales.ts'

/** The keyed `contextMenu.icon` entry every application row selects. */
export const APP_ICON_KEY = 'file-link-open.application'

/** Keyed icon metadata of one row (the `contextMenu.icon` owner contract). */
export interface ContextMenuIcon {
  readonly key: string
  readonly src?: string
}

/** The clicked destination as the official `file` target carries it. */
export interface FileTarget {
  /** The Session whose workspace root a relative destination resolves against. */
  readonly sessionId: string
  /** Destination as authored in the message; relative ones resolve against the Session directory. */
  readonly path: string
  /** 1-based line a `#L24` fragment named. */
  readonly line?: number
}

/**
 * This plugin's own row ids.
 *
 * `reveal` and `copyPath` are deliberately absent: the official
 * `open-in-app.file` contribution already registers them for this target.
 */
export type FileMenuId = 'line' | `app:${EditorId}` | 'copy-rel'

/** One row of the official file menu, in the subset this plugin builds. */
export interface FileMenuAction {
  readonly id: FileMenuId
  readonly label: string
  readonly icon?: ContextMenuIcon
  readonly disabled?: boolean
  readonly separatorBefore?: boolean
  /** Localized copy the shared menu shows when `run` rejects. */
  readonly failureLabel?: string
  readonly run?: () => void | Promise<void>
}

/** What the two app probes answered; null is "the host has not answered yet". */
export interface AppProbes {
  /** Ids the official `/open-in-app/apps` probe resolved, in the host's menu order. */
  readonly officialApps: readonly string[] | null
  /** This plugin's own resolution report, or null before the host answered. */
  readonly info: { readonly available?: readonly string[] | null | undefined } | null
}

/** Callbacks the built rows execute; the plugin body supplies the real ones. */
export interface FileMenuDeps {
  readonly t: Translator
  /**
   * The clicked Session's workspace root, or undefined while the host has not
   * reported one. Read per target: two panes of one window can show two
   * Sessions, and each resolves against its own directory.
   */
  readonly cwdOf: (sessionId: string) => string | undefined
  /** Keyed icon metadata for one catalog id. */
  readonly icon: (appId: string) => ContextMenuIcon
  /** Open one absolute file path in a whitelisted editor, revealing `line` when one was named. */
  readonly launch: (appId: string, absolutePath: string, line: number | null) => Promise<void>
  /** Copy one string; rejects when the clipboard refused, which the shared menu reports. */
  readonly copy: (text: string) => Promise<void>
}

function isWindowsStyledPath(value: string) {
  return /^[A-Za-z]:[/\\]/.test(value) || value.startsWith('\\\\')
}

/**
 * Resolve a destination against the Session's workspace root, mirroring
 * `resolveWorkspacePath` from `@deepseek-ai/dsh-util-workspace-path`
 * (0.2.2-rc.2) — including its dropping of leading `./` segments and its
 * choice of the root's own separator — with ONE deliberate difference: the
 * joined path is spelled in that separator throughout.
 *
 * A Windows root and a slash-authored message link join to
 * `C:\work\demo/CabinetRecognition/X.cs` under the official helper: the Host
 * resolves it, but the mixed spelling travels into launch argv, editor titles,
 * and logs. Absolute destinations pass through untouched, so an authored
 * absolute path keeps the spelling its author chose.
 * @param cwd - the Session's workspace root, when the host reported one.
 * @param path - the destination as authored; absolute ones pass through.
 * @returns the absolute path in the root's separator, or the destination unchanged without a root.
 */
export function resolveAgainstCwd(cwd: string | null | undefined, path: string) {
  if (path.startsWith('/') || isWindowsStyledPath(path)) return path
  if (cwd === null || cwd === undefined || cwd === '') return path
  const separator = isWindowsStyledPath(cwd) && cwd.includes('\\') ? '\\' : '/'
  const base = cwd.replace(/[/\\]+$/, '')
  const relative = path.replace(/^(?:\.?[/\\])+/, '')
  const joined = base + separator + relative
  return separator === '\\' ? joined.replaceAll('/', '\\') : joined.replaceAll('\\', '/')
}

/**
 * Strip the workspace root off an absolute path: the official
 * `relativizeToCwd` plus the separator normalization its own
 * `fileAddressFor` applies. Intentionally MORE TOLERANT than the official
 * helper, which compares the two strings in one spelling: newer hosts may
 * present paths absolutely, and old sessions may record the root in the other
 * separator spelling, so the prefix check runs on slash-normalized forms while
 * the slice keeps the original spelling of the remainder. Renamed here so no
 * reader mistakes this copy for the official export.
 * @param text - the authored path, absolute or already relative.
 * @param cwd - the Session's workspace root, when the host reported one.
 * @returns the remainder inside the root, or `text` when it is not rooted there.
 */
export function relativeToCwd(text: string, cwd: string | null | undefined) {
  if (cwd === null || cwd === undefined || cwd === '') return text
  const root = cwd.replace(/[/\\]+$/, '').replaceAll('\\', '/')
  const normalized = text.replaceAll('\\', '/')
  if (normalized.startsWith(root + '/')) return text.slice(root.length + 1)
  return text
}

/** The editor ids both probes confirmed, in the official catalog's order. */
export function editorIds(probes: AppProbes): EditorId[] {
  if (probes.info === null) return []
  const matched = (probes.officialApps ?? [])
    .filter((id): id is EditorId => (EDITOR_IDS as readonly string[]).includes(id))
  const { available } = probes.info
  if (available === null || available === undefined) return matched
  return matched.filter(id => available.includes(id))
}

/**
 * Build the rows for one file target.
 * @param probes - the two app probes' latest answers.
 * @param target - the clicked destination: its Session, its path as authored, and the line a fragment named.
 * @param deps - translator, workspace-root reader, icon metadata, and the two operations.
 * @returns the rows, in menu order.
 */
export function buildFileActions(
  probes: AppProbes,
  target: FileTarget,
  deps: FileMenuDeps,
): FileMenuAction[] {
  const { t } = deps
  const line = target.line ?? null
  const cwd = deps.cwdOf(target.sessionId)
  const absolute = resolveAgainstCwd(cwd, target.path)
  const rows: FileMenuAction[] = []
  // The heading is what makes the target visible before anything launches; the
  // line itself rides the launch request, not the copied path.
  if (line !== null) rows.push({ id: 'line', label: t('row.line', { line: String(line) }), disabled: true, separatorBefore: true })
  const editors: FileMenuAction[] = editorIds(probes).map(id => ({
    id: `app:${id}`,
    label: t(`app.${id}`),
    icon: deps.icon(id),
    failureLabel: t('error.openFailed'),
    run: () => deps.launch(id, absolute, line),
  }))
  editors.forEach((row, index) => {
    rows.push(index === 0 && line === null ? { ...row, separatorBefore: true } : row)
  })
  // Copying stays a pure path so a pasted path keeps working in a terminal, a
  // script, or another editor — the line rides the launch request only.
  rows.push({
    id: 'copy-rel',
    label: t('row.copyRelativePath'),
    failureLabel: t('error.copyFailed'),
    separatorBefore: true,
    run: () => deps.copy(relativeToCwd(target.path, cwd)),
  })
  return rows
}
