import type { SessionListState, SessionSummary } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'

/**
 * A listed Session the sidebar Session menu can archive.
 *
 * The blank check is repeated from the row-level rejection so this filter reads
 * completely on its own; `origin` and the archive set are only knowable here.
 */
function isVisibleSession(
  session: SessionSummary,
  archivedSessionIds: readonly SessionId[],
): boolean {
  return !session.blank
    && session.origin !== 'subagent'
    && !archivedSessionIds.includes(session.id)
}

/**
 * Whether the listed Session with this exact id is still archivable.
 *
 * The row element already yields the exact session id, so this is a membership
 * check rather than the title search it replaced: an id from the row's fiber is
 * unambiguous, so duplicate display titles no longer skip the gesture. It stays
 * because the row node carries no `origin` — whether a Session is
 * subagent-origin is only knowable from the authoritative list.
 * @param id - session id resolved from the hovered row.
 * @param list - current Session list snapshot.
 * @param archivedSessionIds - registry-global archive set.
 * @returns true when the Session exists and is a Visible Session.
 */
export function isArchivableSession(
  id: SessionId,
  list: SessionListState,
  archivedSessionIds: readonly SessionId[],
): boolean {
  const session = list.byId[id]
  return session !== undefined && isVisibleSession(session, archivedSessionIds)
}
