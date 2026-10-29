/**
 * Windows taskbar pulse for unattended running work: the shell's
 * indeterminate progress bar, only while listed Sessions are running and
 * nothing is waiting or finished-unread.
 *
 * The channel is optional. A browser, or a shell whose whitelist predates
 * `window.setProgressBar`, has no write at all; the presenter never throws.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { AttentionModel } from './attention.ts'

/**
 * The Desktop shell's window bridge, as the Web UI sees it. `dshDesktop` is
 * the shell's fixed preload whitelist: a page loaded in a browser has none,
 * and a shell predating the progress channel has `window` without
 * `setProgressBar`.
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
 * Read the shell's taskbar-progress write, or undefined when this page cannot
 * use it. Absence is the version probe, so the plugin never compares protocol
 * versions; the caller swallows the rejection a refused IPC produces.
 */
function desktopWindowProgress(): ((progress: number) => Promise<void>) | undefined {
  const setProgressBar = (globalThis as DesktopWindowBridge).dshDesktop?.window?.setProgressBar
  return typeof setProgressBar === 'function' ? setProgressBar : undefined
}

/**
 * Whether the current content earns the taskbar pulse: work is in flight, and
 * nothing is blocked on the user or finished-unread. Stricter than the
 * toggle's `running` outline, which still sweeps when an unread row sits
 * beside a run.
 */
export function shouldPulseTaskbar(model: AttentionModel): boolean {
  return model.waiting.length === 0 && model.running.length > 0 && model.unread.length === 0
}

/**
 * One write per pulse/clear transition. A repeated state is a no-op, so an
 * unrelated list update does not re-issue the same platform call.
 */
export class TaskbarProgressPresenter {
  private readonly write: ((progress: number) => Promise<void>) | undefined
  private pulsing: boolean | undefined

  constructor(private readonly logger: Context['logger']) {
    this.write = desktopWindowProgress()
  }

  /** The page can reach the shell's taskbar-progress write. */
  get viable(): boolean {
    return this.write !== undefined
  }

  project(model: AttentionModel): void {
    const next = shouldPulseTaskbar(model)
    if (this.pulsing === next) return
    this.pulsing = next
    this.apply(next ? PULSE : CLEAR)
  }

  /** Retract the pulse so a disposed plugin leaves no stale indicator. */
  clear(): void {
    if (this.pulsing !== true) {
      this.pulsing = undefined
      return
    }
    this.pulsing = undefined
    this.apply(CLEAR)
  }

  private apply(progress: number): void {
    const write = this.write
    if (write === undefined) return
    void write(progress).catch((error: unknown) => {
      this.logger.warn('session-attention: the shell refused the taskbar progress', error)
    })
  }
}
