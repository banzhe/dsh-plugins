/**
 * The In work model: Sessions that need a look — running work, finished-unread
 * work, and everything the user pinned — folded from state other plugins own. No
 * state is persisted and nothing is refreshed here — the Session-list snapshot,
 * the Session-status snapshot, and the Workspace owner's pin and archive sets are
 * the whole input.
 *
 * Three quick groups, one row per Session, each row carrying the browsing list's
 * own row facts so a Session draws the same dot here as it does in the tree:
 * - `unread` holds non-pinned Sessions finished while unread.
 * - `pinned` holds every pinned Session, whatever its work state. The pin chooses
 *   the row's group, never its dot: a pinned row reports its own running,
 *   completion and pending-interaction state.
 * - `running` holds non-pinned Sessions that run themselves or have running
 *   subagent work below them.
 *
 * Every listed Session appears in exactly one of the three: the pin leads, so a
 * pinned running Session lists only under `pinned`. `waiting` names the listed
 * Sessions blocked on the user, in the groups' display order.
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
  /** Finished-unread Sessions with no pin; newest first. */
  readonly unread: readonly AttentionRow[]
  /** Every pinned Session, at rest or in flight; newest first. */
  readonly pinned: readonly AttentionRow[]
  /** Sessions running themselves or over running subagent work, unpinned; newest first. */
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

/** Every group lists newest first; the sort is stable, so equal timestamps keep Host list order. */
function byRecency(left: Candidate, right: Candidate): number {
  return right.updatedAt - left.updatedAt
}

/**
 * Fold one list snapshot, one status snapshot, and the archive and pin sets into
 * the region's content.
 * @param list - Session list snapshot, in Host list order.
 * @param status - per-Session status map.
 * @param archived - archived Session ids, which never list.
 * @param pinned - pinned Session ids, which list only under `pinned`.
 * @returns the model the region renders.
 */
export function deriveAttention(
  list: SessionListState,
  status: SessionStatusSnapshot,
  archived: ReadonlySet<SessionId>,
  pinned: ReadonlySet<SessionId>,
): AttentionModel {
  const unread: Candidate[] = []
  const pinnedRows: Candidate[] = []
  const running: Candidate[] = []
  const blocked = new Set<SessionId>()
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
    // The pin outranks the work state for placement only; the row keeps its
    // running, completion and blocked facts for the dot it draws.
    if (node.pinned) {
      pinnedRows.push(candidate)
      return
    }
    // Subagent work belongs to the Session that delegated it: that row spins, and
    // the children never contribute rows of their own.
    if (node.running || node.runningSubagentCount > 0) {
      running.push(candidate)
      return
    }
    // A Session listed with no completion flag has nothing to report: it stays
    // in the tree below and takes no quick-group row.
    if (node.completed) unread.push(candidate)
  })
  const unreadRows = unread.sort(byRecency).map(candidate => candidate.row)
  const pinnedRowsSorted = pinnedRows.sort(byRecency).map(candidate => candidate.row)
  const runningRows = running.sort(byRecency).map(candidate => candidate.row)
  return {
    unread: unreadRows,
    pinned: pinnedRowsSorted,
    running: runningRows,
    waiting: [...unreadRows, ...pinnedRowsSorted, ...runningRows].filter(row => blocked.has(row.id)),
  }
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
  let model = deriveAttention(list.getSnapshot(), status.getSnapshot(), archived.getSnapshot(), pinned.getSnapshot())
  const recompute = (): void => {
    const next = deriveAttention(list.getSnapshot(), status.getSnapshot(), archived.getSnapshot(), pinned.getSnapshot())
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
