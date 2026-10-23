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

/**
 * The `SubagentCatalogEntry` wire row, restated from
 * `@deepseek-ai/dsh-subagent` with the brand erased — the package lands in the
 * client only through the controller's peer edge, which a plugin's dependency
 * graph does not resolve, and the JSON round-trip makes the brand invisible
 * anyway. The `ProjectionMap`'s own copy is the branded one, so a fixture
 * entry needs the brand to ride into `values.subagentCatalog`.
 */
type WireCatalogEntry = {
  readonly id: SessionId
  readonly createdAt: number
} & (
  | { readonly mode: 'one-shot'; readonly label?: string }
  | { readonly mode: 'external'; readonly label?: string }
  | { readonly mode: 'continuable'; readonly label: string }
  | { readonly mode: 'unknown'; readonly label?: string }
)

/** A list row with the two status facts the host keeps off the list row. */
export type SessionRow = SessionSummary & {
  completed?: boolean
  blocked?: boolean
  /** The durable prompt time the metadata projection reports, when read. */
  lastPromptAt?: number | null
  /** Catalog entries the row's `subagentCatalog` projection reports. */
  catalog?: readonly WireCatalogEntry[]
  /** The child's open-turn start (`subagentTiming.active.since`), when read. */
  activeSince?: number
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

function projectionOf(row: SessionRow): SessionProjectionSnapshot {
  return {
    state: 'ready',
    error: null,
    values: {
      // Wire shape of the `sessionListMetadata` projection view.
      ...(row.lastPromptAt === undefined ? {} : {
        sessionListMetadata: { blank: false, lastPromptAt: row.lastPromptAt },
      }),
      // The parent-owned child catalog, exactly as `projectList` republishes
      // it from the parent's projection store. The wire block value is
      // mutable-array JSON, so the double hands a copy over.
      ...(row.catalog === undefined ? {} : { subagentCatalog: [...row.catalog] }),
      // The child's own open-turn timing, the same wire block. `settledMs`
      // is the fold's second fact; the panel reads only the `since`.
      ...(row.activeSince === undefined ? {} : {
        subagentTiming: { settledMs: 0, active: { since: row.activeSince, through: row.activeSince } },
      }),
    },
  }
}

/** One listed subagent child row, the shape the host list or catalog carries. */
export function subagentRow(id: string, over: Partial<SessionRow> = {}): SessionRow {
  return sessionRow(id, {
    origin: 'subagent',
    parentId: 'parent' as SessionId,
    // The controller derives `displayTitle` from the durable title first, so a
    // fixture row carrying `title` carries the same `displayTitle`.
    ...(over.title === undefined ? {} : { displayTitle: over.title }),
    ...over,
  })
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

export function parentWithChildren(
  parent: SessionRow,
  children: readonly (readonly [id: string, over: Partial<SessionRow>])[],
): SessionRow[] {
  return [
    { ...parent, catalog: children.map(([id]) => subagentCatalogEntry(id)) },
    ...children.map(([id, over]) => subagentRow(id, { parentId: parent.id, ...over })),
  ]
}

export function subagentCatalogEntry(id: string): WireCatalogEntry {
  return { id: id as SessionId, createdAt: 0, mode: 'one-shot', label: id }
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
