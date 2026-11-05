/**
 * Workspace Controller source double for the attention specs: the bare shape
 * `ctx.workspaces.list` exposes (a snapshot plus invalidation subscription),
 * carrying only the archive and pin sets this plugin reads, plus setters that
 * file a Session away or pin one the way those commands echo them.
 */
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { WorkspaceSnapshot } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'

/** A settled Workspace snapshot; this plugin reads only its archive and pin sets. */
export function workspaceSnapshot(
  archived: readonly string[] = [],
  pinned: readonly string[] = [],
): WorkspaceSnapshot {
  return {
    items: [],
    archivedSessionIds: archived as SessionId[],
    pinnedSessionIds: pinned as SessionId[],
    state: 'idle',
    phase: 'ready',
    error: null,
  }
}

export interface WorkspaceSource {
  readonly source: ReturnType<typeof createSnapshotStore<WorkspaceSnapshot>>
  /** Session ids the panel asked the Host to unpin, in call order. */
  readonly unpinned: SessionId[]
  /** Replace the registry-global archive set, as an archive mutation echoes it. */
  setArchived(...sessionIds: readonly string[]): void
  /** Replace the registry-global pin set, as a pin mutation echoes it. */
  setPinned(...sessionIds: readonly string[]): void
  /**
   * One Host unpin command, recorded and echoed: the id leaves the pin set the
   * way the controller's own publication does, so the panel can be shown
   * redrawing the row out.
   */
  unpinSession(sessionId: SessionId): Promise<void>
}

export function workspaceSource(
  archived: readonly string[] = [],
  pinned: readonly string[] = [],
): WorkspaceSource {
  const source = createSnapshotStore<WorkspaceSnapshot>(workspaceSnapshot(archived, pinned))
  const unpinned: SessionId[] = []
  return {
    source,
    unpinned,
    setArchived(...sessionIds) {
      // `set`, not `update`: the snapshot's fields are readonly, so an immer
      // draft cannot assign them.
      source.set({ ...source.getSnapshot(), archivedSessionIds: sessionIds as SessionId[] })
    },
    setPinned(...sessionIds) {
      source.set({ ...source.getSnapshot(), pinnedSessionIds: sessionIds as SessionId[] })
    },
    async unpinSession(sessionId) {
      unpinned.push(sessionId)
      source.set({
        ...source.getSnapshot(),
        pinnedSessionIds: source.getSnapshot().pinnedSessionIds.filter(id => id !== sessionId),
      })
    },
  }
}
