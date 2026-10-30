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
 * A Session still delegating to a running subagent does not count either: it is
 * idle while its descendants work, so the host marks it completion-unread the
 * moment the turn that started them ends. Suppressing it here, before the
 * previous-observation set is recorded, is what defers the announcement to the
 * moment the last descendant settles rather than dropping it.
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

/**
 * A child's running state is the status snapshot's answer, which the host
 * publishes per Agent; the row's own `running` is only a display fallback,
 * because a child is usually not a Host-list member.
 */
function isRunning(
  id: SessionId,
  list: SessionListState,
  status: SessionStatusSnapshot,
): boolean {
  return (status.get(id)?.running ?? list.byId[id]?.running) === true
}

/**
 * One fold's direct-child index: delegating parent → its `origin: 'subagent'`
 * row ids. Grouping once per snapshot is what keeps a finished Session's
 * descendant walk off a full `byId` scan at every step.
 */
function childIndex(byId: SessionListState['byId']): ReadonlyMap<SessionId, readonly SessionId[]> {
  const index = new Map<SessionId, SessionId[]>()
  for (const key of Object.keys(byId) as SessionId[]) {
    const row = byId[key]
    if (row === undefined || row.origin !== 'subagent' || row.parentId === undefined) continue
    const siblings = index.get(row.parentId) ?? []
    siblings.push(row.id)
    index.set(row.parentId, siblings)
  }
  return index
}

/**
 * Whether any descendant of `start` is still working.
 *
 * Direct children come from two sources, because either can lag: the Session's
 * own `subagentCatalog` projection (the fact the sidebar counts for "N subagents
 * running") and the indexed `byId` child rows, which already know a child whose
 * catalog projection has not arrived. The walk descends through a child that is
 * itself idle rather than stopping at it — an idle Session behind an idle middle
 * agent is still delegating, so only the last running descendant ends the wave.
 * `visited` is what keeps a forged `parentId` cycle from walking forever.
 */
function hasRunningDescendant(
  start: SessionId,
  list: SessionListState,
  status: SessionStatusSnapshot,
  children: ReadonlyMap<SessionId, readonly SessionId[]>,
): boolean {
  const visited = new Set<SessionId>([start])
  let frontier: SessionId[] = [start]
  while (frontier.length > 0) {
    const next: SessionId[] = []
    for (const node of frontier) {
      const catalog = list.projectionsBySession[node]?.values.subagentCatalog
      if (catalog !== undefined) {
        for (const entry of catalog) {
          if (visited.has(entry.id)) continue
          if (isRunning(entry.id, list, status)) return true
          visited.add(entry.id)
          next.push(entry.id)
        }
      }
      for (const child of children.get(node) ?? []) {
        if (visited.has(child)) continue
        if (isRunning(child, list, status)) return true
        visited.add(child)
        next.push(child)
      }
    }
    frontier = next
  }
  return false
}

export class CompletionObserver {
  private seen: ReadonlySet<SessionId> | undefined

  observe(
    status: SessionStatusSnapshot,
    list: SessionListState,
    archived: ReadonlySet<SessionId>,
  ): CompletionObservation {
    const children = childIndex(list.byId)
    const finished: SessionSummary[] = []
    for (const [id, entry] of status) {
      if (!entry.completionUnread) continue
      const row = list.byId[id]
      if (row === undefined || row.origin === 'subagent') continue
      if (hasRunningDescendant(id, list, status, children)) continue
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
