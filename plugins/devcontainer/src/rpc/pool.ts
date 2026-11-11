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

/** The runtime endpoint of one target, without the mounts its helper was handshaken with. */
function endpointOf(target: ChannelTarget): string {
  return target.kind === 'sbx' ? `sbx:${target.sandboxName}` : `docker:${target.containerId}`
}

/** The extra roots a helper is handshaken with, as one comparable token. */
function mountsOf(target: ChannelTarget): string {
  // A separator would let `['/a,/b']` and `['/a', '/b']` tokenise alike, so the list is
  // encoded rather than joined.
  return target.kind === 'sbx' ? JSON.stringify(target.mounts ?? []) : '[]'
}

/** The pool key of one runtime endpoint and workspace. */
function keyOf(target: ChannelTarget): string {
  return `${endpointOf(target)}\u0000${target.workspace}`
}

/** One live channel, and the extra roots the helper it runs was handshaken with. */
interface LiveChannel {
  /** The extra roots the handshake named, as one comparable token. */
  readonly mounts: string
  /** The channel, from the moment it is opened. */
  readonly opening: Promise<ContainerRpcChannel>
}

/**
 * Live channels, one per runtime endpoint and workspace.
 *
 * A channel that failed is dropped as soon as it settles, so the next call
 * handshakes again — that is what makes a restarted container recoverable without
 * restarting the session. A caller who needs other extra roots than the live
 * channel carries replaces it in place: one endpoint and one workspace have one
 * helper, so two rows that disagree about those roots cannot evict each other's
 * channel.
 *
 * Every key carries a queue, and each caller's whole `settle` runs on it: closing the
 * old helper takes a moment, and a caller arriving inside that window must not open
 * a second channel beside the one already on its way in. Different keys never wait
 * for each other. A caller that waits behind another also inherits that open's
 * budget rather than its own — the wait is the price of one helper per endpoint.
 */
export class ContainerRpcPool {
  private readonly channels = new Map<string, LiveChannel>()
  /** The tail of each key's queue: what the next caller for that key waits on. */
  private readonly queues = new Map<string, Promise<void>>()
  private readonly spawn: ContainerChildSpawn
  /** Set by {@link closeAll}: a closed pool neither starts a helper nor hands one out, and a late open is closed on arrival. */
  private closed = false

  /**
   * Whether the pool has been closed.
   *
   * Read through a call on purpose: an `await` in the caller settles what a direct field
   * read was when the call started, which both hides the change and reads as dead code.
   * @returns true once {@link closeAll} has run.
   */
  private isClosed(): boolean {
    return this.closed
  }

  /**
   * @param spawn - the process starter; the Docker CLI unless a test replaces it.
   */
  constructor(spawn: ContainerChildSpawn = spawnContainerChild) {
    this.spawn = spawn
  }

  /**
   * The live channel for one container, opened and handshaken on demand.
   *
   * A channel already handshaken with these extra roots is reused as it stands; one
   * handshaken with others is closed first and replaced, so a change of
   * `hostMounts` neither leaks the old helper nor needs a second key.
   * @param target - the container, the workspace it should treat as home, and the extra roots to name.
   * @param options - the per-request budget.
   * @returns the usable channel.
   * @throws Error when the pool has been closed, or when the helper cannot be staged or handshaken.
   */
  async channel(target: ChannelTarget, options: ChannelOptions): Promise<ContainerRpcChannel> {
    const key = keyOf(target)
    const turn = this.enqueue(key, () => this.settle(target, key, options))
    return await turn
  }

  /**
   * Run one task on a key's queue, and hand back its result.
   *
   * The queue moves on whether the task succeeded or not: a helper that could not be
   * opened, a close that failed, must not lock the key for the rest of the session.
   * @param key - the pool key to serialise on.
   * @param task - the work to run when the key is free.
   * @returns the task's result, or its failure.
   */
  private async enqueue<T>(key: string, task: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(key) ?? Promise.resolve()
    const turn = previous.then(task, task)
    const tail = turn.then(() => undefined, () => undefined)
    this.queues.set(key, tail)
    void tail.then(() => {
      if (this.queues.get(key) === tail) this.queues.delete(key)
    })
    return await turn
  }

  /**
   * Hand one caller the channel its roots ask for, replacing what is there.
   * @param target - the container, workspace, and extra roots.
   * @param key - the pool key the caller queued on.
   * @param options - the per-request budget.
   * @returns the usable channel.
   * @throws Error when the pool was closed while the caller waited.
   */
  private async settle(
    target: ChannelTarget, key: string, options: ChannelOptions,
  ): Promise<ContainerRpcChannel> {
    if (this.isClosed()) throw new Error(CLOSED_TEXT)
    const mounts = mountsOf(target)
    const cached = this.channels.get(key)
    if (cached !== undefined) {
      const channel = await cached.opening.catch(() => undefined)
      if (channel !== undefined && !channel.isClosed && cached.mounts === mounts) {
        // A channel closed over while the caller waited is one `closeAll` is about to
        // take: handing it out would answer with a helper that dies under the request.
        if (this.isClosed()) throw new Error(CLOSED_TEXT)
        return channel
      }
      // Close first, and only then let go of the entry. A caller arriving during the
      // close is queued behind this turn, so it never reads a key that is halfway
      // through a replacement.
      if (channel !== undefined && !channel.isClosed) await channel.close().catch(() => undefined)
      if (this.channels.get(key) === cached) this.channels.delete(key)
    }
    // Checked before the spawn, so a pool that closed while this caller queued neither
    // starts a helper nor makes `closeAll` wait for one it will close again.
    if (this.isClosed()) throw new Error(CLOSED_TEXT)
    const opening = ContainerRpcChannel.open({
      target,
      spawn: this.spawn,
      timeoutMs: options.timeoutMs,
    })
    const live: LiveChannel = { mounts, opening }
    const channel = await opening
    if (this.isClosed()) {
      // The pool was closed while this channel was opening: it belongs to nobody, and
      // `closeAll` has already taken its snapshot.
      await channel.close().catch(() => undefined)
      throw new Error(CLOSED_TEXT)
    }
    this.channels.set(key, live)
    const release = (): void => {
      if (this.channels.get(key) === live) this.channels.delete(key)
    }
    void channel.closedPromise.then(release)
    return channel
  }

  /**
   * Drop the channel of one key, closing it.
   *
   * It runs on the key's queue like any other change, so it cannot interleave with a
   * replacement and leave a channel nobody holds; the close is awaited before the
   * caller continues.
   * @param target - the container and workspace to forget.
   */
  async forget(target: ChannelTarget): Promise<void> {
    const key = keyOf(target)
    await this.enqueue(key, () => this.discard(key))
  }

  /**
   * Remove and close whatever one key holds.
   * @param key - the pool key to empty.
   */
  private async discard(key: string): Promise<void> {
    const cached = this.channels.get(key)
    if (cached === undefined) return
    this.channels.delete(key)
    const channel = await cached.opening.catch(() => undefined)
    if (channel !== undefined && !channel.isClosed) await channel.close().catch(() => undefined)
  }

  /**
   * Close every channel this pool opened, and keep it closed.
   *
   * The queue is drained first, so a replacement that is already closing the helper it
   * replaces finishes here instead of writing a channel into a pool that has stopped
   * looking; the closed flag then covers whatever was still opening.
   */
  async closeAll(): Promise<void> {
    this.closed = true
    await Promise.all([...this.queues.values()].map(tail => tail.then(() => undefined, () => undefined)))
    const live = [...this.channels.values()]
    this.channels.clear()
    for (const entry of live) {
      const channel = await entry.opening.catch(() => undefined)
      if (channel !== undefined) await channel.close().catch(() => undefined)
    }
  }
}

/** The failure a caller reads when it asked a closed pool for a channel. */
const CLOSED_TEXT = 'the container channel pool is closed'
