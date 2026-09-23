/**
 * Session list and status doubles for the app-badge specs. The finished-unread
 * fact lives on the host's status snapshot, which the host derives from the
 * list, so these fixtures carry it as a `completed` flag on the row and project
 * it the same way — one rule, shared by every spec that drives the presenter.
 */
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { SessionListState, SessionSummary } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionStatus, SessionStatusSnapshot } from '@deepseek-ai/dsh-client-ui-session/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'

/** One list row plus the fixture-only `completed` flag the status snapshot is derived from. */
export type SessionRow = SessionSummary & { completed?: boolean }

/**
 * Build one list row.
 * @param id - the row's session id, and its display title unless overridden.
 * @param over - the facts one spec is actually about.
 * @returns a row with every published `SessionSummary` member populated.
 */
export function sessionRow(id: string, over: Partial<SessionRow> = {}): SessionRow {
  return {
    id: id as SessionId,
    displayTitle: id,
    running: false,
    blank: false,
    updatedAt: 1,
    retainedBy: {},
    ...over,
  }
}

/**
 * The finished-unread facts these rows imply: a row's `completed` flag becomes
 * `completionUnread` on its status entry.
 * @param rows - the rows to project.
 * @returns the status snapshot the host would publish for these rows.
 */
export function sessionStatusOf(rows: readonly SessionRow[]): SessionStatusSnapshot {
  return new Map(rows.filter(row => row.completed === true).map(row => [row.id, {
    running: undefined, pendingInteraction: undefined, completionUnread: true,
  } satisfies SessionStatus]))
}

/**
 * The list snapshot these rows imply.
 * @param rows - the rows to project, in host list order.
 * @returns a snapshot listing every row in both `ids` and `byId`.
 */
export function sessionListOf(rows: readonly SessionRow[]): SessionListState {
  return {
    ids: rows.map(row => row.id),
    byId: Object.fromEntries(rows.map(row => [row.id, row])),
    phase: 'ready',
    projectionsBySession: {},
  }
}

/** A list store paired with the status store the host derives from it. */
export interface SessionSources {
  /** The sessions list snapshot source. */
  readonly list: ReturnType<typeof createSnapshotStore<SessionListState>>
  /** The status snapshot source derived from the list. */
  readonly status: ReturnType<typeof createSnapshotStore<SessionStatusSnapshot>>
  /**
   * Mutate the list, then re-derive the status snapshot from the written rows.
   * @param recipe - the list mutation, applied to a draft in place.
   */
  update(recipe: (state: SessionListState) => void): void
}

/**
 * Pair a list store with the status store the host would derive from it.
 * `update` writes the list and re-derives the status from the result, which is
 * the order the host publishes in.
 * @param rows - the initial rows.
 * @returns both sources, plus the mutator that keeps them consistent.
 */
export function sessionSources(rows: readonly SessionRow[] = []): SessionSources {
  const list = createSnapshotStore<SessionListState>(sessionListOf(rows))
  const status = createSnapshotStore<SessionStatusSnapshot>(sessionStatusOf(rows))
  return {
    list,
    status,
    update(recipe: (state: SessionListState) => void): void {
      list.update(recipe)
      const snapshot = list.getSnapshot()
      // An id may be listed without a row (the host does this for a Session it
      // has not projected yet), which the fold then skips.
      const written = snapshot.ids
        .map(id => snapshot.byId[id])
        .filter((row): row is SessionRow => row !== undefined)
      status.set(sessionStatusOf(written))
    },
  }
}
