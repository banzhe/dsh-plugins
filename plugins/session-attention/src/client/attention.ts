/**
 * The attention projection: which Sessions deserve a look right now, and the
 * store that keeps one stable snapshot of them for the overlay entry.
 *
 * Two facts are read, both owned by other plugins:
 *
 * - `ctx.sessions.list` — the row order and the labels. Iterating `ids` is what
 *   keeps subagent children out: only Host-list members live there, while a
 *   child exists solely in `byId` with `origin: 'subagent'`. The check is kept
 *   anyway, because that flag is the same rule the shipped sidebar and
 *   app-notification filter on.
 * - `ctx.uiSession.sessionStatus` — `running`, `completionUnread` and
 *   `pendingInteraction` per Session. The status wins over the row's own
 *   `running` (the row value is only a display fallback for a Session whose
 *   baseline never arrived), which is exactly the fold `ui-workspace` uses for
 *   its rows. Subagent children read the same status map: a child the fold
 *   mounts under its parent is running by the same rule the panel applies to
 *   main-view rows.
 *
 * `running` and `completionUnread` are mutually exclusive in practice (the host
 * deletes the reminder when work starts again); a row carrying both is reported
 * as running, because "still working" is the more actionable fact.
 *
 * `pendingInteraction` cuts across both: a Session is usually running while an
 * approval, a question or a plan review holds its turn, and the host still
 * reports it running. So `waiting` is not a third bucket competing with the two
 * sections — it is the subset of the listed rows whose work is blocked on the
 * user, and the outline reads it first.
 *
 * Blank rows are skipped too: `blank` is the reusable New-Session placeholder,
 * and the host clears it the moment the Session runs or is prompted — so no
 * running and no finished session is ever hidden by this filter.
 *
 * Subagent children are not panel rows of their own: they mount under their
 * parent's running row, one nesting level per delegation hop. A row is listed
 * when it is running itself or when any descendant is running — an idle parent
 * whose only activity is a running child, or a running grandchild below an
 * idle one, is a container row in the running section, and the idle
 * intermediates between it and the running work are container rows too. Neither
 * carries a prompt time: a child's work started with the delegation, not with a
 * human prompt the child owns.
 *
 * Archived Sessions never list, whatever their status says. The archive set is
 * registry-global and the sidebar files those rows away: a Session the user put
 * away is not work waiting for a look, even while the host still reports it
 * running or finished-unread. Archiving does not clear `completionUnread`, so
 * the status map cannot answer this on its own — the archive set is a third
 * input, and it also gates the descendants: a running one under an archived
 * Session would otherwise re-mount the row the user just filed away.
 */
import type {
  SessionListState, SessionProjectionSnapshot, SessionSummary,
} from '@deepseek-ai/dsh-api-session-controller/client'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { SessionStatusSnapshot } from '@deepseek-ai/dsh-client-ui-session/client'
import type { WorkspaceSnapshot } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'

/**
 * One listed Session: enough to label a row, jump to it, and time its run.
 */
export interface AttentionRow {
  readonly id: SessionId
  /** Human-facing label, straight from the list row (`displayTitle`). */
  readonly title: string
  /**
   * Durable wall-clock ms of the latest human prompt (`sessionListMetadata.
   * lastPromptAt`): the run the row is in started with that prompt, so the
   * panel counts from it. Absent until the projection has been read, for the
   * `unread` rows, whose work has already stopped, and for a container row.
   */
  readonly lastPromptAt?: number
  /**
   * The listed subagent descendants of the row, one nesting level per
   * delegation hop: catalog order first (the node's own `subagentCatalog`
   * projection array, which the Host folds in catalog event order),
   * retain-backed rows last in list order. A child mounts when it is running or
   * when running work hangs below it; a settled branch under a listed node
   * never mounts.
   */
  readonly children?: readonly AttentionRow[]
  /**
   * Marks a node listed only because running work hangs below it: a container
   * row renders without the spinner and without a duration, since it holds no
   * live run of its own to count from.
   */
  readonly container?: boolean
  /**
   * The open turn's start on a running child row (`subagentTiming.active.
   * since`): the child's work began with its current turn, not with a human
   * prompt of its own, so this is what a child's duration counts from.
   * Absent until the child's projection read has landed.
   */
  readonly turnedAt?: number
}

/** The whole panel content: two sections, newest first, plus their sum. */
export interface AttentionModel {
  readonly running: readonly AttentionRow[]
  /** Ordinary Sessions that finished while they were not the main view. */
  readonly unread: readonly AttentionRow[]
  /**
   * Listed Sessions whose work is blocked on the user: an approval, a question
   * or a plan review is waiting for an answer.
   *
   * Always a subset of `running` and `unread` together, and never part of
   * {@link AttentionModel.total}: the outline reads it as its highest-priority
   * fact, so a state the panel cannot show would be a signal with nothing
   * behind it. Newest first, like the sections.
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

/**
 * The row's `projectionValues` is a `Partial`, so absence is the normal
 * pre-read state, not an error.
 */
function lastPromptAtOf(projections: SessionProjectionSnapshot | undefined): number | undefined {
  return projections?.values.sessionListMetadata?.lastPromptAt ?? undefined
}

/**
 * The sort is stable, so equal timestamps keep Host list order —
 * candidates are pushed in `list.ids` order.
 */
function byRecency(left: Candidate, right: Candidate): number {
  return right.updatedAt - left.updatedAt
}

function isRunning(row: SessionSummary, status: SessionStatusSnapshot): boolean {
  return status.get(row.id)?.running ?? row.running
}

/**
 * One fold's row lookups: `byId`, plus the same rows grouped under their
 * parent in `byId` enumeration order. Grouping once per fold is what keeps a
 * fold linear: a parent's children used to be found by scanning every row,
 * once per listed row, which turned a fold into a quadratic walk.
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

/**
 * One fold's inputs to a subtree expansion, fixed for the whole fold.
 */
interface SubtreeContext {
  readonly list: SessionListState
  readonly index: ChildIndex
  readonly status: SessionStatusSnapshot
}

/**
 * The direct subagent children of one node, labeled from the child row's
 * `displayTitle` (the controller already derives it from the title projection,
 * then the catalog label, then the id). Two sources, because either can lag:
 * the node's own `subagentCatalog` projection (the fact the sidebar counts, and
 * the Host's own child order) and the indexed `byId` rows, which already know a
 * child whose catalog projection has not arrived. Catalog order comes first;
 * rows the catalog does not name follow in `byId` order. A catalog entry with
 * no row here, another `parentId`, or a non-subagent origin is ignored, exactly
 * like a foreign row in the index.
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
 * The mounted descendants of one node in direct-child order: every child that
 * is running or that itself carries running work below it.
 *
 * `visited` is shared by one root's whole expansion, so a forged `parentId`
 * cycle terminates and no id lands in the tree twice.
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
 * running. A running node keeps the spinner and counts from its own open turn;
 * an idle one listed only for the work below it is a container and nests that
 * work one level deeper.
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

/**
 * `undefined` before the child's own projection read has landed —
 * the child row renders without a duration until the number exists, exactly
 * like a parent row before `lastPromptAt` is read.
 */
function activeSinceOf(projections: SessionProjectionSnapshot | undefined): number | undefined {
  return projections?.values.subagentTiming?.active?.since
}

function idsOf(byId: SessionListState['byId']): readonly SessionId[] {
  return Object.keys(byId) as SessionId[]
}

/**
 * Fold one list snapshot, one status snapshot, and the archive set into the
 * panel's content: the running and finished-unread sections, each newest first,
 * plus the listed subset of them whose work is blocked on the user. Running
 * subagent descendants mount under their row, nested one level per hop.
 *
 * `archived` is the registry-global archive set: its members never list, and a
 * running descendant under an archived Session never re-mounts that Session.
 */
export function deriveAttention(
  list: SessionListState,
  status: SessionStatusSnapshot,
  archived: ReadonlySet<SessionId>,
): AttentionModel {
  const running: Candidate[] = []
  const unread: Candidate[] = []
  const waiting: Candidate[] = []
  const ctx: SubtreeContext = { list, index: childIndexOf(list.byId), status }
  list.ids.forEach((id) => {
    const row = list.byId[id]
    // An id may be listed before the Host projects its row (nothing to label).
    if (row === undefined) return
    // Subagent children never appear as panel rows of their own; the
    // New-Session placeholder is not task work. An archived Session is filed
    // away, so it lists nothing either — whatever its running or unread status
    // still says.
    if (row.origin === 'subagent' || row.blank || archived.has(id)) return
    const entry = status.get(id)
    // A pending interaction is a live Host request holding the turn open, so a
    // blocked Session is running and has already joined the running section; a
    // reminder it never cleared lands here the same way. Each branch records the
    // row in `waiting` beside that section, which is what keeps the outline from
    // ever reporting a state the panel has no row for.
    const blocked = entry?.pendingInteraction !== undefined
    // The run the row is in started with the latest human prompt, a durable
    // fact the list projection already carries: counting from it needs no
    // client-side timer of the plugin's own.
    const lastPromptAt = lastPromptAtOf(list.projectionsBySession[id])
    // The root's own id seeds `visited`: a forged `parentId` chain looping back
    // to it must not re-mount the row inside itself.
    const children = runningChildrenOf(id, ctx, new Set<SessionId>([id]))
    if (isRunning(row, status) || children !== undefined) {
      const candidate: Candidate = {
        updatedAt: row.updatedAt,
        row: {
          id,
          title: row.displayTitle,
          ...(lastPromptAt === undefined ? {} : { lastPromptAt }),
          // A row whose only activity is running work below it is a container
          // row: no spinner, no dot, and no duration. The descendants are the
          // signal.
          ...(isRunning(row, status) ? {} : { container: true }),
          ...(children === undefined ? {} : { children }),
        },
      }
      running.push(candidate)
      if (blocked) waiting.push(candidate)
      return
    }
    if (entry?.completionUnread === true) {
      const candidate: Candidate = { updatedAt: row.updatedAt, row: { id, title: row.displayTitle } }
      unread.push(candidate)
      if (blocked) waiting.push(candidate)
    }
  })
  const runningRows = running.sort(byRecency).map(candidate => candidate.row)
  const unreadRows = unread.sort(byRecency).map(candidate => candidate.row)
  return {
    running: runningRows,
    unread: unreadRows,
    waiting: waiting.sort(byRecency).map(candidate => candidate.row),
    total: runningRows.length + unreadRows.length,
  }
}

/**
 * Comparable form of one row and everything mounted below it. Equality is
 * decided on content, never on object identity, so a source notification that
 * does not actually change the panel keeps the previous snapshot object —
 * `useSyncExternalStore` re-renders on identity, and an unrelated list update
 * must not cost a render.
 *
 * The prompt time rides the same comparison: it moves only when the user
 * prompts again, which is exactly a new run and a new count. The key covers the
 * nesting to any depth — ids, labels, container flags and turned-at anchors —
 * because a subagent starting or finishing a few hops down, with every row
 * above it otherwise standing still, is a change the panel must repaint.
 */
function rowKey(row: AttentionRow): string {
  return [
    row.id,
    row.title,
    row.lastPromptAt ?? '',
    row.container ? 'c' : '',
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

/** Workspace snapshot source (`ctx.workspaces.list`); only its archive set is read. */
export type AttentionWorkspaceSource = ObservableSnapshot<WorkspaceSnapshot>

/**
 * Keep the attention model in step with all three sources.
 *
 * Subscribes eagerly: the entry is registered unconditionally, so there is no
 * lazy window to preserve. The caller owns the lifetime through {@link
 * AttentionStore.dispose}.
 *
 * The archive set gets its own subscription rather than being read incidentally:
 * archiving moves neither the Session list nor the status, so without it a row
 * the user just filed away would stay listed until something unrelated changed.
 */
export function createAttentionStore(
  list: AttentionListSource,
  status: AttentionStatusSource,
  workspaces: AttentionWorkspaceSource,
): AttentionStore {
  const listeners = new Set<() => void>()
  // Rebuilt only when the controller hands over a new archive array, which it
  // does on an archive mutation and not on unrelated snapshot churn.
  let archivedCache: { readonly ids: readonly SessionId[]; readonly set: ReadonlySet<SessionId> } | undefined
  const archivedSet = (): ReadonlySet<SessionId> => {
    const ids = workspaces.getSnapshot().archivedSessionIds
    if (archivedCache?.ids === ids) return archivedCache.set
    const set: ReadonlySet<SessionId> = new Set(ids)
    archivedCache = { ids, set }
    return set
  }
  let model = deriveAttention(list.getSnapshot(), status.getSnapshot(), archivedSet())
  const recompute = (): void => {
    const next = deriveAttention(list.getSnapshot(), status.getSnapshot(), archivedSet())
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
 * The wall-clock time one listed run has been going, in ms, counted from the
 * row's own anchor to `now`: a parent row's anchor is the latest human prompt
 * (`lastPromptAt`), a child row's is the start of its open turn (`turnedAt`).
 * `undefined` before the anchor projection has been read — the row renders
 * without a duration until the number exists.
 */
export function runElapsed(row: AttentionRow, now: number): number | undefined {
  const anchor = row.lastPromptAt ?? row.turnedAt
  if (anchor === undefined) return undefined
  return Math.max(0, now - anchor)
}

/**
 * `m:ss` before an hour, `h:mm:ss` from there — compact, and the same digit
 * count within one magnitude so the column does not jitter as it counts. A run
 * shorter than a second reads `0:00`, like a timer that has just started.
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
