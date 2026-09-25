/**
 * Finished-unread folding over the Session status snapshot: the mirror of the
 * host sidebar's completion reminder, reported per Session.
 *
 * The first observation is state-only: a page load (or a plugin reload) sees
 * whatever was already finished and must not announce it again as if it had just
 * happened.
 *
 * The finished-unread fact lives on the status snapshot, not the list row:
 * `completionUnread` is the host's own answer, and the list row is only the
 * label that answer is reported under. Subagent children never count — the
 * sidebar hides `origin: 'subagent'` rows, and counting them would let one
 * delegation fan-out inflate the icon past anything the sidebar shows.
 */
import type { SessionListState, SessionSummary } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionStatusSnapshot } from '@deepseek-ai/dsh-client-ui-session/client'

/** One observation: the current finished-unread set and what joined it. */
export interface CompletionObservation {
  /** Ordinary Sessions currently finished and not yet opened; subagent children never count. */
  readonly completed: readonly SessionSummary[]
  /** Sessions that became finished since the previous observation; empty on the first. */
  readonly newlyCompleted: readonly SessionSummary[]
}

/** Stateful fold over successive Session status snapshots. */
export class CompletionObserver {
  /** Finished-unread ids from the previous observation; undefined before the first. */
  private seen: ReadonlySet<string> | undefined

  /**
   * Fold one status snapshot against the current list rows. The snapshot
   * supplies the finished-unread facts; the list supplies the rows they name.
   */
  observe(status: SessionStatusSnapshot, list: SessionListState): CompletionObservation {
    const completed: SessionSummary[] = []
    for (const [id, entry] of status) {
      if (!entry.completionUnread) continue
      const row = list.byId[id]
      if (row === undefined || row.origin === 'subagent') continue
      completed.push(row)
    }
    const previous = this.seen
    this.seen = new Set(completed.map(row => row.id))
    return {
      completed,
      newlyCompleted: previous === undefined
        ? []
        : completed.filter(row => !previous.has(row.id)),
    }
  }
}
