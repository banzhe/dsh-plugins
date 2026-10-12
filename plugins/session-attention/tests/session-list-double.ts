/**
 * Session list and status doubles for the attention specs.
 *
 * The two facts the panel needs live on two different host snapshots — the rows
 * on the list, the running/unread state on the status map — so these fixtures
 * carry both and project them the same way the host does: `update` writes the
 * list and re-derives the status from the result.
 */
import type { SessionListState, SessionProjectionSnapshot, SessionSummary } from '@deepseek-ai/dsh-api-session-controller/client'
import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { SessionStatus, SessionStatusSnapshot } from '@deepseek-ai/dsh-client-ui-session/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'

/** A list row with the two status facts the host keeps off the list row. */
export type SessionRow = SessionSummary & {
  completed?: boolean
  blocked?: boolean
  /** The durable prompt time the metadata projection reports, when read. */
  lastPromptAt?: number | null
}

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

/** The projection snapshot one row's `lastPromptAt` fact shapes. */
function projectionOf(row: SessionRow): SessionProjectionSnapshot {
  return {
    state: 'ready',
    error: null,
    values: row.lastPromptAt === undefined ? {} : {
      // Wire shape of the `sessionListMetadata` projection view.
      sessionListMetadata: { blank: false, lastPromptAt: row.lastPromptAt },
    },
  }
}

/**
 * The host's pending-interaction value for one Session. Only its presence is a
 * fact this plugin reads, so the double carries the base shape the merged map
 * falls back to and never pretends to know a domain's payload.
 */
function pendingOf(id: SessionId): SessionStatus['pendingInteraction'] {
  return { key: `pending:${id}`, kind: 'question', sessionId: id }
}

/**
 * One status entry with only the fields this plugin reads.
 * (Lives here beside the row factories that need the same shape.)
 */
export function statusOf(running: boolean | undefined, completed: boolean): SessionStatus {
  return { running, pendingInteraction: undefined, completionUnread: completed }
}

export function sessionStatusOf(rows: readonly SessionRow[]): SessionStatusSnapshot {
  return new Map(rows.map(row => [row.id, {
    running: row.running,
    pendingInteraction: row.blocked === true ? pendingOf(row.id) : undefined,
    completionUnread: row.completed === true,
  } satisfies SessionStatus]))
}

export function sessionListOf(rows: readonly SessionRow[]): SessionListState {
  return {
    ids: rows.map(row => row.id),
    byId: Object.fromEntries(rows.map(row => [row.id, row])),
    phase: 'ready',
    projectionsBySession: Object.fromEntries(rows.map(row => [row.id, projectionOf(row)])),
  }
}

export interface SessionSources {
  readonly list: SnapshotStore<SessionListState>
  readonly status: SnapshotStore<SessionStatusSnapshot>
  update(recipe: (state: SessionListState) => void): void
  /**
   * Republish the list draft as-is. Unlike `update`, this does not rebuild
   * projections or rewrite status, so a row can be published again while
   * `sessionListMetadata` stays absent.
   */
  publish(recipe: (state: SessionListState) => void): void
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
      // Copy first: the recipe mutates, and publishing the live snapshot in
      // place would notify once before the projection is rebuilt.
      const current = list.getSnapshot()
      const draft: SessionListState = {
        ...current,
        ids: [...current.ids],
        byId: { ...current.byId },
        projectionsBySession: { ...current.projectionsBySession },
      }
      recipe(draft)
      // An id may be listed without a row (the host does this for a Session it
      // has not projected yet), which the fold then skips.
      const written = draft.ids
        .map(id => draft.byId[id])
        .filter((row): row is SessionRow => row !== undefined)
      // The metadata projection rides the same snapshot as the rows, so a
      // recipe that stamps `lastPromptAt` on a row also lands it where the
      // fold reads it. One list publish, then the status, matching the host.
      list.set({
        ...draft,
        projectionsBySession: Object.fromEntries(
          written.map(row => [row.id, projectionOf(row)]),
        ),
      })
      status.set(sessionStatusOf(written))
    },
    publish(recipe: (state: SessionListState) => void): void {
      const current = list.getSnapshot()
      const draft: SessionListState = {
        ...current,
        ids: [...current.ids],
        byId: { ...current.byId },
        projectionsBySession: { ...current.projectionsBySession },
      }
      recipe(draft)
      list.set(draft)
    },
  }
}
