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
 * - `ctx.uiSession.sessionStatus` — `running` and `completionUnread` per
 *   Session. The status wins over the row's own `running` (the row value is
 *   only a display fallback for a Session whose baseline never arrived), which
 *   is exactly the fold `ui-workspace` uses for its rows.
 *
 * `running` and `completionUnread` are mutually exclusive in practice (the host
 * deletes the reminder when work starts again); a row carrying both is reported
 * as running, because "still working" is the more actionable fact.
 *
 * Blank rows are skipped too: `blank` is the reusable New-Session placeholder,
 * and the host clears it the moment the Session runs or is prompted — so no
 * running and no finished session is ever hidden by this filter.
 */
import type { SessionListState } from '@deepseek-ai/dsh-api-session-controller/client'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { SessionStatusSnapshot } from '@deepseek-ai/dsh-client-ui-session/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'

/** One listed Session: enough to label a row and jump to it. */
export interface AttentionRow {
  readonly id: SessionId
  /** Human-facing label, straight from the list row (`displayTitle`). */
  readonly title: string
}

/** The whole panel content: two sections, newest first, plus their sum. */
export interface AttentionModel {
  /** Sessions the host reports as running. */
  readonly running: readonly AttentionRow[]
  /** Ordinary Sessions that finished while they were not the main view. */
  readonly unread: readonly AttentionRow[]
  /** Badge number: `running.length + unread.length`. */
  readonly total: number
}

/** Session list source (`ctx.sessions.list`). */
export type AttentionListSource = ObservableSnapshot<SessionListState>
/** Session status source (`ctx.uiSession.sessionStatus`). */
export type AttentionStatusSource = ObservableSnapshot<SessionStatusSnapshot>

/** One classified row before ordering: the row plus the timestamp that ranks it. */
interface Candidate {
  readonly updatedAt: number
  readonly row: AttentionRow
}

/**
 * Newest first. The sort is stable, so equal timestamps keep Host list order —
 * candidates are pushed in `list.ids` order.
 */
function byRecency(left: Candidate, right: Candidate): number {
  return right.updatedAt - left.updatedAt
}

/**
 * Fold one list snapshot and one status snapshot into the panel's content:
 * the running and finished-unread sections, each newest first.
 */
export function deriveAttention(
  list: SessionListState,
  status: SessionStatusSnapshot,
): AttentionModel {
  const running: Candidate[] = []
  const unread: Candidate[] = []
  list.ids.forEach((id) => {
    const row = list.byId[id]
    // An id may be listed before the Host projects its row (nothing to label).
    if (row === undefined) return
    // Subagent children never appear; the New-Session placeholder is not task work.
    if (row.origin === 'subagent' || row.blank) return
    const entry = status.get(id)
    const candidate: Candidate = { updatedAt: row.updatedAt, row: { id, title: row.displayTitle } }
    if (entry?.running ?? row.running) {
      running.push(candidate)
      return
    }
    if (entry?.completionUnread === true) unread.push(candidate)
  })
  const runningRows = running.sort(byRecency).map(candidate => candidate.row)
  const unreadRows = unread.sort(byRecency).map(candidate => candidate.row)
  return { running: runningRows, unread: unreadRows, total: runningRows.length + unreadRows.length }
}

/**
 * Comparable form of one section. Equality is decided on content, never on
 * object identity, so a source notification that does not actually change the
 * panel keeps the previous snapshot object — `useSyncExternalStore` re-renders
 * on identity, and an unrelated list update must not cost a render.
 */
function sectionKey(rows: readonly AttentionRow[]): string {
  return rows.map(row => `${row.id}\u0000${row.title}`).join('\u0001')
}

/** Whether two models would render identically. */
function sameModel(left: AttentionModel, right: AttentionModel): boolean {
  return sectionKey(left.running) === sectionKey(right.running)
    && sectionKey(left.unread) === sectionKey(right.unread)
}

/** Read-only view of the current panel content, plus the plugin's disposer. */
export interface AttentionStore extends ObservableSnapshot<AttentionModel> {
  /** Release both source subscriptions and drop every listener. */
  dispose(): void
}

/**
 * Keep the attention model in step with both sources.
 *
 * Subscribes eagerly: the entry is registered unconditionally, so there is no
 * lazy window to preserve. The caller owns the lifetime through {@link
 * AttentionStore.dispose}.
 */
export function createAttentionStore(
  list: AttentionListSource,
  status: AttentionStatusSource,
): AttentionStore {
  const listeners = new Set<() => void>()
  let model = deriveAttention(list.getSnapshot(), status.getSnapshot())
  const recompute = (): void => {
    const next = deriveAttention(list.getSnapshot(), status.getSnapshot())
    if (sameModel(next, model)) return
    model = next
    for (const listener of [...listeners]) listener()
  }
  const unsubscribeList = list.subscribe(recompute)
  const unsubscribeStatus = status.subscribe(recompute)
  return {
    getSnapshot: () => model,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    dispose: () => {
      unsubscribeList()
      unsubscribeStatus()
      listeners.clear()
    },
  }
}
