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
 *   its rows.
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
 */
import type {
  SessionListState, SessionProjectionSnapshot,
} from '@deepseek-ai/dsh-api-session-controller/client'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { SessionStatusSnapshot } from '@deepseek-ai/dsh-client-ui-session/client'
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
   * panel counts from it. Absent until the projection has been read, and for
   * the `unread` rows, whose work has already stopped.
   */
  readonly lastPromptAt?: number
}

/** The whole panel content: two sections, newest first, plus their sum. */
export interface AttentionModel {
  /** Sessions the host reports as running. */
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
 * The durable prompt time one list row carries, when its projection has been
 * read. The row's `projectionValues` is a `Partial`, so absence is the normal
 * pre-read state, not an error.
 */
function lastPromptAtOf(projections: SessionProjectionSnapshot | undefined): number | undefined {
  return projections?.values.sessionListMetadata?.lastPromptAt ?? undefined
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
 * the running and finished-unread sections, each newest first, plus the listed
 * subset of them whose work is blocked on the user.
 */
export function deriveAttention(
  list: SessionListState,
  status: SessionStatusSnapshot,
): AttentionModel {
  const running: Candidate[] = []
  const unread: Candidate[] = []
  const waiting: Candidate[] = []
  list.ids.forEach((id) => {
    const row = list.byId[id]
    // An id may be listed before the Host projects its row (nothing to label).
    if (row === undefined) return
    // Subagent children never appear; the New-Session placeholder is not task work.
    if (row.origin === 'subagent' || row.blank) return
    const entry = status.get(id)
    // A pending interaction is a live Host request holding the turn open, so a
    // blocked Session is running and has already joined the running section; a
    // reminder it never cleared lands here the same way. Each branch records the
    // row in `waiting` beside that section, which is what keeps the outline from
    // ever reporting a state the panel has no row for.
    const blocked = entry?.pendingInteraction !== undefined
    const isRunning = entry?.running ?? row.running
    // The run the row is in started with the latest human prompt, a durable
    // fact the list projection already carries: counting from it needs no
    // client-side timer of the plugin's own.
    const lastPromptAt = lastPromptAtOf(list.projectionsBySession[id])
    if (isRunning) {
      const candidate: Candidate = {
        updatedAt: row.updatedAt,
        row: lastPromptAt === undefined
          ? { id, title: row.displayTitle }
          : { id, title: row.displayTitle, lastPromptAt },
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
 * Comparable form of one section. Equality is decided on content, never on
 * object identity, so a source notification that does not actually change the
 * panel keeps the previous snapshot object — `useSyncExternalStore` re-renders
 * on identity, and an unrelated list update must not cost a render.
 *
 * The prompt time rides the same comparison: it moves only when the user
 * prompts again, which is exactly a new run and a new count.
 */
function sectionKey(rows: readonly AttentionRow[]): string {
  return rows.map(row => `${row.id}\u0000${row.title}\u0000${row.lastPromptAt ?? ''}`).join('\u0001')
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
    // A listener may unsubscribe itself mid-loop, so iterate over a snapshot:
    // the spread is the point, not a wasted copy.
    // oxlint-disable-next-line unicorn/no-useless-spread
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

/**
 * The wall-clock time one listed run has been going, in ms, counted from the
 * latest human prompt to `now`. `undefined` before the projection has been
 * read — the row renders without a duration until the number exists.
 */
export function runElapsed(row: AttentionRow, now: number): number | undefined {
  if (row.lastPromptAt === undefined) return undefined
  return Math.max(0, now - row.lastPromptAt)
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
