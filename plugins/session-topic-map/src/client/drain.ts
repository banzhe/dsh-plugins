/**
 * The panel's realtime loop: keep one Session's graph moving while it is watched.
 *
 * A step is one analysis run. While a run keeps finding messages the loop runs
 * again immediately, so a backlog drains in consecutive batches instead of one
 * batch per tick; when a run finds nothing it waits one interval, because the
 * only thing left to do is look again later. Nothing here decides whether a
 * model may be called — that is the Host's confirmation gate — and a run that
 * finds no message never asks a model in the first place.
 *
 * A failed run ends the loop instead of retrying quietly: the panel shows the
 * failure with a retry control, which is a fresh confirmation because only a
 * click can issue one. Cancellation is the other way out — switching Session,
 * pausing, and unmounting all abort the signal, and after an abort neither
 * callback fires again. The loop is sequential by construction — one analyze
 * call is awaited before the next — so two runs can never overlap.
 *
 * @module @banzhe/dsh-session-topic-map/src/client/drain
 */

/** Wait between two looks when the Session had nothing new. */
export const DRAIN_INTERVAL_MS = 2_000

/** What one run covered; `messages` is 0 when it found nothing to analyze. */
export interface DrainStep {
  /** Messages the run fed to the model. */
  readonly messages: number
  /** Topic contributions the run produced. */
  readonly topics: number
}

/** Everything the loop needs from its owner. */
export interface DrainDeps {
  /** Run one analysis. Rejects when the run failed. */
  readonly analyze: (signal: AbortSignal) => Promise<DrainStep>
  /** Sleep, resolving early when the signal aborts. */
  readonly wait: (ms: number, signal: AbortSignal) => Promise<void>
  /** Called after every successful run. */
  readonly onStep: (step: DrainStep) => void
  /** Called once after a failed run, ending the loop. */
  readonly onFailure: (message: string | null) => void
}

/**
 * Sleep for one interval, waking on abort.
 * @param ms - milliseconds to wait.
 * @param signal - cancellation.
 * @returns a promise that resolves on timeout or abort and never rejects.
 */
export function waitFor(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve()
  return new Promise<void>((resolve) => {
    const timer = setTimeout(finish, ms)
    function finish(): void {
      clearTimeout(timer)
      signal.removeEventListener('abort', finish)
      resolve()
    }
    signal.addEventListener('abort', finish, { once: true })
  })
}

/**
 * Run the loop until the signal aborts.
 * @param deps - the run, the sleep, and the two observers.
 * @param signal - cancellation; aborting is how the loop ends.
 */
export async function runDrain(deps: DrainDeps, signal: AbortSignal): Promise<void> {
  // A function call, not a property read: the signal can abort across an await,
  // and a direct read would be narrowed to the value it had before that await.
  const aborted = (): boolean => signal.aborted
  while (!aborted()) {
    let step: DrainStep
    try {
      step = await deps.analyze(signal)
    }
    catch (error) {
      if (aborted()) return
      // One failure ends the loop: the panel reports it and waits for the user's
      // retry, so a broken provider cannot spin silently under a running label.
      deps.onFailure(error instanceof Error ? error.message : null)
      return
    }
    if (aborted()) return
    deps.onStep(step)
    if (step.messages === 0) await deps.wait(DRAIN_INTERVAL_MS, signal)
  }
}