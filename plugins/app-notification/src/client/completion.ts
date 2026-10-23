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
 *
 * Archived Sessions never count either: the archive set is registry-global and
 * the sidebar files those rows away, so a Session the user put away is not work
 * waiting for a look. They are still folded into the previous-observation set,
 * because archiving does not clear `completionUnread` — restoring a Session must
 * not re-announce a completion the user was already told about.
 */
import type { SessionListState, SessionSummary } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionStatusSnapshot } from '@deepseek-ai/dsh-client-ui-session/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'

export interface CompletionObservation {
  /** Ordinary unarchived Sessions currently finished and not yet opened; subagent children never count. */
  readonly completed: readonly SessionSummary[]
  /** Sessions that became finished since the previous observation; empty on the first. */
  readonly newlyCompleted: readonly SessionSummary[]
}

export class CompletionObserver {
  private seen: ReadonlySet<SessionId> | undefined

  observe(
    status: SessionStatusSnapshot,
    list: SessionListState,
    archived: ReadonlySet<SessionId>,
  ): CompletionObservation {
    const finished: SessionSummary[] = []
    for (const [id, entry] of status) {
      if (!entry.completionUnread) continue
      const row = list.byId[id]
      if (row === undefined || row.origin === 'subagent') continue
      finished.push(row)
    }
    const previous = this.seen
    this.seen = new Set(finished.map(row => row.id))
    // Filtered after `seen` is recorded: an archived Session is still told
    // apart from a newly finished one, so unarchiving re-mounts its row without
    // announcing it a second time.
    const completed = finished.filter(row => !archived.has(row.id))
    return {
      completed,
      newlyCompleted: previous === undefined
        ? []
        : completed.filter(row => !previous.has(row.id)),
    }
  }
}
