/**
 * Session list and status doubles for the app-badge specs. The finished-unread
 * fact lives on the host's status snapshot, which the host derives from the
 * list, so these fixtures carry it as a `completed` flag on the row and project
 * it the same way.
 */
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { SessionListState, SessionSummary } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionStatus, SessionStatusSnapshot } from '@deepseek-ai/dsh-client-ui-session/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'

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
  return new Map(rows.filter(row => row.completed === true).map(row => [row.id, {
    running: undefined, pendingInteraction: undefined, completionUnread: true,
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
  readonly list: ReturnType<typeof createSnapshotStore<SessionListState>>
  readonly status: ReturnType<typeof createSnapshotStore<SessionStatusSnapshot>>
  update(recipe: (state: SessionListState) => void): void
}

/**
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
