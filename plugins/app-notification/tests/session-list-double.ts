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

export interface WireCatalogEntry {
  readonly id: SessionId
  readonly createdAt: number
  readonly mode: 'unknown'
}

export type SessionRow = SessionSummary & {
  completed?: boolean
  catalog?: readonly WireCatalogEntry[]
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

export function subagentRow(id: string, over: Partial<SessionRow> = {}): SessionRow {
  return sessionRow(id, { origin: 'subagent', ...over })
}

export function subagentCatalogEntry(id: string): WireCatalogEntry {
  return { id: id as SessionId, createdAt: 1_700_000_000_000, mode: 'unknown' }
}

type CataloguedRow = SessionRow & { catalog: readonly WireCatalogEntry[] }

type CatalogProjection = NonNullable<SessionListState['projectionsBySession'][SessionId]>

function catalogProjection(catalog: readonly WireCatalogEntry[]): CatalogProjection {
  return {
    state: 'ready',
    error: null,
    values: {
      subagentCatalog: catalog.map(entry => ({
        id: entry.id,
        createdAt: entry.createdAt,
        mode: entry.mode,
      })),
    },
  }
}

function isCataloguedRow(
  row: SessionSummary | undefined,
): row is CataloguedRow {
  return row !== undefined && 'catalog' in row && row.catalog !== undefined
}

/**
 * The catalog rides on the row here; the host publishes it as a projection value,
 * so the double rebuilds the projection record from the rows that carry one.
 */
function catalogProjections(
  rows: readonly (SessionSummary | undefined)[],
): SessionListState['projectionsBySession'] {
  const entries: [SessionId, CatalogProjection][] = []
  for (const row of rows) {
    if (isCataloguedRow(row)) entries.push([row.id, catalogProjection(row.catalog)])
  }
  return Object.fromEntries(entries)
}

/**
 * `running` supplies the parent's view of a subagent the row set cannot express
 * (a catalog-only child, or a status flag that outranks the retained row).
 */
export function sessionStatusOf(
  rows: readonly SessionRow[],
  running: Readonly<Record<string, boolean | undefined>> = {},
): SessionStatusSnapshot {
  const status = new Map<SessionId, SessionStatus>(
    rows.filter(row => row.completed === true).map(row => [row.id, {
      running: undefined, pendingInteraction: undefined, completionUnread: true,
    } satisfies SessionStatus]),
  )
  for (const [id, value] of Object.entries(running)) {
    const base = status.get(id as SessionId)
    status.set(id as SessionId, {
      running: value,
      pendingInteraction: base?.pendingInteraction ?? undefined,
      completionUnread: base?.completionUnread ?? false,
    })
  }
  return status
}

export function sessionListOf(rows: readonly SessionRow[]): SessionListState {
  return {
    ids: rows.map(row => row.id),
    byId: Object.fromEntries(rows.map(row => [row.id, row])),
    phase: 'ready',
    projectionsBySession: catalogProjections(rows),
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
      list.update((state) => {
        recipe(state)
        const projected = state.ids.map(id => state.byId[id])
        if (projected.some(row => isCataloguedRow(row))) {
          state.projectionsBySession = catalogProjections(projected)
        }
      })
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
