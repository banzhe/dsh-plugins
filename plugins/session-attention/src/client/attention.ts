/**
 * The attention projection: which Sessions deserve a look right now, and the
 * store that keeps one stable snapshot of them for the overlay entry.
 *
 * Two facts are read, both owned by other plugins: `ctx.sessions.list` (row order
 * and labels) and `ctx.uiSession.sessionStatus` (running, completionUnread,
 * pendingInteraction). The status wins over the row's own `running`, which is
 * only a display fallback for a Session whose baseline never arrived, and
 * "still working" outranks a finish reminder.
 *
 * `waiting` is not a third bucket competing with the two sections: it is the
 * subset of the listed rows whose work is blocked on the user, so the outline can
 * never report a state with no row behind it.
 *
 * Rows that never list: subagent children (they mount under their parent, one
 * nesting level per delegation hop), the blank New-Session placeholder, and
 * archived Sessions. Archiving does not clear `completionUnread`, so the archive
 * set is a third input; it gates the descendants too, or a running child under an
 * archived Session would re-mount the row the user just filed away.
 *
 * A pinned Session lists at rest as a container row and never counts — `total`
 * reads {@link reportsActivity}, so a quiet pin costs no notification. `pinned`
 * is a fact about the Session, not about why its row is here: every listed row a
 * member holds carries it, so the release control is visible on all of them.
 */
import type {
  SessionListState, SessionProjectionSnapshot, SessionSummary,
} from '@deepseek-ai/dsh-api-session-controller/client'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { SessionStatusSnapshot } from '@deepseek-ai/dsh-client-ui-session/client'
import type { WorkspaceSnapshot } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'

/** One listed Session: enough to label a row, jump to it, and time its run. */
export interface AttentionRow {
  readonly id: SessionId
  /** Human-facing label, straight from the list row (`displayTitle`). */
  readonly title: string
  /**
   * Durable wall-clock ms of the latest human prompt (`sessionListMetadata.
   * lastPromptAt`): the start of the row's run. Absent until the projection is
   * read, and always absent on `unread` and container rows.
   */
  readonly lastPromptAt?: number
  /**
   * Listed subagent descendants, one nesting level per delegation hop: catalog
   * order first, `byId` order after. A child mounts when it runs or when running
   * work hangs below it; a settled branch never mounts.
   */
  readonly children?: readonly AttentionRow[]
  /**
   * Listed without a live run of its own: an idle parent over running work, or a
   * pinned Session at rest. Renders without the spinner and without a duration.
   */
  readonly container?: boolean
  /**
   * Marks a row whose Session is pinned, whatever else lists it; the panel draws
   * the control that releases the pin from this flag alone.
   */
  readonly pinned?: boolean
  /**
   * The open turn's start on a running child row (`subagentTiming.active.since`):
   * a child's work began with its current turn, not with a human prompt of its
   * own. Absent until the child's projection read has landed.
   */
  readonly turnedAt?: number
}

/** The whole panel content: two sections, newest first, plus their sum. */
export interface AttentionModel {
  readonly running: readonly AttentionRow[]
  /** Ordinary Sessions that finished while they were not the main view. */
  readonly unread: readonly AttentionRow[]
  /**
   * Listed Sessions whose work is blocked on the user: an approval, a question or
   * a plan review is waiting for an answer. Always a subset of `running` and
   * `unread` together, never part of {@link AttentionModel.total}, newest first.
   */
  readonly waiting: readonly AttentionRow[]
  readonly total: number
}

/** Session list source (`ctx.sessions.list`). */
export type AttentionListSource = ObservableSnapshot<SessionListState>
/** Session status source (`ctx.uiSession.sessionStatus`). */
export type AttentionStatusSource = ObservableSnapshot<SessionStatusSnapshot>

interface Candidate {
  readonly updatedAt: number
  readonly row: AttentionRow
}

/** The row's `projectionValues` is a `Partial`, so absence is the normal pre-read state. */
function lastPromptAtOf(projections: SessionProjectionSnapshot | undefined): number | undefined {
  return projections?.values.sessionListMetadata?.lastPromptAt ?? undefined
}

/** The sort is stable, so equal timestamps keep Host list order (candidates are pushed in that order). */
function byRecency(left: Candidate, right: Candidate): number {
  return right.updatedAt - left.updatedAt
}

function isRunning(row: SessionSummary, status: SessionStatusSnapshot): boolean {
  return status.get(row.id)?.running ?? row.running
}

/**
 * One fold's row lookups: `byId`, plus the same rows grouped under their parent in
 * `byId` enumeration order. Grouping once per fold is what keeps a fold linear.
 */
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
 * The direct subagent children of one node, labeled from the child row's
 * `displayTitle`. Two sources, because either can lag: the node's own
 * `subagentCatalog` projection (the Host's child order) and the indexed `byId`
 * rows, which already know a child whose catalog projection has not arrived. A
 * catalog entry with no row here, another `parentId`, or a non-subagent origin is
 * ignored, exactly like a foreign row in the index.
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

/**
 * The mounted descendants of one node in direct-child order: every child that is
 * running or that carries running work below it.
 *
 * `visited` is shared by one root's whole expansion, so a forged `parentId` cycle
 * terminates and no id lands in the tree twice.
 */
function runningChildrenOf(
  parent: SessionId,
  ctx: SubtreeContext,
  visited: Set<SessionId>,
): AttentionRow[] | undefined {
  const children: AttentionRow[] = []
  for (const row of directChildrenOf(parent, ctx)) {
    if (visited.has(row.id)) continue
    visited.add(row.id)
    const node = runningNodeOf(row, ctx, visited)
    if (node !== undefined) children.push(node)
  }
  return children.length === 0 ? undefined : children
}

/**
 * One descendant node, or `undefined` when neither it nor anything below it is
 * running. An idle one listed only for the work below it is a container and nests
 * that work one level deeper.
 */
function runningNodeOf(
  row: SessionSummary,
  ctx: SubtreeContext,
  visited: Set<SessionId>,
): AttentionRow | undefined {
  const running = isRunning(row, ctx.status)
  const children = runningChildrenOf(row.id, ctx, visited)
  if (!running) {
    return children === undefined
      ? undefined
      : { id: row.id, title: row.displayTitle, container: true, children }
  }
  const turnedAt = activeSinceOf(ctx.list.projectionsBySession[row.id])
  return {
    id: row.id,
    title: row.displayTitle,
    ...(turnedAt === undefined ? {} : { turnedAt }),
    ...(children === undefined ? {} : { children }),
  }
}

/** `undefined` until the child's own projection read lands, exactly like `lastPromptAt`. */
function activeSinceOf(projections: SessionProjectionSnapshot | undefined): number | undefined {
  return projections?.values.subagentTiming?.active?.since
}

function idsOf(byId: SessionListState['byId']): readonly SessionId[] {
  return Object.keys(byId) as SessionId[]
}

/**
 * Fold one list snapshot, one status snapshot, and the archive and pin sets into
 * the panel's content: the running and finished-unread sections, each newest
 * first, plus the listed subset of them whose work is blocked on the user.
 *
 * @param list - Session list snapshot, in Host list order.
 * @param status - per-Session status map.
 * @param archived - archived Session ids, which never list.
 * @param pinned - pinned Session ids, which list without live work.
 * @returns both sections, the waiting subset, and the counted total.
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
    // Subagent children never list as rows of their own, the New-Session
    // placeholder is not task work, and an archived Session is filed away.
    if (row.origin === 'subagent' || row.blank || archived.has(id)) return
    const entry = status.get(id)
    const isPinned = pinned.has(id)
    // A pending interaction holds the turn open, so the row already joined a
    // section; recording it in `waiting` beside that section is what keeps the
    // outline from reporting a state with no row behind it.
    const blocked = entry?.pendingInteraction !== undefined
    const lastPromptAt = lastPromptAtOf(list.projectionsBySession[id])
    // The root's own id seeds `visited`: a forged `parentId` chain looping back
    // to it must not re-mount the row inside itself.
    const children = runningChildrenOf(id, ctx, new Set<SessionId>([id]))
    const live = isRunning(row, status)
    if (live || children !== undefined) {
      const candidate: Candidate = {
        updatedAt: row.updatedAt,
        row: {
          id,
          title: row.displayTitle,
          ...(lastPromptAt === undefined ? {} : { lastPromptAt }),
          ...(live ? {} : { container: true }),
          ...(children === undefined ? {} : { children }),
          ...(isPinned ? { pinned: true } : {}),
        },
      }
      running.push(candidate)
      if (blocked) waiting.push(candidate)
      return
    }
    if (entry?.completionUnread === true) {
      const candidate: Candidate = {
        updatedAt: row.updatedAt,
        row: {
          id,
          title: row.displayTitle,
          ...(isPinned ? { pinned: true } : {}),
        },
      }
      unread.push(candidate)
      if (blocked) waiting.push(candidate)
      return
    }
    // A pinned Session at rest: the row the user asked for, not a notification.
    // It is a container, so `reportsActivity` keeps it out of the count.
    if (isPinned) {
      running.push({
        updatedAt: row.updatedAt,
        row: {
          id,
          title: row.displayTitle,
          ...(lastPromptAt === undefined ? {} : { lastPromptAt }),
          container: true,
          pinned: true,
        },
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
 * Comparable form of one row and everything mounted below it. Equality is decided
 * on content, never on object identity: `useSyncExternalStore` re-renders on
 * identity, so an unrelated list update must not cost a render. The key covers the
 * nesting to any depth, because a subagent starting or finishing a few hops down
 * is a change the panel must repaint.
 */
function rowKey(row: AttentionRow): string {
  return [
    row.id,
    row.title,
    row.lastPromptAt ?? '',
    row.container ? 'c' : '',
    row.pinned ? 'p' : '',
    // A child's open-turn start moves when a new turn opens: a re-key, not a
    // repaint of a standing number — the clock re-anchors in the same update.
    row.turnedAt ?? '',
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
    // The ring rides this one, so a pending interaction that appears or clears
    // while the sections stand still is a change, not a no-op.
    && sectionKey(left.waiting) === sectionKey(right.waiting)
}

/** Read-only view of the current panel content, plus the plugin's disposer. */
export interface AttentionStore extends ObservableSnapshot<AttentionModel> {
  dispose(): void
}

/** Workspace snapshot source (`ctx.workspaces.list`); its archive and pin sets are read. */
export type AttentionWorkspaceSource = ObservableSnapshot<WorkspaceSnapshot>

/**
 * Keep the attention model in step with all three sources. The archive and pin
 * sets get their own subscription: neither archiving nor pinning moves the Session
 * list or the status, so a row the user just filed away or just pinned would
 * otherwise stay as it was. The caller owns the lifetime through {@link
 * AttentionStore.dispose}.
 */
export function createAttentionStore(
  list: AttentionListSource,
  status: AttentionStatusSource,
  workspaces: AttentionWorkspaceSource,
): AttentionStore {
  const listeners = new Set<() => void>()
  /**
   * One read-only Set per handed-over array: the controller replaces the array on
   * a mutation and keeps its identity otherwise, so the array is the whole cache key.
   */
  const cachedSet = (read: () => readonly SessionId[]): (() => ReadonlySet<SessionId>) => {
    let cache: { readonly ids: readonly SessionId[]; readonly set: ReadonlySet<SessionId> } | undefined
    return () => {
      const ids = read()
      if (cache?.ids === ids) return cache.set
      const set: ReadonlySet<SessionId> = new Set(ids)
      cache = { ids, set }
      return set
    }
  }
  const archivedSet = cachedSet(() => workspaces.getSnapshot().archivedSessionIds)
  const pinnedSet = cachedSet(() => workspaces.getSnapshot().pinnedSessionIds)
  let model = deriveAttention(list.getSnapshot(), status.getSnapshot(), archivedSet(), pinnedSet())
  const recompute = (): void => {
    const next = deriveAttention(list.getSnapshot(), status.getSnapshot(), archivedSet(), pinnedSet())
    if (sameModel(next, model)) return
    model = next
    // A listener may unsubscribe itself mid-loop, so iterate over a snapshot:
    // the spread is the point, not a wasted copy.
    // oxlint-disable-next-line unicorn/no-useless-spread
    for (const listener of [...listeners]) listener()
  }
  const unsubscribeList = list.subscribe(recompute)
  const unsubscribeStatus = status.subscribe(recompute)
  const unsubscribeWorkspaces = workspaces.subscribe(recompute)
  return {
    getSnapshot: () => model,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    dispose: () => {
      unsubscribeList()
      unsubscribeStatus()
      unsubscribeWorkspaces()
      listeners.clear()
    },
  }
}

/**
 * Whether one running-section row stands for work: its own run, or the runs
 * mounted below it. A container row without children is a pinned Session at rest,
 * which the badge, the toggle outline and the taskbar pulse all skip.
 */
export function reportsActivity(row: AttentionRow): boolean {
  return row.container !== true || row.children !== undefined
}

/** Whether the running section holds real work, the one answer all three surfaces read. */
export function hasRunningActivity(model: AttentionModel): boolean {
  return model.running.some(reportsActivity)
}

/**
 * The wall-clock time one listed run has been going, in ms, from the row's own
 * anchor to `now`: a parent counts from its latest human prompt (`lastPromptAt`),
 * a child from the start of its open turn (`turnedAt`). `undefined` before the
 * anchor projection has been read.
 */
export function runElapsed(row: AttentionRow, now: number): number | undefined {
  const anchor = row.lastPromptAt ?? row.turnedAt
  if (anchor === undefined) return undefined
  return Math.max(0, now - anchor)
}

/**
 * `m:ss` before an hour, `h:mm:ss` from there: the same digit count within one
 * magnitude, so the column does not jitter as it counts.
 */
export function formatDuration(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000)
  const seconds = totalSeconds % 60
  const minutes = Math.floor(totalSeconds / 60) % 60
  const hours = Math.floor(totalSeconds / 3600)
  const pair = (value: number): string => String(value).padStart(2, '0')
  return hours > 0
    ? `${hours}:${pair(minutes)}:${pair(seconds)}`
    : `${minutes}:${pair(seconds)}`
}