/**
 * The In work model: Sessions that need a look — running work, finished-unread
 * work, and everything the user pinned — folded from state other plugins own. No
 * state is persisted and nothing is refreshed here — the Session-list snapshot,
 * the Session-status snapshot, and the Workspace owner's pin and archive sets are
 * the whole input.
 *
 * Three quick groups, one row per Session, each row carrying the browsing list's
 * own row facts so a Session draws the same dot here as it does in the tree:
 * - `running` holds every Session that runs itself or has running subagent work
 *   below it, pinned or not.
 * - `unread` holds every Session finished while unread, pinned or not.
 * - `pinned` holds the pinned Sessions left once neither of those applies, so a
 *   pin at rest stays in view because the user asked for it.
 *
 * The state leads and the pin follows it: live work outranks the finish reminder,
 * which outranks the pin. A pinned Session lists under `running` while it works,
 * moves to `unread` when it finishes unread, and returns to `pinned` once both are
 * cleared. Every listed Session appears in exactly one group. `waiting` names the
 * listed Sessions blocked on the user, in the groups' display order.
 *
 * Delegated work keeps its Session in `running` across the gap where the Session
 * itself is already idle. A Session that hands work to subagents stops its own
 * turn as soon as the delegation is accepted, so its own `running` goes false
 * while the subagents still run; when they stop, its finish is unread but the
 * wake-up that reports them has not arrived yet. That one frame would file the
 * row under `unread` and the very next would take it back to `running`. The fold
 * therefore carries a handoff: an idle Session whose subagents just stopped with
 * its finish still unread stays in `running` until it runs again or its finish is
 * read. A Session with no running subagent work below it is unaffected.
 *
 * A subagent Session gets no row here, at any depth: the Session that delegated
 * the work carries it as its own run, so one delegation adds no row and no
 * nesting. Rows that never list at all: subagent Sessions (their durable
 * `origin`), the blank New-Session placeholder, and archived Sessions.
 */
import type { SessionListState } from '@deepseek-ai/dsh-api-session-controller/client'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { SessionStatusSnapshot } from '@deepseek-ai/dsh-client-ui-session/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { runningDescendantCounts, sessionNode, type SessionNode } from '../tree.ts'

/**
 * One listed Session: the browsing list's own row facts, unchanged. Nothing in
 * the row says which group lists it — a group is a view, not a state.
 */
export type AttentionRow = SessionNode

/** Everything the region renders: three independent groups plus the blocked set. */
export interface AttentionModel {
  /** Finished-unread Sessions, pinned or not; pinned rows lead, then newest first. */
  readonly unread: readonly AttentionRow[]
  /** Pinned Sessions at rest, with no live work and no finish reminder; newest first. */
  readonly pinned: readonly AttentionRow[]
  /** Sessions running themselves or over running subagent work, pinned or not; pinned rows lead, then newest first. */
  readonly running: readonly AttentionRow[]
  /** Listed Sessions whose work is blocked on the user, in display order. */
  readonly waiting: readonly AttentionRow[]
}

/** Session list source (`ctx.sessions.list`). */
export type AttentionListSource = ObservableSnapshot<SessionListState>
/** Session status source (`ctx.uiSession.sessionStatus`). */
export type AttentionStatusSource = ObservableSnapshot<SessionStatusSnapshot>
/** One of the Workspace owner's derived registry sets (pinned or archived). */
export type AttentionSetSource = ObservableSnapshot<ReadonlySet<SessionId>>

interface Candidate {
  readonly updatedAt: number
  readonly row: AttentionRow
}

/** Newest first; the sort is stable, so equal timestamps keep Host list order. */
function byRecency(left: Candidate, right: Candidate): number {
  return right.updatedAt - left.updatedAt
}

/**
 * A state group's order: pinned rows lead, and each side stays newest first. The
 * sort is stable, so equal timestamps keep Host list order.
 */
function byPinnedThenRecency(left: Candidate, right: Candidate): number {
  if (left.row.pinned !== right.row.pinned) return left.row.pinned ? -1 : 1
  return byRecency(left, right)
}

/** No handed-off and no delegated Session: the memory a single stateless fold reads. */
const NO_SESSIONS: ReadonlySet<SessionId> = new Set()

/**
 * What one fold must remember for the next one. Both sets are keyed by Session and
 * rebuilt on every fold from the listed Sessions, so a Session that leaves the list
 * (archived, deleted) takes its entry with it.
 */
interface HandoffMemory {
  /** Sessions seen with running subagent work below them: the next fold compares against this. */
  readonly delegated: ReadonlySet<SessionId>
  /** Idle Sessions whose subagents just stopped with the finish still unread: grouped as running. */
  readonly handedOff: ReadonlySet<SessionId>
}

/** One fold's product: the model to render plus the memory the next fold needs. */
interface AttentionFold {
  readonly model: AttentionModel
  readonly memory: HandoffMemory
}

/**
 * Fold one list snapshot, one status snapshot, and the archive and pin sets into
 * the region's content, carrying the handoff memory of the fold before it.
 * @param list - Session list snapshot, in Host list order.
 * @param status - per-Session status map.
 * @param archived - archived Session ids, which never list.
 * @param pinned - pinned Session ids, which place a row only while it has nothing else to report.
 * @param memory - the delegated and handed-off Sessions the previous fold recorded.
 * @returns the model the region renders and the memory this fold leaves behind.
 */
function foldAttention(
  list: SessionListState,
  status: SessionStatusSnapshot,
  archived: ReadonlySet<SessionId>,
  pinned: ReadonlySet<SessionId>,
  memory: HandoffMemory,
): AttentionFold {
  const unread: Candidate[] = []
  const pinnedRows: Candidate[] = []
  const running: Candidate[] = []
  const blocked = new Set<SessionId>()
  const delegated = new Set<SessionId>()
  const handedOff = new Set<SessionId>()
  const descendants = runningDescendantCounts(list, status)
  list.ids.forEach((id) => {
    const row = list.byId[id]
    // An id may be listed before the Host projects its row (nothing to label).
    if (row === undefined) return
    if (row.origin === 'subagent' || row.blank || archived.has(id)) return
    // The status map is read once, here: the row's own state (not its group)
    // decides the dot, and pending interaction rides the same entry.
    const entry = status.get(id)
    if (entry?.pendingInteraction !== undefined) blocked.add(id)
    const node = sessionNode(row, status, descendants, pinned, archived)
    const candidate: Candidate = { updatedAt: row.updatedAt, row: node }
    // A delegation outlives the turn that started it. The Session's own run ends
    // when the delegation is accepted, so an idle Session whose subagents just
    // stopped is not news yet: the finish is unread but the wake-up that reports
    // them is in flight. That row is handed off as running for this fold; running
    // again, or a read finish, ends the handoff.
    const subagents = node.runningSubagentCount
    const stopped = subagents === 0 && memory.delegated.has(id)
    const handed = (stopped || memory.handedOff.has(id)) && !node.running && node.completed
    if (handed) handedOff.add(id)
    if (subagents > 0) delegated.add(id)
    // The work state outranks the pin for placement only; the row keeps its
    // running, completion and blocked facts for the dot it draws. Subagent work
    // belongs to the Session that delegated it: that row spins, and the children
    // never contribute rows of their own.
    if (node.running || subagents > 0 || handed) {
      running.push(candidate)
      return
    }
    // A finish nobody has looked at is news too, so a pinned Session that just
    // finished unread reports itself before the pin files it away.
    if (node.completed) {
      unread.push(candidate)
      return
    }
    // With nothing live and nothing unread, the pin is what keeps a row in view; an
    // unpinned Session at rest stays in the tree below and takes no row here.
    if (node.pinned) pinnedRows.push(candidate)
  })
  const unreadRows = unread.sort(byPinnedThenRecency).map(candidate => candidate.row)
  const pinnedRowsSorted = pinnedRows.sort(byRecency).map(candidate => candidate.row)
  const runningRows = running.sort(byPinnedThenRecency).map(candidate => candidate.row)
  return {
    model: {
      unread: unreadRows,
      pinned: pinnedRowsSorted,
      running: runningRows,
      waiting: [...unreadRows, ...pinnedRowsSorted, ...runningRows].filter(row => blocked.has(row.id)),
    },
    memory: { delegated, handedOff },
  }
}

/**
 * Fold one list snapshot, one status snapshot, and the archive and pin sets into
 * the region's content, with no delegation handoff behind it: the pure projection
 * of those four inputs.
 * @param list - Session list snapshot, in Host list order.
 * @param status - per-Session status map.
 * @param archived - archived Session ids, which never list.
 * @param pinned - pinned Session ids, which place a row only while it has nothing else to report.
 * @returns the model the region renders.
 */
export function deriveAttention(
  list: SessionListState,
  status: SessionStatusSnapshot,
  archived: ReadonlySet<SessionId>,
  pinned: ReadonlySet<SessionId>,
): AttentionModel {
  return foldAttention(list, status, archived, pinned, { delegated: NO_SESSIONS, handedOff: NO_SESSIONS }).model
}

/**
 * One row's comparable identity: everything the row renders. Two models with equal
 * keys draw the same pixels, which is what lets the store publish a fold only when
 * something visible changed.
 */
function rowKey(row: AttentionRow): string {
  return [
    row.id,
    row.title,
    row.blank ? 'b' : '',
    row.running ? 'r' : '',
    String(row.runningSubagentCount),
    row.completed ? 'c' : '',
    row.pinned ? 'p' : '',
    row.archived ? 'a' : '',
    row.pendingInteraction ?? '',
    String(row.updatedAt),
    row.cwd ?? '',
  ].join('\u0002')
}

function rowsKey(rows: readonly AttentionRow[]): string {
  return rows.map(rowKey).join('\u0001')
}

/** Whether two models would render identically. */
function sameModel(left: AttentionModel, right: AttentionModel): boolean {
  return rowsKey(left.unread) === rowsKey(right.unread)
    && rowsKey(left.pinned) === rowsKey(right.pinned)
    && rowsKey(left.running) === rowsKey(right.running)
    // The blocked marker rides this one, so a pending interaction that appears or
    // clears while the groups stand still is a change, not a no-op.
    && rowsKey(left.waiting) === rowsKey(right.waiting)
}

/** Read-only view of the current model, plus the plugin's disposer. */
export interface AttentionStore extends ObservableSnapshot<AttentionModel> {
  /** Detach from all four sources and drop every listener. */
  dispose(): void
}

/**
 * Keep the model in step with the four sources it folds: the Session list, the
 * Session status map, and the Workspace owner's pinned and archived sets. The
 * sets are sources in their own right because neither pinning nor archiving moves
 * the list or the status, so a row the user just filed away or just pinned would
 * otherwise stay as it was.
 *
 * Two folds that would render identically are not published, so a status tick
 * that only touches an unrelated Session costs no render. The caller owns the
 * lifetime through {@link AttentionStore.dispose}.
 * @param list -
 * @param status -
 * @param pinned -
 * @param archived -
 * @returns the model source and its disposer.
 */
export function createAttentionStore(
  list: AttentionListSource,
  status: AttentionStatusSource,
  pinned: AttentionSetSource,
  archived: AttentionSetSource,
): AttentionStore {
  const listeners = new Set<() => void>()
  let memory: HandoffMemory = { delegated: NO_SESSIONS, handedOff: NO_SESSIONS }
  /**
   * One fold over the current snapshots. The memory always advances, even when the
   * model does not: a delegation stop that redraws nothing this frame is still the
   * fact the next frame reads.
   */
  const fold = (): AttentionModel => {
    const next = foldAttention(list.getSnapshot(), status.getSnapshot(), archived.getSnapshot(), pinned.getSnapshot(), memory)
    memory = next.memory
    return next.model
  }
  let model = fold()
  const recompute = (): void => {
    const next = fold()
    if (sameModel(next, model)) return
    model = next
    // forEach skips a listener removed earlier in the same pass and does not
    // visit one added during it, which is exactly the containment a plain
    // for..of over a live Set would not give.
    listeners.forEach(listener => { listener() })
  }
  const unsubscribes = [
    list.subscribe(recompute),
    status.subscribe(recompute),
    pinned.subscribe(recompute),
    archived.subscribe(recompute),
  ]
  return {
    getSnapshot: () => model,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    dispose: () => {
      for (const unsubscribe of unsubscribes) unsubscribe()
      listeners.clear()
    },
  }
}
