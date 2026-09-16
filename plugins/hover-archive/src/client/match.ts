import type { SessionListState, SessionSummary } from '@deepseek-ai/dsh-api-session-controller/client'

/**
 * A listed Session the sidebar Session menu can archive.
 * DSH's tree also keeps the current blank New Session row visible; that row
 * has no ⋯ menu, so it is never a hover-archive target.
 */
function isVisibleSession(
  session: SessionSummary,
  archivedSessionIds: readonly SessionSummary['id'][],
): boolean {
  return !session.blank
    && session.origin !== 'subagent'
    && !archivedSessionIds.includes(session.id)
}

/**
 * The unique visible Session whose display title matches, or undefined when
 * none or more than one visible Session shares that title.
 */
export function uniqueVisibleSessionId(
  title: string,
  list: SessionListState,
  archivedSessionIds: readonly SessionSummary['id'][],
): SessionSummary['id'] | undefined {
  let found: SessionSummary['id'] | undefined
  for (const id of list.ids) {
    const session = list.byId[id]
    if (session === undefined || session.displayTitle !== title) continue
    if (!isVisibleSession(session, archivedSessionIds)) continue
    if (found !== undefined) return undefined
    found = session.id
  }
  return found
}
