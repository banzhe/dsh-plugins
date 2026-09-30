/**
 * Session list and status doubles for the attention specs.
 *
 * The two facts the panel needs live on two different host snapshots — the rows
 * on the list, the running/unread state on the status map — so these fixtures
 * carry both and project them the same way the host does: `update` writes the
 * list and re-derives the status from the result.
 */
import type { SessionListState, SessionSummary } from '@deepseek-ai/dsh-api-session-controller/client'
import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { SessionStatus, SessionStatusSnapshot } from '@deepseek-ai/dsh-client-ui-session/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'

/** A list row with the finished-unread fact the host keeps on the status map. */
export type SessionRow = SessionSummary & { completed?: boolean }

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

export function sessionStatusOf(rows: readonly SessionRow[]): SessionStatusSnapshot {
  return new Map(rows.map(row => [row.id, {
    running: row.running,
    pendingInteraction: undefined,
    completionUnread: row.completed === true,
  } satisfies SessionStatus]))
}

export function sessionListOf(rows: readonly SessionRow[]): SessionListState {
  return {
    ids: rows.map(row => row.id),
    byId: Object.fromEntries(rows.map(row => [row.id, row])),
    phase: 'ready',
    projectionsBySession: {},
  }
}

export interface SessionSources {
  readonly list: SnapshotStore<SessionListState>
  readonly status: SnapshotStore<SessionStatusSnapshot>
  update(recipe: (state: SessionListState) => void): void
}

/**
 * The two sources plus the `update` writer.
 *
 * `update` writes the list and re-derives the status from the result, which is
 * the order the host publishes in.
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
