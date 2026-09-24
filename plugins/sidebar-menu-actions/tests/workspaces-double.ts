/**
 * Workspaces service double for the browser-plugin and real-registry specs.
 *
 * The plugin's `pathOf` reads `ctx.workspaces.list.getSnapshot().items` and
 * matches `String(item.workspaceId) === workspaceId` to the item's `path`, so
 * this double supplies exactly that surface: a snapshot reader plus the
 * no-op `subscribe` every store contract carries. Values are plain strings —
 * the plugin stringifies ids itself (contract: `String(item.workspaceId)`).
 */

/** One workspace row as `pathOf` reads it. */
export interface WorkspaceItem {
  readonly workspaceId: string
  readonly path: string
}

/** The slice of the workspaces service the plugin binds. */
export interface WorkspacesDouble {
  readonly list: {
    getSnapshot: () => { readonly items: readonly WorkspaceItem[] }
    subscribe: () => () => void
  }
}

/**
 * Build the workspaces double.
 * @param items - the workspace rows the snapshot reports.
 * @returns the double ready for `ctx.provide('workspaces', …)`.
 */
export function workspacesDouble(items: readonly WorkspaceItem[]): WorkspacesDouble {
  return {
    list: {
      getSnapshot: () => ({ items }),
      subscribe: () => () => {},
    },
  }
}
