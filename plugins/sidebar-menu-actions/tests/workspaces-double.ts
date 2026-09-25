/**
 * Workspaces service double for the browser-plugin and real-registry specs.
 *
 * The plugin's `pathOf` reads `ctx.workspaces.list.getSnapshot().items` and
 * matches `String(item.workspaceId) === workspaceId` to the item's `path`, so
 * this double supplies exactly that surface: a snapshot reader plus the
 * no-op `subscribe` every store contract carries. Values are plain strings —
 * the plugin stringifies ids itself (contract: `String(item.workspaceId)`).
 */

export interface WorkspaceItem {
  readonly workspaceId: string
  readonly path: string
}

export interface WorkspacesDouble {
  readonly list: {
    getSnapshot: () => { readonly items: readonly WorkspaceItem[] }
    subscribe: () => () => void
  }
}

export function workspacesDouble(items: readonly WorkspaceItem[]): WorkspacesDouble {
  return {
    list: {
      getSnapshot: () => ({ items }),
      subscribe: () => () => {},
    },
  }
}
