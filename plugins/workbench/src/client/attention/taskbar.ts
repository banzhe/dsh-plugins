/**
 * Windows taskbar pulse for unattended running work: the shell's indeterminate
 * progress bar, only while listed Sessions are running and nothing is waiting or
 * finished-unread.
 *
 * The channel is optional. A browser, or a shell whose whitelist predates
 * `window.setProgressBar`, has no write at all; the presenter never throws.
 */
import type { AttentionModel, AttentionRow } from './model.ts'

/**
 * The Desktop shell's window bridge, as the Web UI sees it. `dshDesktop` is the
 * shell's fixed preload whitelist: a page loaded in a browser has none, and a
 * shell predating the progress channel has `window` without `setProgressBar`.
 */
interface DesktopWindowBridge {
  readonly dshDesktop?: {
    readonly window?: {
      readonly setProgressBar?: (progress: number) => Promise<void>
    }
  }
}

/** Progress value Electron treats as the Windows indeterminate pulse. */
const PULSE = 2
/** Progress value that removes the taskbar indicator. */
const CLEAR = -1

/**
 * Read the shell's taskbar-progress write, or undefined when this page cannot use
 * it. Absence is the version probe, so the plugin never compares protocol
 * versions; the caller swallows the rejection a refused IPC produces.
 * @returns the bridge's write, or undefined when this page has none.
 */
function desktopWindowProgress(): ((progress: number) => Promise<void>) | undefined {
  const setProgressBar = (globalThis as DesktopWindowBridge).dshDesktop?.window?.setProgressBar
  return typeof setProgressBar === 'function' ? setProgressBar : undefined
}

/**
 * Whether one listed Session finished while nobody looked: the reminder the pulse
 * must not talk over. A run in flight is not one, even with the flag still set on
 * it — the flag is cleared by opening the Session, not by a new turn.
 * @param row - one listed Session.
 * @returns true when the row reports finished and nothing about it is live.
 */
function finishedUnreadAtRest(row: AttentionRow): boolean {
  return row.completed && !isLive(row)
}

/**
 * Whether a listed Session has work in flight: its own run, or the subagent work
 * delegated below it.
 * @param row - one listed Session.
 * @returns true while the Session carries running work.
 */
function isLive(row: AttentionRow): boolean {
  return row.running || row.runningSubagentCount > 0
}

/**
 * Whether the current content earns the taskbar pulse: work is in flight, and
 * nothing is blocked on the user or finished-unread. Placement never decides this:
 * a pinned Session at rest is in view because the user asked, so it is not a new
 * notification and never pulses on its own, while a pinned Session that runs or
 * finished unread counts exactly like an unpinned one.
 * @param model - the current In work content.
 * @returns true when the Windows progress bar should run indeterminate.
 */
export function shouldPulseTaskbar(model: AttentionModel): boolean {
  const listed = [...model.unread, ...model.pinned, ...model.running]
  if (!listed.some(isLive)) return false
  if (model.waiting.length > 0) return false
  return !listed.some(finishedUnreadAtRest)
}

/**
 * One write per pulse/clear transition. A repeated state is a no-op, so an
 * unrelated list update does not re-issue the same platform call.
 */
export class TaskbarProgressPresenter {
  private readonly write: ((progress: number) => Promise<void>) | undefined
  private pulsing: boolean | undefined

  constructor() {
    this.write = desktopWindowProgress()
  }

  /** The page can reach the shell's taskbar-progress write. */
  get viable(): boolean {
    return this.write !== undefined
  }

  /**
   * Project one model onto the taskbar, writing only when the state changes.
   * @param model - the current In work content.
   */
  project(model: AttentionModel): void {
    const next = shouldPulseTaskbar(model)
    if (this.pulsing === next) return
    this.pulsing = next
    this.apply(next ? PULSE : CLEAR)
  }

  /** Retract the pulse so a disposed plugin leaves no stale indicator. */
  clear(): void {
    const wasPulsing = this.pulsing === true
    this.pulsing = undefined
    if (wasPulsing) this.apply(CLEAR)
  }

  private apply(progress: number): void {
    const write = this.write
    if (write === undefined) return
    void write(progress).catch((error: unknown) => {
      console.warn('ui-workspace: the shell refused the taskbar progress', error)
    })
  }
}
