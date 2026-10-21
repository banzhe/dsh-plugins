/**
 * Workspace Controller source double for the app-badge specs: the shape
 * `ctx.workspaces.list` exposes (a bare snapshot plus invalidation
 * subscription), with a setter so a spec can file a Session away the way the
 * archive command does — a bare archive-set change that touches neither the
 * Session list nor the status.
 */
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { WorkspaceId, WorkspaceSnapshot, WorkspaceView } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'

export interface WorkspaceSourceDouble {
  readonly source: ReturnType<typeof createSnapshotStore<WorkspaceSnapshot>>
  /** Replace the Workspace rows, keeping phase and archive/pin sets. */
  setItems(items: readonly WorkspaceView[]): void
  /** Replace the registry-global archive set, as `archiveSession` echoes it. */
  archive(...sessionIds: readonly SessionId[]): void
  /** Restore every archived Session, as `unarchiveSession` echoes it. */
  unarchive(): void
}

/** One durable Workspace row as the Host projects it. */
export function workspaceView(workspaceId: string, sessionIds: readonly string[] = []): WorkspaceView {
  return {
    workspaceId: workspaceId as WorkspaceId,
    path: `/p/${workspaceId}`,
    title: workspaceId,
    sessionIds: sessionIds as SessionId[],
    createdAt: '',
    updatedAt: '',
  }
}

/**
 * A settled Workspace source. `phase: 'ready'` unless asked otherwise: the demo
 * pick refuses an unsettled list, so an ordinary spec wants the settled one.
 */
export function workspaceSource(
  items: readonly WorkspaceView[] = [],
  phase: WorkspaceSnapshot['phase'] = 'ready',
): WorkspaceSourceDouble {
  const source = createSnapshotStore<WorkspaceSnapshot>({
    items,
    archivedSessionIds: [],
    pinnedSessionIds: [],
    state: 'idle',
    phase,
    error: null,
  })
  // `set`, not `update`: every set on a snapshot is readonly, so an immer draft
  // cannot assign it (immer drafts would need the mutable twin).
  const patch = (change: Partial<WorkspaceSnapshot>): void => {
    source.set({ ...source.getSnapshot(), ...change })
  }
  return {
    source,
    setItems(next) {
      patch({ items: next })
    },
    archive(...sessionIds) {
      patch({ archivedSessionIds: [...sessionIds] })
    },
    unarchive() {
      patch({ archivedSessionIds: [] })
    },
  }
}
