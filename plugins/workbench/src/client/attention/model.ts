/**
 * The In work model: Sessions that are running or need a look after finishing,
 * folded from state other plugins own. No state is persisted and nothing is
 * refreshed here — the Session-list snapshot, the Session-status snapshot, and the
 * Workspace owner's pin and archive sets are the whole input.
 *
 * Two groups, one row per Session:
 * - `running` holds every Session that runs itself or has running subagent work
 *   below it, pinned or not, stable newest first.
 * - `unread` holds non-running Sessions with a completion flag plus pinned
 *   Sessions with no running work, even without that flag; pinned rows lead, then
 *   newest first.
 *
 * A pinned running Session lists only under `running`; a pinned unread Session
 * lists only under `unread`; no Session lists in both.
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
import { runningDescendantCounts, sessionIsRunning } from '../tree.ts'

/** One listed Session: enough to label a row and jump to it. */
export interface AttentionRow {
  readonly id: SessionId
  /** Human-facing label, straight from the list row (`displayTitle`). */
  readonly title: string
  /** Listed without a live run of its own: a pinned Session at rest. */
  readonly container?: boolean
  /** Marks a row whose Session is pinned, whatever else lists it. */
  readonly pinned?: boolean
}

/** Everything the region renders: two independent groups. */
export interface AttentionModel {
  /** Sessions running or holding running subagent work, pinned ones included; stable newest first. */
  readonly running: readonly AttentionRow[]
  /** Finished-unread Sessions plus pinned idle Sessions; pinned rows lead, then newest. */
  readonly unread: readonly AttentionRow[]
  /** Listed Sessions whose work is blocked on the user; a subset of the two groups. */
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

/** The running sort is stable, so equal timestamps keep Host list order. */
function byRecency(left: Candidate, right: Candidate): number {
  return right.updatedAt - left.updatedAt
}

/** Pinned rows lead the unread group; each side keeps the stable newest-first order. */
function byUnreadPriority(left: Candidate, right: Candidate): number {
  const leftPinned = left.row.pinned === true ? 0 : 1
  const rightPinned = right.row.pinned === true ? 0 : 1
  if (leftPinned !== rightPinned) return leftPinned - rightPinned
  return right.updatedAt - left.updatedAt
}

/**
 * Fold one list snapshot, one status snapshot, and the archive and pin sets into
 * the region's content.
 * @param list - Session list snapshot, in Host list order.
 * @param status - per-Session status map.
 * @param archived - archived Session ids, which never list.
 * @param pinned - pinned Session ids, which lead the unread group at rest.
 * @returns the model the region renders.
 */
export function deriveAttention(
  list: SessionListState,
  status: SessionStatusSnapshot,
  archived: ReadonlySet<SessionId>,
  pinned: ReadonlySet<SessionId>,
): AttentionModel {
  const running: Candidate[] = []
  const unread: Candidate[] = []
  const blocked = new Set<SessionId>()
  const descendants = runningDescendantCounts(list, status)
  list.ids.forEach((id) => {
    const row = list.byId[id]
    // An id may be listed before the Host projects its row (nothing to label).
    if (row === undefined) return
    if (row.origin === 'subagent' || row.blank || archived.has(id)) return
    const entry = status.get(id)
    const isPinned = pinned.has(id)
    // Subagent work belongs to the Session that delegated it: that row spins, and
    // the children never contribute rows of their own.
    const live = sessionIsRunning(list, status, id) || (descendants.get(id) ?? 0) > 0
    if (live) {
      // A pinned running Session belongs here only, even when a completion flag is
      // also set.
      running.push({
        updatedAt: row.updatedAt,
        row: { id, title: row.displayTitle, ...(isPinned ? { pinned: true } : {}) },
      })
      if (entry?.pendingInteraction !== undefined) blocked.add(id)
      return
    }
    if (entry?.completionUnread === true) {
      unread.push({
        updatedAt: row.updatedAt,
        row: { id, title: row.displayTitle, ...(isPinned ? { pinned: true } : {}) },
      })
      if (entry.pendingInteraction !== undefined) blocked.add(id)
      return
    }
    // A pinned Session at rest belongs to the unread group even without a
    // completion flag: the user asked to keep it in view, and it has no run.
    if (isPinned) {
      unread.push({
        updatedAt: row.updatedAt,
        row: { id, title: row.displayTitle, container: true, pinned: true },
      })
      if (entry?.pendingInteraction !== undefined) blocked.add(id)
    }
  })
  const runningRows = running.sort(byRecency).map(candidate => candidate.row)
  const unreadRows = unread.sort(byUnreadPriority).map(candidate => candidate.row)
  return {
    running: runningRows,
    unread: unreadRows,
    waiting: [...runningRows, ...unreadRows].filter(row => blocked.has(row.id)),
  }
}

/**
 * One row's comparable identity: everything the row renders. Two models with equal
 * keys draw the same pixels, which is what lets the store publish a fold only when
 * something visible changed.
 */
function rowKey(row: AttentionRow): string {
  return [row.id, row.title, row.container ? 'c' : '', row.pinned ? 'p' : ''].join('\u0002')
}

function rowsKey(rows: readonly AttentionRow[]): string {
  return rows.map(rowKey).join('\u0001')
}

/** Whether two models would render identically. */
function sameModel(left: AttentionModel, right: AttentionModel): boolean {
  return rowsKey(left.running) === rowsKey(right.running)
    && rowsKey(left.unread) === rowsKey(right.unread)
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
