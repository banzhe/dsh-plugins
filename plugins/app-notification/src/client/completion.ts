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
 * A Session that delegated to a subagent does not count at either of the two
 * moments the host marks it completion-unread: it is idle while its descendants
 * work, so the turn that started them ends unread, and the settlement of the
 * last descendant unreads it again. Neither is a completion the user should be
 * told about. The settlement only hands the reports back — the parent is then
 * woken to read them and answer, which is a turn of its own, and that turn's end
 * is the completion the notification is about. So a delegating Session is
 * announced only once its own turn has been observed running after the wave
 * settled *and* has stopped again since.
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

  /**
   * Sessions that delegated to a descendant and therefore still owe a turn of
   * their own before their finish may be announced: the wave that ends only
   * hands the reports back, and the parent answers afterwards.
   */
  private readonly awaitingParentCompletion = new Set<SessionId>()

  /**
   * The subset of {@link awaitingParentCompletion} whose own turn was seen
   * running once its last descendant had settled — the wake-up happened. The
   * next stop is the completion worth a notification; without this bookmark a
   * stop is still the parent waiting to be woken.
   */
  private readonly parentTurnObserved = new Set<SessionId>()

  observe(
    status: SessionStatusSnapshot,
    list: SessionListState,
    archived: ReadonlySet<SessionId>,
  ): CompletionObservation {
    const children = childIndex(list.byId)
    const finished: SessionSummary[] = []
    // Every listed Session is folded, not just the completion-unread ones:
    // starting a turn clears the host's unread flag, so the wake-up this fold
    // has to see is exactly the observation an unread-only walk would skip.
    for (const id of list.ids) {
      const row = list.byId[id]
      if (row === undefined || row.origin === 'subagent') continue
      if (!this.settled(id, status, list, children)) continue
      if (status.get(id)?.completionUnread !== true) continue
      finished.push(row)
    }
    this.prune(status, list, archived)
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

  /**
   * Whether `id` has reached a completion worth counting on this observation,
   * advancing the delegation bookmarks on the way.
   *
   * A Session with any running descendant is delegating: it owes a turn of its
   * own, and a turn observed for an earlier wave no longer counts, because the
   * parent ends that turn unread the moment it dispatches again.
   *
   * Once the wave has settled, the parent's own state is the only thing left to
   * read. Running: the settlement woke it up and it is working on the answer, so
   * the handover is under way and nothing may be announced yet. Not running: only
   * a Session whose wake-up was observed earlier has finished that turn — without
   * that observation the last descendant only just stopped, and the notification
   * would arrive before the parent has said anything.
   */
  private settled(
    id: SessionId,
    status: SessionStatusSnapshot,
    list: SessionListState,
    children: ReadonlyMap<SessionId, readonly SessionId[]>,
  ): boolean {
    if (hasRunningDescendant(id, list, status, children)) {
      this.awaitingParentCompletion.add(id)
      this.parentTurnObserved.delete(id)
      return false
    }
    if (!this.awaitingParentCompletion.has(id)) return !isRunning(id, list, status)
    if (isRunning(id, list, status)) {
      this.parentTurnObserved.add(id)
      return false
    }
    if (!this.parentTurnObserved.has(id)) return false
    this.awaitingParentCompletion.delete(id)
    this.parentTurnObserved.delete(id)
    return true
  }

  /**
   * Drop bookmarks for a Session the controller no longer publishes anywhere, or
   * that the user filed away: neither can still be woken or settled, and holding
   * them would only grow the sets.
   */
  private prune(
    status: SessionStatusSnapshot,
    list: SessionListState,
    archived: ReadonlySet<SessionId>,
  ): void {
    for (const id of this.awaitingParentCompletion) {
      if (!archived.has(id) && (status.has(id) || list.byId[id] !== undefined)) continue
      this.awaitingParentCompletion.delete(id)
      this.parentTurnObserved.delete(id)
    }
  }
}
