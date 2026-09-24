/**
 * The plugin's notice state, held outside React.
 *
 * One notice is on screen at a time and a repeat replaces it, so `show` hands
 * out a fresh, monotonically increasing `seq`. The overlay entry keys the
 * shipped `Toast` by that number, which is what makes a second failure restart
 * the banner instead of extending the first one's hold. `dismiss` is guarded
 * by `seq` as well, so the fade of a notice that has already been replaced
 * cannot take its successor down with it.
 *
 * No DOM, no timers, no stylesheet: the shipped primitive owns the surface,
 * and this store owns only which notice is pending.
 */

/** One pending notice: its text and the sequence identifying this showing. */
export interface Notice {
  /** Per-show identity; the banner component's React key. */
  readonly seq: number
  /** Resolved banner copy, already translated by the caller. */
  readonly text: string
}

/** The notice surface the plugin body and the overlay entry share. */
export interface NoticeStore {
  /** Replace the pending notice and wake every subscriber. */
  show(text: string): void
  /** Drop the notice shown under `seq`; a stale sequence leaves the current one. */
  dismiss(seq: number): void
  /** Observe changes; the returned disposer removes exactly this listener. */
  subscribe(listener: () => void): () => void
  /** The pending notice, or null. A stable reference between changes. */
  snapshot(): Notice | null
}

/**
 * Create one notice store.
 * @returns the store: `show`/`dismiss` plus the `useSyncExternalStore` pair.
 */
export function createNoticeStore(): NoticeStore {
  let current: Notice | null = null
  let seq = 0
  const listeners = new Set<() => void>()
  /** Wake every subscriber; the store is read through `snapshot` during render. */
  const wake = (): void => { for (const listener of listeners) listener() }
  return {
    show(text) {
      seq += 1
      current = { seq, text }
      wake()
    },
    dismiss(shown) {
      if (current === null || current.seq !== shown) return
      current = null
      wake()
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    snapshot: () => current,
  }
}
