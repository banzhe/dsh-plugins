/**
 * The attention model: which Sessions deserve a look right now, folded from
 * state other plugins own. No state is persisted and nothing is refreshed here —
 * the Session-list snapshot, the Session-status snapshot, and the Workspace
 * owner's pin and archive sets are the whole input.
 *
 * "Still working" outranks a finish reminder, and a pending interaction is not a
 * third bucket competing with the sections: it is the subset of listed rows whose
 * work is blocked on the user, so the header can never report a state with no row
 * behind it.
 *
 * Rows that never list: subagent children (they mount under their parent, one
 * level per delegation hop), the blank New-Session placeholder, and archived
 * Sessions. Archiving does not clear the completion flag, so the archive set is a
 * third input; it gates descendants too, or a running child under an archived
 * Session would re-mount the row the user just filed away.
 *
 * A pinned Session lists at rest as a container row and never counts: `total`
 * reads {@link reportsActivity}, so a quiet pin costs no notification.
 */
import type { SessionListState, SessionSummary } from '@deepseek-ai/dsh-api-session-controller/client'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { SessionStatusSnapshot } from '@deepseek-ai/dsh-client-ui-session/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { sessionIsRunning } from '../tree.ts'

/** One listed Session: enough to label a row, jump to it, and nest its work. */
export interface AttentionRow {
  readonly id: SessionId
  /** Human-facing label, straight from the list row (`displayTitle`). */
  readonly title: string
  /** Listed subagent descendants, one nesting level per delegation hop. */
  readonly children?: readonly AttentionRow[]
  /** Listed without a live run of its own: an idle parent over running work, or a pinned Session at rest. */
  readonly container?: boolean
  /** Marks a row whose Session is pinned, whatever else lists it. */
  readonly pinned?: boolean
}

/** Everything the section renders, newest first per group. */
export interface AttentionModel {
  readonly running: readonly AttentionRow[]
  /** Ordinary Sessions that finished while they were not the main view. */
  readonly unread: readonly AttentionRow[]
  /** Listed Sessions whose work is blocked on the user; always a subset of the other two. */
  readonly waiting: readonly AttentionRow[]
  /** Sessions that report activity: running work plus unread finishes. A quiet pin is excluded. */
  readonly total: number
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

/** The sort is stable, so equal timestamps keep Host list order. */
function byRecency(left: Candidate, right: Candidate): number {
  return right.updatedAt - left.updatedAt
}

/** One fold's child lookups, grouped by parent once so the fold stays linear. */
interface ChildIndex {
  readonly byId: SessionListState['byId']
  readonly byParent: ReadonlyMap<SessionId, readonly SessionSummary[]>
}

function childIndexOf(byId: SessionListState['byId']): ChildIndex {
  const byParent = new Map<SessionId, SessionSummary[]>()
  for (const id of idsOf(byId)) {
    const row = byId[id]
    if (row?.parentId === undefined) continue
    const siblings = byParent.get(row.parentId)
    if (siblings === undefined) byParent.set(row.parentId, [row])
    else siblings.push(row)
  }
  return { byId, byParent }
}

/** One fold's inputs to a subtree expansion, fixed for the whole fold. */
interface SubtreeContext {
  readonly list: SessionListState
  readonly index: ChildIndex
  readonly status: SessionStatusSnapshot
}

/**
 * The direct subagent children of one node: the node's own `subagentCatalog`
 * projection order first, then indexed `byId` rows the catalog has not caught up
 * with. A catalog entry with no row here, another `parentId`, or a non-subagent
 * origin is ignored, exactly like a foreign row in the index.
 */
function directChildrenOf(parent: SessionId, ctx: SubtreeContext): readonly SessionSummary[] {
  const seen = new Set<SessionId>()
  const ordered: SessionSummary[] = []
  for (const entry of ctx.list.projectionsBySession[parent]?.values.subagentCatalog ?? []) {
    const row = ctx.index.byId[entry.id]
    if (row === undefined || row.parentId !== parent || seen.has(entry.id)) continue
    seen.add(entry.id)
    ordered.push(row)
  }
  for (const row of ctx.index.byParent.get(parent) ?? []) {
    if (seen.has(row.id)) continue
    seen.add(row.id)
    ordered.push(row)
  }
  return ordered.filter(row => row.origin === 'subagent')
}

/** One frame of the subtree walk: a row to expand, its children, and the next child to descend into. */
interface SubtreeFrame {
  readonly row: SessionSummary
  readonly kids: readonly SessionSummary[]
  next: number
}

/**
 * The node one row contributes, from its own run and its already-assembled
 * children: a running row keeps its title and children, an idle row over running
 * work becomes a container, and a row with neither is not part of the subtree.
 */
function subtreeNode(row: SessionSummary, running: boolean, children: readonly AttentionRow[]): AttentionRow | undefined {
  if (!running) {
    return children.length === 0 ? undefined : { id: row.id, title: row.displayTitle, container: true, children }
  }
  return { id: row.id, title: row.displayTitle, ...(children.length === 0 ? {} : { children }) }
}

/**
 * The mounted subtree of one listed Session: every descendant running, or
 * carrying running work below it, nested one level per delegation hop.
 *
 * Two lineage facts make this walk terminate without a visited set. A row carries
 * at most one `parentId`, so the child edges — built once in `byParent` for the
 * whole fold — form a functional graph; and only a row whose `origin` is
 * `subagent` is ever a child. Every node of a cycle would therefore have to be
 * `subagent` (each one is somebody's child) while taking its parent from inside
 * the cycle, so no listed root — which is non-subagent by construction — can be
 * an ancestor of one. An endless dataset would have to break the unique-parent
 * rule to reach this fold.
 *
 * The walk is an explicit stack rather than recursion for the reason
 * `runningDescendantCounts` in tree.ts is: a delegation chain of a few thousand
 * hops is legal input, and the JavaScript call stack is not that deep. Frames are
 * assembled post-order, so a parent is built only after every child below it,
 * and children keep `directChildrenOf` order.
 * @param root - the listed Session whose subtree to expand.
 * @param ctx - this fold's list, child index and status map.
 * @returns the nested node, or `undefined` when neither `root` nor anything below it runs.
 */
function runningSubtreeOf(root: SessionSummary, ctx: SubtreeContext): AttentionRow | undefined {
  const built = new Map<SessionId, AttentionRow | undefined>()
  const frames: SubtreeFrame[] = [{ row: root, kids: directChildrenOf(root.id, ctx), next: 0 }]
  while (frames.length > 0) {
    // Every pushed frame is removed exactly once, and the loop condition
    // guarantees a top frame; the cast states that rather than re-testing it.
    const frame = frames[frames.length - 1] as SubtreeFrame
    if (frame.next < frame.kids.length) {
      const kid = frame.kids[frame.next] as SessionSummary
      frame.next += 1
      frames.push({ row: kid, kids: directChildrenOf(kid.id, ctx), next: 0 })
      continue
    }
    frames.pop()
    const children: AttentionRow[] = []
    for (const kid of frame.kids) {
      const node = built.get(kid.id)
      if (node !== undefined) children.push(node)
    }
    built.set(frame.row.id, subtreeNode(frame.row, sessionIsRunning(ctx.list, ctx.status, frame.row.id), children))
  }
  return built.get(root.id)
}

function idsOf(byId: SessionListState['byId']): readonly SessionId[] {
  return Object.keys(byId) as SessionId[]
}

/**
 * Fold one list snapshot, one status snapshot, and the archive and pin sets into
 * the section's content.
 * @param list - Session list snapshot, in Host list order.
 * @param status - per-Session status map.
 * @param archived - archived Session ids, which never list.
 * @param pinned - pinned Session ids, which list without live work.
 * @returns the model the section renders.
 */
export function deriveAttention(
  list: SessionListState,
  status: SessionStatusSnapshot,
  archived: ReadonlySet<SessionId>,
  pinned: ReadonlySet<SessionId>,
): AttentionModel {
  const running: Candidate[] = []
  const unread: Candidate[] = []
  const waiting: Candidate[] = []
  const ctx: SubtreeContext = { list, index: childIndexOf(list.byId), status }
  list.ids.forEach((id) => {
    const row = list.byId[id]
    // An id may be listed before the Host projects its row (nothing to label).
    if (row === undefined) return
    if (row.origin === 'subagent' || row.blank || archived.has(id)) return
    const entry = status.get(id)
    const isPinned = pinned.has(id)
    // A pending interaction holds the turn open, so the row already joined a
    // section; recording it in `waiting` beside that section keeps the header
    // from reporting a state with no row behind it.
    const blocked = entry?.pendingInteraction !== undefined
    const node = runningSubtreeOf(row, ctx)
    if (node !== undefined) {
      const candidate: Candidate = {
        updatedAt: row.updatedAt,
        // The pin marks the listed row itself, never a descendant.
        row: isPinned ? { ...node, pinned: true } : node,
      }
      running.push(candidate)
      if (blocked) waiting.push(candidate)
      return
    }
    if (entry?.completionUnread === true) {
      const candidate: Candidate = {
        updatedAt: row.updatedAt,
        row: { id, title: row.displayTitle, ...(isPinned ? { pinned: true } : {}) },
      }
      unread.push(candidate)
      if (blocked) waiting.push(candidate)
      return
    }
    // A pinned Session at rest: the row the user asked for, not a notification.
    if (isPinned) {
      running.push({
        updatedAt: row.updatedAt,
        row: { id, title: row.displayTitle, container: true, pinned: true },
      })
    }
  })
  const runningRows = running.sort(byRecency).map(candidate => candidate.row)
  const unreadRows = unread.sort(byRecency).map(candidate => candidate.row)
  return {
    running: runningRows,
    unread: unreadRows,
    waiting: waiting.sort(byRecency).map(candidate => candidate.row),
    total: runningRows.filter(reportsActivity).length + unreadRows.length,
  }
}

/**
 * Whether one running-section row stands for work: its own run, or the runs
 * mounted below it. A container row without children is a pinned Session at rest.
 */
export function reportsActivity(row: AttentionRow): boolean {
  return row.container !== true || row.children !== undefined
}

/** The three groups the section renders, split by why each row is listed. */
export interface AttentionSections {
  /** Pinned Sessions at rest: the rows the user asked for, not notifications. */
  readonly pinned: readonly AttentionRow[]
  /** Sessions with running work, or nesting running work below them. */
  readonly running: readonly AttentionRow[]
  readonly unread: readonly AttentionRow[]
}

/**
 * Split the model into the pinned, running and unread groups the section renders.
 * @param model - one folded attention model.
 * @returns the three groups, each already newest first.
 */
export function attentionSections(model: AttentionModel): AttentionSections {
  return {
    pinned: model.running.filter(row => !reportsActivity(row)),
    running: model.running.filter(reportsActivity),
    unread: model.unread,
  }
}

/**
 * One row's comparable identity: everything the row renders plus its subtree, in
 * order. Two models with equal keys draw the same pixels, which is what lets the
 * store publish a fold only when something visible changed.
 */
function rowKey(row: AttentionRow): string {
  return [
    row.id,
    row.title,
    row.container ? 'c' : '',
    row.pinned ? 'p' : '',
    row.children === undefined ? '' : row.children.map(rowKey).join('\u0003'),
  ].join('\u0002')
}

function sectionKey(rows: readonly AttentionRow[]): string {
  return rows.map(rowKey).join('\u0001')
}

/** Whether two models would render identically. */
function sameModel(left: AttentionModel, right: AttentionModel): boolean {
  return sectionKey(left.running) === sectionKey(right.running)
    && sectionKey(left.unread) === sectionKey(right.unread)
    // The blocked marker rides this one, so a pending interaction that appears or
    // clears while the sections stand still is a change, not a no-op.
    && sectionKey(left.waiting) === sectionKey(right.waiting)
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
 * @param list - Session list source.
 * @param status - per-Session status source.
 * @param pinned - pinned Session ids, as the Workspace owner derives them.
 * @param archived - archived Session ids, as the Workspace owner derives them.
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
