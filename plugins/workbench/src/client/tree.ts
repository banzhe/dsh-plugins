/**
 * Derives the workspace browser tree from caller-projected Workspace and
 * Session order. Unassigned Sessions trail under Ungrouped; only the selected
 * blank Session remains visible.
 */
import type {
  SessionListState, SessionSearchResultItem, SessionSummary,
} from '@deepseek-ai/dsh-api-session-controller/client'
import type { WorkspaceId, WorkspaceView } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type {
  SessionStatusSnapshot,
} from '@deepseek-ai/dsh-client-ui-session/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { assertNever } from '@deepseek-ai/dsh-util-values'
import { workspaceTitleOf } from '@deepseek-ai/dsh-util-workspace-path'

/** Group key for Sessions outside every Workspace. */
export const UNGROUPED_KEY = ''

/**
 * Resolve the Workspace browser group that owns one Session.
 * @param workspaces - authoritative Workspace membership.
 * @param sessionId - Session whose browser group is required.
 * @returns owning Workspace id, or {@link UNGROUPED_KEY} when no Workspace accounts for it.
 */
export function owningGroupKey(
  workspaces: readonly WorkspaceView[],
  sessionId: SessionId,
): string {
  return (workspaces.find(workspace => workspace.sessionIds.includes(sessionId))
    ?.workspaceId as string | undefined) ?? UNGROUPED_KEY
}

/** Pending interaction kinds with dedicated Workspace-row presentation. */
export type SessionPendingInteractionStatus = 'approval' | 'plan-review' | 'question'
type SessionStatuses = SessionStatusSnapshot

function mainSessionId(list: SessionListState): SessionId | undefined {
  return Object.values(list.byId)
    .find(session => (session.retainedBy.mainView ?? 0) > 0)?.id
}

/** One top-level session row in a group or the flat list. */
export interface SessionNode {
  id: SessionId
  /** Stored title, or empty; the renderer localizes blank and unnamed row labels. */
  title: string
  /** The provisional blank session (renderer shows the localized New Session title). */
  blank: boolean
  /** A Session-scoped UI consumer is awaiting this user. */
  pendingInteraction?: SessionPendingInteractionStatus
  running: boolean
  /** Running subagent descendants at any depth. */
  runningSubagentCount: number
  /** Finished running while not selected and not yet opened (the green "done" reminder dot). */
  completed: boolean
  /** In the registry-global pin set: leads its section, reorderable only among pinned rows. */
  pinned: boolean
  /** In the registry-global archive set: shown grayed in place and not openable. */
  archived: boolean
  updatedAt: number
  /** Session working directory; absent when the Host reports none or an empty path. */
  cwd?: string
}

/** Session order selected by the Workspace browser. */
export type SessionOrderBy = 'manual' | 'updated'

/** One workspace group section: header row facts + visible top-level session rows. */
export interface GroupNode {
  /** Group key: the workspace id or {@link UNGROUPED_KEY}. */
  key: string
  /** Backing Workspace id; absent only for the ungrouped bucket. */
  workspaceId: WorkspaceId | undefined
  cwd: string | undefined
  /** Workspace creation time (epoch ms); absent only for the ungrouped bucket. */
  createdAt: number | undefined
  label: string
  /** Total visible sessions in the group. */
  sessionCount: number
  expanded: boolean
  /** The group contains the selected session (active folder tint; supplied here so the renderer never scans). */
  containsCurrent: boolean
  /**
   * A folded group holds executing work — its own running Session or a running
   * descendant — so the header's closed-folder icon carries the activity the
   * hidden rows would otherwise show. Always false while the group is expanded.
   */
  running: boolean
  /**
   * A folded group holds a visible finished-but-unviewed Session, so the
   * header's closed-folder icon carries the completion reminder the hidden row
   * would otherwise show. Always false while the group is expanded.
   */
  completedUnread: boolean
  /** Visible session rows (empty while the group is folded). */
  sessions: readonly SessionNode[]
}

/** One flat search row combining list metadata with an optional content match. */
export interface SearchResultNode {
  id: SessionId
  title: string
  workspace: string
  /** A Session-scoped UI consumer is awaiting this user. */
  pendingInteraction?: SessionPendingInteractionStatus
  running: boolean
  /** Running subagent descendants at any depth. */
  runningSubagentCount: number
  /** Finished running while not selected and not yet opened (the green "done" reminder dot). */
  completed: boolean
  /** In the registry-global archive set: shown grayed and not openable. */
  archived: boolean
  snippet?: string
}

/** Bounded merged search projection plus the refine-query hint bit. */
export interface SearchResultSet {
  items: readonly SearchResultNode[]
  hasMore: boolean
}

/** Viewing state consumed by the derivation. */
export interface TreeView {
  expandedGroups: readonly string[]
  /** Browser-local order for Sessions without a backing Workspace account. */
  ungroupedOrder?: readonly string[]
}

interface Group {
  key: string
  workspaceId: WorkspaceId | undefined
  cwd: string | undefined
  createdAt: number | undefined
  label: string
  sessions: SessionSummary[]
}

/**
 * Directory display label: basename of the path (both separators accepted).
 * Ungrouped-bucket fallback for surfaces without a workspace title.
 * @param cwd - directory path, or undefined for the ungrouped bucket.
 * @returns basename, the raw cwd when it has no basename, or an empty ungrouped marker.
 */
export function workspaceLabel(cwd: string | undefined): string {
  if (cwd === undefined || cwd === '') return ''
  const base = workspaceTitleOf(cwd)
  return base !== '' ? base : cwd
}

/**
 * Project known account members by current Session recency.
 * @param sessionIds - authoritative account membership.
 * @param summaries - current Session summaries; members without a summary are omitted until it arrives.
 * @returns known members newest first, with Session identity as the deterministic tie-break.
 */
export function orderByRecency(
  sessionIds: readonly SessionId[],
  summaries: SessionListState['byId'],
): SessionId[] {
  return sessionIds.flatMap((id) => {
    const summary = summaries[id]
    if (summary === undefined) return []
    return [{ id, rank: summary.updatedAt }]
  })
    .sort((a, b) => {
      if (a.rank !== b.rank) return b.rank - a.rank
      return a.id < b.id ? -1 : 1
    })
    .map(member => member.id)
}

/**
 * Reconcile a browser-local manual order with current account membership.
 * Saved entries retain their relative order; new ordinary members follow them by recency.
 * @param memberIds - authoritative account membership.
 * @param savedOrder - previously saved browser-local order.
 * @param summaries - current Session metadata; unknown new members wait for their summaries.
 * @param rowState - global pin and archive membership; only account members can supplement the order.
 * @returns saved relative positions plus missing members ordered by pin, recency, and archive status.
 */
export function reconcileManualOrder(
  memberIds: readonly SessionId[],
  savedOrder: readonly string[] | undefined,
  summaries: SessionListState['byId'],
  rowState?: Pick<SessionRowState, 'pinnedSessionIds' | 'archivedSessionIds'>,
): SessionId[] {
  const members = new Map(memberIds.map(id => [id as string, id]))
  const included = new Set<string>()
  const ordered: SessionId[] = []
  for (const key of savedOrder ?? []) {
    const id = members.get(key)
    if (id === undefined || included.has(key)) continue
    ordered.push(id)
    included.add(key)
  }
  const archived = new Set(rowState?.archivedSessionIds)
  const pins: SessionId[] = []
  for (const sessionId of rowState?.pinnedSessionIds ?? []) {
    const id = members.get(sessionId)
    if (id === undefined || included.has(id) || archived.has(id) || summaries[id] === undefined) continue
    pins.push(id)
    included.add(id)
  }
  const ordinary: SessionId[] = []
  const archives: SessionId[] = []
  for (const id of orderByRecency([...members.values()].filter(id => !included.has(id)), summaries)) {
    if (archived.has(id)) archives.push(id)
    else ordinary.push(id)
  }
  return [...pins, ...ordered, ...ordinary, ...archives]
}

/**
 * Keep the selected provisional New Session ahead of either base order.
 * @param order - recency or reconciled manual order.
 * @param currentBlank - selected blank Session in this account, when present.
 * @returns a copy with the selected blank first and no duplicate slot.
 */
export function pinCurrentBlank(
  order: readonly SessionId[],
  currentBlank: SessionId | undefined,
): SessionId[] {
  if (currentBlank === undefined) return [...order]
  return [currentBlank, ...order.filter(id => id !== currentBlank)]
}

/**
 * Archived-row visibility choice: the default hides archived rows, `show`
 * mixes them into their kept slots, and `only` restricts the view (and
 * search) to archived rows.
 */
export type ArchivedFilter = 'default' | 'show' | 'only'

/**
 * Ordinary sessions are visible; among blank sessions, only the current one
 * is visible. Subagent children use their parent header catalog; archived
 * sessions follow the archived filter, while their accounting slots remain
 * either way so unarchiving restores position.
 */
function sessionVisible(
  session: SessionSummary,
  current: SessionId | undefined,
  archived: ReadonlySet<SessionId>,
  archivedFilter: ArchivedFilter,
): boolean {
  if (session.origin === 'subagent') return false
  if (session.blank && session.id !== current) return false
  switch (archivedFilter) {
    case 'default':
      return !archived.has(session.id)
    case 'show':
      return true
    case 'only':
      return archived.has(session.id)
    /* v8 ignore next 2 -- closed-union backstop; only reached if the filter is forged */
    default:
      return assertNever(archivedFilter)
  }
}

/** Registry-global row state consumed by every tree derivation. */
export interface SessionRowState {
  /** Registry-global pin ids; pinned rows lead their section in the local order. */
  pinnedSessionIds: readonly SessionId[]
  /** Archive set; members keep their slots and show grayed while visible. */
  archivedSessionIds: readonly SessionId[]
  /** Archived-row visibility choice applied to lists and search alike. */
  archivedFilter: ArchivedFilter
}

/**
 * Keep the visible New Session placeholder first, then partition pinned and
 * ordinary rows without changing either partition's caller order.
 */
function sectionMembers(
  members: readonly SessionSummary[],
  pinned: ReadonlySet<SessionId>,
  archived: ReadonlySet<SessionId>,
): SessionSummary[] {
  const placeholders: SessionSummary[] = []
  const leading: SessionSummary[] = []
  const rest: SessionSummary[] = []
  for (const member of members) {
    if (member.blank) placeholders.push(member)
    else if (!archived.has(member.id) && pinned.has(member.id)) leading.push(member)
    else rest.push(member)
  }
  return [...placeholders, ...leading, ...rest]
}

/**
 * A blank session is the selected Workspace's provisional New Session row;
 * its canonical title never enters search (blank rows are query-excluded)
 * and the renderer localizes its display label. Unnamed history also yields an
 * empty title for localization and does not match a directory-name title search.
 */
function sessionTitle(session: SessionSummary): string {
  return session.blank ? '' : (session.title?.trim() ?? '')
}

/**
 * Folded-group activity: an expanded group shows every row's own status dot, so
 * the header icon reports activity only while those rows are off screen.
 * @param sessions - the group's visible member summaries.
 * @param descendants - running subagent descendant counts by ancestor.
 * @param expanded - whether the group's rows are on screen.
 * @returns whether the folded group holds a Session that runs or has a running descendant.
 */
function groupRunning(
  sessions: readonly SessionSummary[],
  descendants: RunningDescendants,
  expanded: boolean,
): boolean {
  if (expanded) return false
  return sessions.some(s => s.running || (descendants.get(s.id) ?? 0) > 0)
}

/**
 * Folded-group completion reminder: an expanded group shows every row's own
 * done dot, so the header icon reports the reminder only while those rows are
 * off screen. Subagent children never count — they are absent from the group's
 * visible members, and the hidden row's reminder is the only fact to carry.
 * @param sessions - the group's visible member summaries.
 * @param statuses - unified UI status by Session.
 * @param expanded - whether the group's rows are on screen.
 * @returns whether the folded group holds a finished-but-unviewed Session.
 */
function groupCompletedUnread(
  sessions: readonly SessionSummary[],
  statuses: SessionStatuses,
  expanded: boolean,
): boolean {
  if (expanded) return false
  return sessions.some(s => statuses.get(s.id)?.completionUnread === true)
}

/** Build one group without projecting session lineage into presentation. */
function buildGroup(
  key: string,
  workspaceId: WorkspaceId | undefined,
  cwd: string | undefined,
  createdAt: number | undefined,
  label: string,
  members: readonly SessionSummary[],
): Group {
  return { key, workspaceId, cwd, createdAt, label, sessions: [...members] }
}

/** Apply a stored Ungrouped order and append newly loose Sessions by recency. */
function orderedUngrouped(
  members: readonly SessionSummary[],
  stored: readonly string[] | undefined,
  summaries: SessionListState['byId'],
): SessionSummary[] {
  const byId = new Map(members.map(session => [session.id as string, session]))
  const ids = stored === undefined
    ? orderByRecency(members.map(session => session.id), summaries)
    : reconcileManualOrder(members.map(session => session.id), stored, summaries)
  return ids.flatMap((id) => {
    const session = byId.get(id)
    /* v8 ignore next -- ids are projected exclusively from the members used to build byId. */
    return session === undefined ? [] : [session]
  })
}

/**
 * Group Sessions by Workspace: one group per caller-ordered entity, with
 * members resolved from caller-ordered sessionIds. Sessions outside every
 * Workspace trail in the browser-local Ungrouped order, which falls back to
 * recency before that order is initialized.
 */
function groupByWorkspace(
  list: SessionListState,
  workspaces: readonly WorkspaceView[],
  archived: ReadonlySet<SessionId>,
  archivedFilter: ArchivedFilter,
  ungroupedOrder: readonly string[] | undefined,
): Group[] {
  const current = mainSessionId(list)
  const groups: Group[] = []
  const accounted = new Set<SessionId>()
  for (const workspace of workspaces) {
    const members: SessionSummary[] = []
    for (const id of workspace.sessionIds) {
      const summary = list.byId[id]
      if (summary === undefined) continue // account may lead the list pull; the row appears when the summary lands
      accounted.add(id)
      if (!sessionVisible(summary, current, archived, archivedFilter)) continue
      members.push(summary)
    }
    // The archived-only view lists archives, not the Workspace inventory, so
    // a Workspace without archived Sessions contributes no group.
    if (archivedFilter === 'only' && members.length === 0) continue
    groups.push(buildGroup(
      workspace.workspaceId, workspace.workspaceId, workspace.path,
      Date.parse(workspace.createdAt), workspace.title, members,
    ))
  }
  const stray = list.ids
    .map(id => list.byId[id])
    .filter((s): s is SessionSummary =>
      s !== undefined && !accounted.has(s.id) && sessionVisible(s, current, archived, archivedFilter))
  if (stray.length > 0) {
    groups.push(buildGroup(
      UNGROUPED_KEY,
      undefined,
      undefined,
      undefined,
      '',
      orderedUngrouped(stray, ungroupedOrder, list.byId),
    ))
  }
  return groups
}

/** Keep navigation presentation independent from domain-owned interaction objects. */
function visiblePendingKind(kind: string | undefined): SessionPendingInteractionStatus | undefined {
  switch (kind) {
    case 'approval':
    case 'plan-review':
    case 'question':
      return kind
    default:
      return undefined
  }
}

/** Running subagent descendants of one Session, keyed for every Session that has at least one. */
export type RunningDescendants = ReadonlyMap<SessionId, number>

/** One iteration state of the explicit-lineage walk: the Session being descended and its cursor. */
interface LineageFrame {
  readonly id: SessionId
  readonly rows: readonly SessionId[]
  next: number
}

/** Whether one Session runs, per the unified status map with the summary bit as fallback. */
export function sessionIsRunning(list: SessionListState, statuses: SessionStatuses, id: SessionId): boolean {
  return (statuses.get(id)?.running ?? list.byId[id]?.running) === true
}

/**
 * Count running subagent descendants of every Session, at any depth, in one
 * post-order pass over durable lineage: a child row whose `origin` is
 * `subagent` holds its parent whether or not that parent's catalog is loaded,
 * while a fork shares `parentId` without the origin and never counts. Lineage
 * is read as data, so a cycle visits each Session once instead of looping.
 * @param list - sessions list snapshot carrying lineage and rows.
 * @param statuses - unified UI status by Session; absent entries fall back to the summary bit.
 * @returns each ancestor's running descendant count, omitting Sessions with none.
 */
export function runningDescendantCounts(list: SessionListState, statuses: SessionStatuses): RunningDescendants {
  const children = new Map<SessionId, SessionId[]>()
  for (const id of Object.keys(list.byId) as SessionId[]) {
    const row = list.byId[id]
    const parentId = row?.parentId
    if (row?.origin !== 'subagent' || parentId === undefined || parentId === id) continue
    const siblings = children.get(parentId)
    if (siblings === undefined) children.set(parentId, [id])
    else siblings.push(id)
  }
  const counts = new Map<SessionId, number>()
  if (children.size === 0) return counts
  // Only a Session with child edges holds a running descendant, so every
  // ancestor is reachable from one of these roots. An explicit stack keeps a
  // delegation chain of any configured depth off the call stack.
  const visited = new Set<SessionId>()
  const frames: LineageFrame[] = []
  for (const [rootId, rootRows] of children) {
    if (visited.has(rootId)) continue
    visited.add(rootId)
    frames.push({ id: rootId, rows: rootRows, next: 0 })
    while (frames.length > 0) {
      // Every pushed frame is removed exactly once, and the loop condition
      // guarantees a top frame; the cast states that rather than re-testing it.
      const frame = frames[frames.length - 1] as LineageFrame
      if (frame.next < frame.rows.length) {
        const childId = frame.rows[frame.next] as SessionId
        frame.next += 1
        // A child already on this stack closes a lineage loop; it is visited
        // once and contributes no separate row, so skip the descent.
        if (!visited.has(childId)) {
          visited.add(childId)
          frames.push({ id: childId, rows: children.get(childId) ?? [], next: 0 })
        }
        continue
      }
      frames.pop()
      let total = 0
      for (const childId of frame.rows) {
        total += (counts.get(childId) ?? 0) + (sessionIsRunning(list, statuses, childId) ? 1 : 0)
      }
      if (total > 0) counts.set(frame.id, total)
    }
  }
  return counts
}

/**
 * Project one Session's row from the current snapshots: the list's own label,
 * recency and directory, plus the pin, archive, live and completion bits every
 * browsing surface shows. The tree and the In work folds both read rows through
 * this one projection, so a Session carries identical state wherever it lists.
 * @param s - the Session's list row.
 * @param statuses - unified UI status by Session.
 * @param descendants - running subagent descendant counts by ancestor.
 * @param pinned - registry-global pin set.
 * @param archived - registry-global archive set.
 * @returns the row facts the browsing surfaces render.
 */
export function sessionNode(
  s: SessionSummary,
  statuses: SessionStatuses,
  descendants: RunningDescendants,
  pinned: ReadonlySet<SessionId>,
  archived: ReadonlySet<SessionId>,
): SessionNode {
  const status = statuses.get(s.id)
  const pendingInteraction = visiblePendingKind(status?.pendingInteraction?.kind)
  return {
    id: s.id,
    title: sessionTitle(s),
    blank: s.blank,
    running: status?.running ?? s.running,
    runningSubagentCount: descendants.get(s.id) ?? 0,
    completed: status?.completionUnread === true,
    pinned: !archived.has(s.id) && pinned.has(s.id),
    archived: archived.has(s.id),
    updatedAt: s.updatedAt,
    ...(s.cwd === undefined || s.cwd === '' ? {} : { cwd: s.cwd }),
    ...(pendingInteraction === undefined ? {} : { pendingInteraction }),
  }
}

/**
 * Derive the workspace browser groups with every session as a top-level row.
 *
 * Every group shows, except that the archived-only filter drops groups
 * without visible members; sessions populate under expanded groups with
 * pinned rows leading in the selected local order. Blank sessions are
 * excluded except for the selected provisional New Session row; archived
 * sessions keep their slots and appear per the archived filter. Content
 * search lives outside this derivation (see {@link deriveSearchResults}).
 * @param list - sessions list snapshot (`mainView` retention feeds containsCurrent).
 * @param workspaces - real Workspaces in Host group order with caller-projected Session order.
 * @param rowState - registry-global pin and archive sets plus the archived filter.
 * @param statuses - unified UI status by Session.
 * @param view - local expansion arrays.
 * @returns group sections in render order.
 */
export function deriveGroups(
  list: SessionListState,
  workspaces: readonly WorkspaceView[],
  rowState: SessionRowState,
  statuses: SessionStatuses,
  view: TreeView,
): GroupNode[] {
  const archived = new Set(rowState.archivedSessionIds)
  const pinned = new Set(rowState.pinnedSessionIds)
  const expandedGroups = new Set(view.expandedGroups)
  const current = mainSessionId(list)
  const descendants = runningDescendantCounts(list, statuses)
  const currentGroup = current === undefined
    ? undefined
    : owningGroupKey(workspaces, current)
  const groups: GroupNode[] = []
  for (const g of groupByWorkspace(list, workspaces, archived, rowState.archivedFilter, view.ungroupedOrder)) {
    const expanded = expandedGroups.has(g.key)
    groups.push({
      key: g.key,
      workspaceId: g.workspaceId,
      cwd: g.cwd,
      createdAt: g.createdAt,
      label: g.label,
      sessionCount: g.sessions.length,
      expanded,
      containsCurrent: g.key === currentGroup,
      running: groupRunning(g.sessions, descendants, expanded),
      completedUnread: groupCompletedUnread(g.sessions, statuses, expanded),
      sessions: expanded
        ? sectionMembers(g.sessions, pinned, archived)
          .map(session => sessionNode(session, statuses, descendants, pinned, archived))
        : [],
    })
  }
  return groups
}

/**
 * Select complete flat-list membership, independently of archive visibility.
 * @param list - sessions list snapshot.
 * @returns known ordinary Session ids, including archives and only the current blank.
 */
export function sessionMemberIds(list: SessionListState): SessionId[] {
  return visibleSessionIds(list, [], 'show')
}

/**
 * Select visible flat-list members without deriving row presentation or ordering.
 * @param list - sessions list snapshot.
 * @param archivedSessionIds - registry-global archive set.
 * @param archivedFilter - archived-row visibility choice.
 * @returns known visible Session ids in list order, including ordinary forks and only the current blank.
 */
export function visibleSessionIds(
  list: SessionListState,
  archivedSessionIds: readonly SessionId[],
  archivedFilter: ArchivedFilter,
): SessionId[] {
  const archived = new Set(archivedSessionIds)
  const current = mainSessionId(list)
  return list.ids.filter((id) => {
    const s = list.byId[id]
    return s !== undefined && sessionVisible(s, current, archived, archivedFilter)
  })
}

/**
 * Derive flat rows from the browser's complete ordered Session ids, with
 * pinned rows fronted ahead of the supplied order.
 * @param list - sessions list snapshot used to select the ids.
 * @param sessionIds - complete account members in the selected order, including hidden archives.
 * @param rowState - registry-global pin and archive sets plus the archived filter.
 * @param statuses - unified UI status by Session.
 * @returns flat rows in sectioned order with current status indicators.
 */
export function deriveFlat(
  list: SessionListState,
  sessionIds: readonly SessionId[],
  rowState: SessionRowState,
  statuses: SessionStatuses,
): SessionNode[] {
  const archived = new Set(rowState.archivedSessionIds)
  const pinned = new Set(rowState.pinnedSessionIds)
  const current = mainSessionId(list)
  const descendants = runningDescendantCounts(list, statuses)
  const members = sessionIds.flatMap((id) => {
    const session = list.byId[id]
    return session !== undefined && sessionVisible(session, current, archived, rowState.archivedFilter)
      ? [session]
      : []
  })
  return sectionMembers(members, pinned, archived)
    .map(session => sessionNode(session, statuses, descendants, pinned, archived))
}

/**
 * Merge immediate title/Workspace/Session id substring matches with ranked Host content
 * matches. Local rows lead newest-first, content-only rows retain backend
 * order, and duplicate sessions receive the backend snippet in place.
 * @param list - session metadata authority.
 * @param workspaces - Workspace membership and display labels.
 * @param query - caller text; surrounding whitespace is ignored.
 * @param archivedSessionIds - registry-global archive set (members match per the archived filter).
 * @param archivedFilter - archived-row visibility choice; search follows it.
 * @param statuses - unified UI status by Session.
 * @param content - ranked Host content-search page.
 * @param limit - protocol-owned maximum merged row count.
 * @returns bounded deduplicated flat rows and a refine-query hint bit.
 */
export function deriveSearchResults(
  list: SessionListState,
  workspaces: readonly WorkspaceView[],
  query: string,
  archivedSessionIds: readonly SessionId[],
  archivedFilter: ArchivedFilter,
  statuses: SessionStatuses,
  content: { items: readonly SessionSearchResultItem[]; hasMore: boolean },
  limit: number,
): SearchResultSet {
  const q = query.trim().toLowerCase()
  if (q === '') return { items: [], hasMore: false }
  const archived = new Set(archivedSessionIds)
  const current = mainSessionId(list)
  const descendants = runningDescendantCounts(list, statuses)

  const workspaceBySession = new Map<SessionId, string>()
  for (const workspace of workspaces) {
    for (const sessionId of workspace.sessionIds) {
      if (!workspaceBySession.has(sessionId)) workspaceBySession.set(sessionId, workspace.title)
    }
  }
  const labelOf = (summary: SessionSummary): string =>
    workspaceBySession.get(summary.id) ?? workspaceLabel(summary.cwd)
  const contentBySession = new Map<SessionId, SessionSearchResultItem>()
  for (const item of content.items) {
    if (!contentBySession.has(item.sessionId)) contentBySession.set(item.sessionId, item)
  }

  const local: SessionSummary[] = []
  for (const id of list.ids) {
    const summary = list.byId[id]
    // Blank placeholders never match a query (their canonical title displays
    // localized, so matching it would tie search to one language).
    if (summary === undefined || summary.blank || !sessionVisible(summary, current, archived, archivedFilter)) continue
    if (
      sessionTitle(summary).toLowerCase().includes(q)
      || labelOf(summary).toLowerCase().includes(q)
      || summary.id.toLowerCase().includes(q)
    ) {
      local.push(summary)
    }
  }
  const localById = new Map(local.map(summary => [summary.id, summary]))
  const orderedLocal = orderByRecency(local.map(summary => summary.id), list.byId)
    .map(id => localById.get(id) as SessionSummary)

  const ordered: SessionSummary[] = []
  const included = new Set<SessionId>()
  const include = (summary: SessionSummary): void => {
    if (included.has(summary.id)) return
    included.add(summary.id)
    ordered.push(summary)
  }
  for (const summary of orderedLocal) include(summary)
  for (const item of content.items) {
    const summary = list.byId[item.sessionId]
    if (summary !== undefined && !summary.blank && sessionVisible(summary, current, archived, archivedFilter)) include(summary)
  }

  return {
    items: ordered.slice(0, limit).map((summary) => {
      const match = contentBySession.get(summary.id)
      const status = statuses.get(summary.id)
      const pendingInteraction = visiblePendingKind(status?.pendingInteraction?.kind)
      return {
        id: summary.id,
        title: sessionTitle(summary),
        workspace: labelOf(summary),
        running: status?.running ?? summary.running,
        runningSubagentCount: descendants.get(summary.id) ?? 0,
        ...(pendingInteraction === undefined
          ? {}
          : { pendingInteraction }),
        completed: status?.completionUnread === true,
        archived: archived.has(summary.id),
        ...match === undefined ? {} : { snippet: match.snippet },
      }
    }),
    hasMore: content.hasMore || ordered.length > limit,
  }
}

/** Normalize separators for comparison without interpreting POSIX backslashes as separators. */
function folderPath(path: string): string {
  const windows = /^[A-Za-z]:[/\\]/.test(path) || path.startsWith('\\\\')
  return (windows ? path.replaceAll('\\', '/') : path).replace(/\/+$/, '')
}

/**
 * Find the nearest registered ancestor, excluding the Workspace directory itself.
 * Paths use Host spelling; matching is case-sensitive, like Workspace identity.
 * @param path - Workspace directory.
 * @param parents - registered Workspace directory paths.
 * @returns the owning parent path, or undefined when no parent contains the Workspace.
 */
export function owningParentFolder(path: string, parents: readonly string[]): string | undefined {
  const child = folderPath(path)
  let owner: string | undefined
  let length = -1
  for (const parent of parents) {
    const root = folderPath(parent)
    if (root.length > length && child !== root && child.startsWith(`${root}/`)) {
      owner = parent
      length = root.length
    }
  }
  return owner
}
