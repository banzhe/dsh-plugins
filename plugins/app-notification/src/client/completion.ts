/**
 * Finished-unread folding for the Session list. The mirror of the host
 * sidebar's completion reminder: a Session that stopped running while it was
 * not selected stays `completed` until the user looks at it, and each
 * observation reports the rows that reached that state since the previous one.
 *
 * The first observation is state-only: a page load (or a plugin reload) sees
 * whatever was already finished and must not announce it again as if it had
 * just happened.
 */
import type { SessionListState, SessionSummary } from '@deepseek-ai/dsh-api-session-controller/client'

/** One list observation: the current finished-unread set and what joined it. */
export interface CompletionObservation {
  /** Ordinary Sessions currently finished and not yet opened; subagent children never count. */
  readonly completed: readonly SessionSummary[]
  /** Sessions that became finished since the previous observation; empty on the first. */
  readonly newlyCompleted: readonly SessionSummary[]
}

/**
 * Whether one list row contributes to the finished-unread tally. Only ordinary
 * Sessions do: the sidebar's shared projection hides `origin: 'subagent'` rows
 * (a child reports through its parent's row and through its own header
 * catalog), and this count is that projection's number — counting children
 * would let one delegation fan-out inflate the icon past anything the sidebar
 * shows. The same filter governs the announcement stream, so a completion is
 * never announced by a surface that no longer counts it.
 * @param row - one Session list row.
 * @returns true when the row is finished, unread, and an ordinary Session.
 */
function finishedUnread(row: SessionSummary): boolean {
  return row.completed === true && row.origin !== 'subagent'
}

/** Stateful fold over successive Session list snapshots. */
export class CompletionObserver {
  /** Finished-unread ids from the previous observation; undefined before the first. */
  private seen: ReadonlySet<string> | undefined

  /**
   * Fold one list snapshot.
   * @param list - sessions list snapshot (rows plus the current selection).
   * @returns the finished-unread rows and those newly finished since the previous fold.
   */
  observe(list: SessionListState): CompletionObservation {
    const completed = list.ids
      .map(id => list.byId[id])
      .filter((row): row is SessionSummary => row !== undefined && finishedUnread(row))
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
