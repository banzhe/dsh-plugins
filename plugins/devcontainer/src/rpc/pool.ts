/**
 * The channel pool: one live RPC pipe per container, shared by every filesystem
 * call in a composition and re-opened after the pipe or the container dies.
 *
 * A shared open is deliberately not cancellable by one caller's signal: another
 * caller may be waiting for the same handshake, and aborting the open would
 * destroy their connection too. Callers check their own signal before joining.
 * @module @banzhe/dsh-devcontainer/rpc/pool
 */

import { ContainerRpcChannel, spawnContainerChild } from './client.ts'
import type { ChannelTarget, ContainerChildSpawn } from './client.ts'

/** Options one pool needs to open a channel. */
export interface ChannelOptions {
  /** Budget for staging, the handshake, and each request. */
  readonly timeoutMs: number
}

const SEPARATOR = '\u0000'

/** The pool key of one runtime endpoint. */
function keyOf(target: ChannelTarget): string {
  const endpoint = target.kind === 'sbx' ? `sbx:${target.sandboxName}` : `docker:${target.containerId}`
  return `${endpoint}${SEPARATOR}${target.workspace}`
}

/**
 * Live channels, keyed by runtime endpoint and workspace.
 *
 * A channel that failed is dropped as soon as it settles, so the next call
 * handshakes again — that is what makes a restarted container recoverable
 * without restarting the session.
 */
export class ContainerRpcPool {
  private readonly channels = new Map<string, Promise<ContainerRpcChannel>>()
  private readonly spawn: ContainerChildSpawn

  /**
   * @param spawn - the process starter; the Docker CLI unless a test replaces it.
   */
  constructor(spawn: ContainerChildSpawn = spawnContainerChild) {
    this.spawn = spawn
  }

  /**
   * The live channel for one container, opened and handshaken on demand.
   * @param target - the container and the workspace it should treat as home.
   * @param options - the per-request budget.
   * @returns the usable channel.
   * @throws Error when the helper cannot be staged or handshaken.
   */
  async channel(target: ChannelTarget, options: ChannelOptions): Promise<ContainerRpcChannel> {
    const key = keyOf(target)
    const cached = this.channels.get(key)
    if (cached !== undefined) {
      const channel = await cached.catch(() => undefined)
      if (channel !== undefined && !channel.isClosed) return channel
      if (this.channels.get(key) === cached) this.channels.delete(key)
    }
    const opening = ContainerRpcChannel.open({
      target,
      spawn: this.spawn,
      timeoutMs: options.timeoutMs,
    })
    this.channels.set(key, opening)
    const forget = (): void => {
      if (this.channels.get(key) === opening) this.channels.delete(key)
    }
    void opening.then(
      (channel) => { void channel.closedPromise.then(forget) },
      forget,
    ).catch(() => {})
    return await opening
  }

  /**
   * Drop one cached channel without touching the others.
   * @param target - the container and workspace to forget.
   */
  forget(target: ChannelTarget): void {
    this.channels.delete(keyOf(target))
  }

  /** Close every channel this pool opened, waiting for each process to settle. */
  async closeAll(): Promise<void> {
    const opening = [...this.channels.values()]
    this.channels.clear()
    for (const pending of opening) {
      const channel = await pending.catch(() => undefined)
      if (channel !== undefined) await channel.close()
    }
  }
}
