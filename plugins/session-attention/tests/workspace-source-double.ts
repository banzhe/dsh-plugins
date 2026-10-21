/**
 * Workspace Controller source double for the attention specs: the bare shape
 * `ctx.workspaces.list` exposes (a snapshot plus invalidation subscription),
 * carrying only the archive set this plugin reads, plus a setter that files a
 * Session away the way the archive command echoes it.
 */
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { WorkspaceSnapshot } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'

/** A settled Workspace snapshot; this plugin reads only its archive set. */
export function workspaceSnapshot(archived: readonly string[] = []): WorkspaceSnapshot {
  return {
    items: [],
    archivedSessionIds: archived as SessionId[],
    pinnedSessionIds: [],
    state: 'idle',
    phase: 'ready',
    error: null,
  }
}

export interface WorkspaceSource {
  readonly source: ReturnType<typeof createSnapshotStore<WorkspaceSnapshot>>
  /** Replace the registry-global archive set, as an archive mutation echoes it. */
  setArchived(...sessionIds: readonly string[]): void
}

export function workspaceSource(archived: readonly string[] = []): WorkspaceSource {
  const source = createSnapshotStore<WorkspaceSnapshot>(workspaceSnapshot(archived))
  return {
    source,
    setArchived(...sessionIds) {
      // `set`, not `update`: the snapshot's fields are readonly, so an immer
      // draft cannot assign them.
      source.set({ ...source.getSnapshot(), archivedSessionIds: sessionIds as SessionId[] })
    },
  }
}
