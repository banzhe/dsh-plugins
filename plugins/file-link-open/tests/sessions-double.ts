/**
 * Test double for the `sessions` service.
 *
 * The owner (`@deepseek-ai/dsh-api-session-controller`) is not a dependency of
 * this Bundle: the plugin restates the one member it uses — the Host catalog
 * snapshot — and this double publishes that snapshot from a map a spec can
 * change between openings.
 *
 * Production code never imports this.
 */

/** One Session's fields as this plugin reads them. */
export interface SessionSnapshotEntry {
  readonly cwd?: string
}

export class SessionsDouble {
  private readonly byId = new Map<string, SessionSnapshotEntry>()

  /** Publish one Session's workspace root, or drop it with `undefined`, as the host catalog does. */
  setCwd(sessionId: string, cwd: string | undefined): void {
    if (cwd === undefined) this.byId.delete(sessionId)
    else this.byId.set(sessionId, { cwd })
  }

  /** The catalog snapshot the plugin reads at resolve time. */
  readonly list = {
    getSnapshot: () => ({ byId: Object.fromEntries(this.byId) }),
  }
}
