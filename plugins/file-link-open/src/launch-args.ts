/**
 * @banzhe/dsh-file-link-open — The argv this plugin adds to an official launch.
 *
 * The official resolver supplies the file path itself: it substitutes it into a
 * `{path}` argument, or appends it when the argv carries none. Two edits ride on
 * top of that, neither of which the official resolver has a notion of:
 *
 * - **Reveal a line.** A markdown link may name one (`src/a.ts#L24`); the
 *   editor's own line-selection spelling takes the place of the bare path.
 * - **Reuse the window that is already open.** The catalog launches VS Code and
 *   its forks with no window flag, and their CLI default is a new window; each
 *   editor's own switch forces the already-running one.
 *
 * Only launchers whose argv this plugin may extend are eligible:
 *
 * - `shell-open` (the file managers) takes a directory, not a file.
 * - macOS editors resolve to `open -a <bundle>`; appending `:24` to a path names
 *   no file, and macOS already routes the document to the running app, so those
 *   keep opening at the top of the file.
 * - An argv that already carries `{path}` positions the path for a directory
 *   (a terminal's `--working-directory`), which is not a file link's use case.
 *
 * Verified CLI spellings: VS Code's `--goto <file>:<line>` and
 * `--reuse-window`, Zed's `--existing`, and the IntelliJ platform's
 * `--line <n> <path>`. Products with no documented flag (Android Studio's
 * `studio64.exe`, Windsurf) are simply absent from a table and keep that
 * default.
 */

import type { EditorId } from './editors.ts'

/** Builds one editor's line-selection argv; the result MUST carry `pathToken`. */
type LineArgBuilder = (line: number, pathToken: string) => readonly string[]

/** Electron editors sharing the VS Code CLI: `--goto <file>:<line>`. */
const GOTO: LineArgBuilder = (line, pathToken) => ['--goto', `${pathToken}:${line}`]

/** Editors taking the `<file>:<line>` positional form with no flag. */
const POSITIONAL: LineArgBuilder = (line, pathToken) => [`${pathToken}:${line}`]

/** IntelliJ-platform products sharing `--line <n> <path>`. */
const JETBRAINS: LineArgBuilder = (line, pathToken) => ['--line', String(line), pathToken]

/**
 * Editors whose line-selection CLI this plugin knows, by official catalog id.
 * Total over `EditorId`: adding an editor to the whitelist fails to compile
 * until its line form is decided here, so no editor silently opens at the top.
 */
const LINE_TEMPLATES: Readonly<Record<EditorId, LineArgBuilder | undefined>> = {
  vscode: GOTO,
  vscodeinsiders: GOTO,
  cursor: GOTO,
  windsurf: GOTO,
  zed: POSITIONAL,
  sublimetext: POSITIONAL,
  intellij: JETBRAINS,
  pycharm: JETBRAINS,
  webstorm: JETBRAINS,
  phpstorm: JETBRAINS,
  goland: JETBRAINS,
  rider: JETBRAINS,
  rustrover: JETBRAINS,
  // Its launcher documents no line flag, so it opens at the top of the file.
  androidstudio: undefined,
}

/**
 * Editors that need a switch to open into their already-running window, by
 * official catalog id. An id mapping to `undefined` either reuses that window by
 * default (the JetBrains launchers, `subl`) or documents no such switch, so
 * nothing is appended and the editor's own default stands.
 */
const WINDOW_REUSE: Readonly<Record<EditorId, readonly string[] | undefined>> = {
  vscode: ['--reuse-window'],
  vscodeinsiders: ['--reuse-window'],
  cursor: ['--reuse-window'],
  // Zed's own `-r/--reuse` REPLACES the window's workspace; `--existing` is the
  // switch that adds the file to the window that is already open.
  zed: ['--existing'],
  // `subl` adds to the last active window by default.
  sublimetext: undefined,
  // The JetBrains launchers hand the file to the running IDE by default.
  intellij: undefined,
  pycharm: undefined,
  webstorm: undefined,
  phpstorm: undefined,
  goland: undefined,
  rider: undefined,
  rustrover: undefined,
  // No documented window switch; opens a window as before.
  androidstudio: undefined,
  windsurf: undefined,
}

/**
 * The macOS `open` shim: `open -a <bundle>` takes the path as an appended
 * argument, which is not where the editor's own options belong.
 */
const MACOS_OPEN_COMMAND = 'open'

/** One resolved launcher, as much of it as arg rewriting reads. */
export interface LaunchShape {
  /** The official closed launcher union: an argv spawn, or the OS shell's open verb. */
  readonly kind: 'argv' | 'shell-open'
  /** Absent on `shell-open` launches, which carry no argv at all. */
  readonly command?: string | undefined
  /** Absent on `shell-open` launches. */
  readonly args?: readonly string[] | undefined
}

/** An `argv` launcher that carries its own command and arguments. */
export interface ArgvLaunchShape extends LaunchShape {
  readonly kind: 'argv'
  readonly command: string
  readonly args: readonly string[]
}

/** One resolution's fields, as much of them as arg rewriting reads and keeps. */
export interface ResolvedLaunch {
  readonly launch: LaunchShape
  readonly fallbackLaunch?: LaunchShape | undefined
  readonly icon?: unknown
}

/**
 * Whether one resolved launcher's argv is this plugin's to extend.
 * @param launch - The resolution's primary launcher.
 * @param pathToken - The catalog's `{path}` placeholder.
 * @returns True (narrowing to an argv launcher) when the launcher leaves the
 *   path to the official resolver, so extra arguments can be appended safely.
 */
export function supportsLaunchArgs(launch: LaunchShape, pathToken: string): launch is ArgvLaunchShape {
  if (launch.kind !== 'argv') return false
  if (launch.command === MACOS_OPEN_COMMAND) return false
  const { args } = launch
  if (args === undefined) return false
  return !args.some(arg => arg.includes(pathToken))
}

/**
 * This editor's line-selection argv, or undefined when it has none.
 * @param appId - Official catalog id.
 * @param line - 1-based line to reveal.
 * @param pathToken - The catalog's `{path}` placeholder.
 * @returns The argv to launch instead of the catalog's, or undefined to open at
 *   the top of the file.
 */
export function lineArgsFor(appId: string, line: number, pathToken: string): readonly string[] | undefined {
  // `hasOwn` keeps an id like `toString` from reaching a prototype member.
  return Object.hasOwn(LINE_TEMPLATES, appId)
    ? LINE_TEMPLATES[appId as EditorId]?.(line, pathToken)
    : undefined
}

/**
 * This editor's window-reuse argv, or undefined when it needs none.
 * @param appId - Official catalog id.
 * @returns The arguments that force the editor's already-running window, or
 *   undefined to leave the editor's own default (usually a new window).
 */
export function reuseArgsFor(appId: string): readonly string[] | undefined {
  return Object.hasOwn(WINDOW_REUSE, appId) ? WINDOW_REUSE[appId as EditorId] : undefined
}

/**
 * Rewrite one resolved launcher with this plugin's own launch arguments.
 * @param resolved - The resolution for the requested app.
 * @param appId - Official catalog id.
 * @param line - 1-based line, or undefined when the link named none.
 * @param pathToken - The catalog's `{path}` placeholder.
 * @returns A resolution carrying the window-reuse switch and, when the link
 *   named one, the line-selection argv — or `resolved` unchanged when this
 *   launcher's argv is not this plugin's to extend (macOS bundle launches, file
 *   managers) or the editor needs neither argument. `fallbackLaunch` is left
 *   as-is: a fallback only runs after the primary failed, and opening without
 *   the extra arguments beats not opening at all.
 */
export function withLaunchArgs(
  resolved: ResolvedLaunch, appId: string, line: number | undefined, pathToken: string,
): ResolvedLaunch {
  const { launch } = resolved
  if (!supportsLaunchArgs(launch, pathToken)) return resolved
  const lineArgs = line === undefined ? undefined : lineArgsFor(appId, line, pathToken)
  // The catalog's own flags first, then the window-reuse switch, then the
  // line-bearing argv that stands in for the path the official launcher would
  // otherwise have appended alone.
  const added = [...reuseArgsFor(appId) ?? [], ...lineArgs ?? []]
  if (added.length === 0) return resolved
  return { ...resolved, launch: { ...launch, args: [...launch.args, ...added] } }
}
