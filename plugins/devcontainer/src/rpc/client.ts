/**
 * The host half of the container filesystem RPC: one persistent
 * `docker exec -i <container> node <helper>` pipe that carries framed requests.
 *
 * The channel owns the whole exchange — staging the helper into the container,
 * the `hello` handshake, request/response correlation, cancellation, and the
 * teardown that fails every pending call when the pipe dies. It never replays a
 * request: a caller that loses the connection learns that the remote outcome is
 * unknown, which is the only honest answer for a mutation that may have
 * committed.
 * @module @banzhe/dsh-devcontainer/rpc/client
 */

import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import type { Readable, Writable } from 'node:stream'
import { containerCliEnv } from '../exec.ts'
import { HELPER_CONTAINER_DIRECTORY, HELPER_CONTAINER_PATH, helperSource } from '../helper-source.ts'
import { RpcOperationError } from './errors.ts'
import { FrameDecoder, encodeFrame, RPC_PROTOCOL_VERSION } from './frames.ts'
import type { RpcFrame } from './frames.ts'

/** Request budget when the row configures none. */
export const DEFAULT_RPC_TIMEOUT_MS = 60_000

/** Requests one channel may have in flight before it refuses more. */
const DEFAULT_MAX_PENDING = 256

/** Diagnostic bytes kept from the helper's own streams, for the failure that needs them. */
const DIAGNOSTIC_BYTES = 4096

/** One long-lived child process with piped stdio. */
export interface ContainerChild {
  /** The channel's request bytes. */
  readonly stdin: Writable
  /** The helper's frame bytes. */
  readonly stdout: Readable
  /** Diagnostics; never framed. */
  readonly stderr: Readable
  /** Resolves once the process is gone, however it went. */
  readonly exited: Promise<{ readonly code: number | null, readonly signal: string | null }>
  /** Request termination. */
  kill(signal?: NodeJS.Signals): void
}

/** Starts one child process for the container; replaced in tests. */
export type ContainerChildSpawn = (argv: readonly string[], options?: { readonly cwd?: string }) => ContainerChild

/**
 * Start one child with the filtered CLI environment, so a Docker call carries
 * neither the harness's credentials nor the session's `DSH_*` facts.
 * @param argv - program and arguments, never shell-interpreted.
 * @param options - optional working directory.
 * @returns the child with its piped streams and exit promise.
 */
export const spawnContainerChild: ContainerChildSpawn = (argv, options = {}) => {
  const [program, ...args] = argv
  if (program === undefined) throw new Error('devcontainer: empty command')
  const child = spawn(program, args, {
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
    env: containerCliEnv(),
    ...options.cwd === undefined ? {} : { cwd: options.cwd },
  })
  // A staged write into a process that already failed must not raise an
  // unhandled "error" event; the exit code carries that failure instead.
  child.stdin.on('error', () => {})
  const exited = new Promise<{ code: number | null, signal: string | null }>((resolve) => {
    child.once('exit', (code, signal) => { resolve({ code, signal }) })
    child.once('error', () => { resolve({ code: null, signal: null }) })
  })
  return { stdin: child.stdin, stdout: child.stdout, stderr: child.stderr, exited, kill: (signal) => { child.kill(signal) } }
}

/** What the helper reports about itself once the handshake completes. */
export interface RpcHandshake {
  /** The wire version it speaks. */
  readonly protocol: number
  /** Its `process.platform`; expected to be the container's. */
  readonly platform: string
  /** Its `process.version`. */
  readonly nodeVersion: string
  /** The workspace the channel was opened for. */
  readonly workspace: string
  /** That workspace's realpath inside the container. */
  readonly workspaceReal: string
}

/** Which runtime a channel speaks to, and the directory it treats as home. */
export type ChannelTarget =
  | { readonly kind: 'docker'; readonly containerId: string; readonly workspace: string }
  | { readonly kind: 'sbx'; readonly sandboxName: string; readonly workspace: string }

/**
 * The argv that runs one program inside the runtime.
 *
 * Both drivers take `-i` so the helper keeps its stdio pipe; `sbx` separates its
 * own flags from the command with `--`, which `docker exec` does not need.
 * @param target - the runtime to run in.
 * @param program - the program and its arguments, never shell-interpreted.
 * @returns the complete argv.
 */
export function runtimeExecArgv(target: ChannelTarget, program: readonly string[]): string[] {
  switch (target.kind) {
    case 'docker': return ['docker', 'exec', '-i', target.containerId, ...program]
    case 'sbx': return ['sbx', 'exec', '-i', target.sandboxName, '--', ...program]
  }
}

/**
 * How a diagnostic names one runtime.
 * @param target - the runtime.
 * @returns `container "<id>"` or `sandbox "<name>"`.
 */
function runtimeLabel(target: ChannelTarget): string {
  return target.kind === 'sbx' ? `sandbox "${target.sandboxName}"` : `container "${target.containerId}"`
}

/** Options for one channel. */
export interface ChannelOptions {
  /** The runtime the helper runs in, and its workspace. */
  readonly target: ChannelTarget
  /** The process starter; the Docker / sandbox CLI by default. */
  readonly spawn?: ContainerChildSpawn
  /** Budget for staging, the handshake, and each later request. */
  readonly timeoutMs?: number
  /** In-flight request ceiling. */
  readonly maxPending?: number
}

/** Options for one request. */
export interface RequestOptions {
  /** Cancels the request; the channel tells the helper to stop, it does not roll back. */
  readonly signal?: AbortSignal
  /** Overrides the channel's per-request budget. */
  readonly timeoutMs?: number
}

/**
 * How one write gives up when the caller behind it does.
 *
 * A request frame is written through the same serialized queue as every other
 * frame, so the wait for a writable pipe has to end with the request itself:
 * otherwise a caller that has already given up stays parked on the write until
 * the pipe drains or dies.
 */
interface WriteInterruption {
  /** Ends the wait for the pipe — the request's own budget and cancellation. */
  readonly scope: AbortSignal
  /**
   * The failure the caller reports once the scope ended the write.
   * @returns the cancellation or timeout failure, worded for that request.
   */
  failure(): Error
}

/** A promise and its settlement functions, for the pending-request table. */
function deferred<T>(): { promise: Promise<T>, resolve(value: T): void, reject(error: Error): void } {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((settle, fail) => {
    resolve = settle
    reject = fail
  })
  return { promise, resolve, reject }
}

/** Keep the last bytes of a stream, for the failure message that needs them. */
function tail(current: string, chunk: string): string {
  const merged = current + chunk
  return merged.length <= DIAGNOSTIC_BYTES ? merged : merged.slice(merged.length - DIAGNOSTIC_BYTES)
}

/** Keep the first bytes of a stream, for the failure message that needs them. */
function head(current: string, chunk: string): string {
  const merged = current + chunk
  return merged.length <= DIAGNOSTIC_BYTES ? merged : merged.slice(0, DIAGNOSTIC_BYTES)
}

/**
 * Resolve once a scope aborts; never reject, because it only ends a race.
 * @param scope - the scope to watch.
 * @returns a promise that settles when the scope aborts.
 */
function abortedScope(scope: AbortSignal): Promise<void> {
  if (scope.aborted) return Promise.resolve()
  return new Promise<void>((resolve) => {
    scope.addEventListener('abort', () => { resolve() }, { once: true })
  })
}

/** Race one promise against the request budget and the caller's cancellation. */
async function withDeadline<T>(
  promise: Promise<T>,
  timeoutMs: number,
  signal: AbortSignal | undefined,
  what: string,
): Promise<T> {
  const timeout = AbortSignal.timeout(timeoutMs)
  const scope = signal === undefined ? timeout : AbortSignal.any([signal, timeout])
  const expired = new Promise<never>((_resolve, reject) => {
    scope.addEventListener('abort', () => {
      reject(new Error(signal?.aborted === true
        ? `devcontainer: ${what} was cancelled`
        : `devcontainer: ${what} timed out after ${timeoutMs} ms`))
    }, { once: true })
  })
  return await Promise.race([promise, expired])
}

/**
 * Write the helper program into the runtime and wait for the write to land.
 * @param spawn - the process starter.
 * @param target - the runtime to stage into.
 * @param timeoutMs - budget for the whole stage.
 * @param signal - cancellation.
 * @throws Error when the runtime rejects the write or the budget expires.
 */
async function stageHelper(
  spawn: ContainerChildSpawn,
  target: ChannelTarget,
  timeoutMs: number,
  signal: AbortSignal | undefined,
): Promise<void> {
  const script = `mkdir -p ${HELPER_CONTAINER_DIRECTORY} && cat > ${HELPER_CONTAINER_PATH}`
  const child = spawn(runtimeExecArgv(target, ['sh', '-c', script]))
  let stderr = ''
  child.stderr.on('data', (chunk: Buffer) => { stderr = tail(stderr, chunk.toString('utf8')) })
  const source = helperSource()
  try {
    child.stdin.end(source, 'utf8')
  } catch {
    // The exit code below reports why the container refused it.
  }
  const exit = await withDeadline(child.exited, timeoutMs, signal, 'staging the filesystem helper')
  if (exit.code !== 0) {
    const detail = stderr.trim() === '' ? 'no output' : stderr.trim()
    throw new Error(
      `devcontainer: cannot stage the filesystem helper in ${runtimeLabel(target)} `
      + `(exit ${exit.code === null ? 'unknown' : exit.code}): ${detail}`,
    )
  }
}

/**
 * One live request/response pipe to a container's filesystem helper.
 *
 * A channel is single-use in the sense that matters: once the pipe fails, every
 * later call rejects, and the pool that owns it opens a fresh one. Nothing is
 * replayed, because a mutation that died mid-flight has an unknown outcome.
 */
export class ContainerRpcChannel {
  private readonly pending = new Map<string, { resolve(value: unknown): void, reject(error: Error): void }>()
  private readonly decoder = new FrameDecoder()
  private readonly child: ContainerChild
  private readonly label: string
  private readonly timeoutMs: number
  private readonly maxPending: number
  private readonly closed = deferred<void>()
  private writeTail: Promise<void> = Promise.resolve()
  private stderrTail = ''
  private preface = ''
  private proseOnly = false
  private framesStarted = false
  private failure: Error | undefined
  private handshakeValue: RpcHandshake | undefined

  private constructor(child: ContainerChild, label: string, timeoutMs: number, maxPending: number) {
    this.child = child
    this.label = label
    this.timeoutMs = timeoutMs
    this.maxPending = maxPending
    child.stdout.on('data', (chunk: Buffer) => { this.consume(chunk) })
    child.stdout.on('error', (error: Error) => { this.fail(error) })
    child.stderr.on('data', (chunk: Buffer) => { this.stderrTail = tail(this.stderrTail, chunk.toString('utf8')) })
    void child.exited.then(
      (exit) => { this.fail(this.proseOnly ? this.proseFailure(exit) : this.transportFailure(exit)) },
      () => { this.fail(new Error('devcontainer: the container filesystem helper could not be started')) },
    )
  }

  /**
   * Stage the helper, start its process, and complete the handshake.
   * @param options - the container, its workspace, and the process starter.
   * @returns the open channel.
   * @throws Error when staging, the process start, or the handshake fails.
   */
  static async open(options: ChannelOptions): Promise<ContainerRpcChannel> {
    const spawn = options.spawn ?? spawnContainerChild
    const timeoutMs = options.timeoutMs ?? DEFAULT_RPC_TIMEOUT_MS
    const target = options.target
    await stageHelper(spawn, target, timeoutMs, undefined)
    const child = spawn(runtimeExecArgv(target, ['node', HELPER_CONTAINER_PATH]))
    const channel = new ContainerRpcChannel(
      child,
      runtimeLabel(target),
      timeoutMs,
      options.maxPending ?? DEFAULT_MAX_PENDING,
    )
    try {
      const hello = await channel.request<RpcHandshake>(
        'hello',
        { protocol: RPC_PROTOCOL_VERSION, workspace: target.workspace },
        { timeoutMs },
      )
      if (hello.protocol !== RPC_PROTOCOL_VERSION) {
        throw new Error(`devcontainer: the container helper speaks protocol ${hello.protocol}, not ${RPC_PROTOCOL_VERSION}`)
      }
      for (const field of ['platform', 'nodeVersion', 'workspace', 'workspaceReal'] as const) {
        if (typeof hello[field] !== 'string') throw new Error(`devcontainer: the container helper sent no ${field}`)
      }
      channel.handshakeValue = hello
      return channel
    } catch (error: unknown) {
      await channel.close()
      throw error
    }
  }

  /** What the helper reported during the handshake. */
  get handshake(): RpcHandshake {
    if (this.handshakeValue === undefined) throw new Error('devcontainer: the container helper is not handshaken')
    return this.handshakeValue
  }

  /** Whether the pipe failed or was closed; a closed channel never recovers. */
  get isClosed(): boolean {
    return this.failure !== undefined
  }

  /** Resolves once the channel is unusable. */
  get closedPromise(): Promise<void> {
    return this.closed.promise
  }

  /**
   * Send one request and settle with the helper's answer.
   *
   * The frame is written under the same scope as the answer, so the budget and
   * the caller's cancellation end a write that is still waiting for a pipe that
   * will not take the bytes. A pipe that stays wedged is reset rather than left
   * to block every later request behind the same write.
   * @param method - the helper operation, for example `fs.readText`.
   * @param params - JSON parameters.
   * @param options - cancellation and a per-request budget.
   * @returns the validated remote value.
   * @throws RpcOperationError for a remote failure, Error for transport, cancellation and timeouts.
   */
  async request<T>(method: string, params: unknown, options: RequestOptions = {}): Promise<T> {
    const { signal } = options
    if (this.failure !== undefined) throw this.failure
    signal?.throwIfAborted()
    if (this.pending.size >= this.maxPending) {
      throw new Error(`devcontainer: the container filesystem helper already has ${this.pending.size} pending requests`)
    }
    const id = randomUUID()
    const settled = deferred<unknown>()
    // A rejection nobody awaited yet must not surface as an unhandled rejection.
    void settled.promise.catch(() => {})
    this.pending.set(id, {
      resolve: (value: unknown) => { settled.resolve(value) },
      reject: (error: Error) => { settled.reject(error) },
    })
    const timeoutMs = options.timeoutMs ?? this.timeoutMs
    const timeout = AbortSignal.timeout(timeoutMs)
    const scope = signal === undefined ? timeout : AbortSignal.any([signal, timeout])
    const giveUp = (): Error => new Error(signal?.aborted === true
      ? `devcontainer: "${method}" was cancelled`
      : `devcontainer: "${method}" timed out after ${timeoutMs} ms`)
    const cancel = (): void => {
      this.pending.delete(id)
      void this.send({ type: 'cancel', id }).catch(() => {})
      settled.reject(giveUp())
    }
    scope.addEventListener('abort', cancel, { once: true })
    try {
      await this.send({ type: 'request', id, method, params }, { scope, failure: giveUp })
      return await settled.promise as T
    } catch (error: unknown) {
      this.pending.delete(id)
      throw error
    } finally {
      scope.removeEventListener('abort', cancel)
    }
  }

  /**
   * Probe the helper's liveness.
   * @param options - cancellation and a per-request budget.
   * @returns the helper's clock, once it answered.
   */
  async ping(options: RequestOptions = {}): Promise<{ readonly pong: boolean, readonly now: number }> {
    return await this.request('ping', {}, options)
  }

  /**
   * Stop the helper and fail everything still pending.
   * @param reason - the failure reported to pending callers; a closure message by default.
   */
  async close(reason?: Error): Promise<void> {
    this.fail(reason ?? new Error('devcontainer: the container filesystem channel was closed'))
    await this.closed.promise
  }

  private consume(chunk: Buffer): void {
    if (!this.framesStarted) this.preface = head(this.preface, chunk.toString('utf8'))
    if (this.proseOnly) return
    let frames: RpcFrame[]
    try {
      frames = this.decoder.push(chunk)
    } catch (error: unknown) {
      if (this.decoder.proseHeader !== undefined) {
        // Prose, not a frame: the exit handler reports it once the pipe is done.
        this.proseOnly = true
        return
      }
      this.fail(error instanceof Error ? error : new Error(String(error)))
      return
    }
    for (const frame of frames) this.receive(frame)
    if (frames.length > 0) {
      this.framesStarted = true
      this.preface = ''
    }
  }

  private receive(frame: RpcFrame): void {
    if (frame.type === 'result' || frame.type === 'error') {
      const pending = this.pending.get(frame.id)
      // A cancelled request may still be answered; its caller already settled.
      if (pending === undefined) return
      this.pending.delete(frame.id)
      if (frame.type === 'result') pending.resolve(frame.value)
      else pending.reject(new RpcOperationError(frame.error.message, frame.error.code))
      return
    }
    this.fail(new Error(`devcontainer: the container helper sent an unexpected ${frame.type} frame`))
  }

  /**
   * Put one frame on the pipe.
   * @param frame - the frame to write.
   * @param interruption - ends the write when the caller behind it gives up; omitted for the frames the channel writes on its own behalf.
   * @throws Error when the channel is broken, or when the interruption ended the write.
   */
  private async send(frame: RpcFrame, interruption?: WriteInterruption): Promise<void> {
    if (this.failure !== undefined) throw this.failure
    const bytes = encodeFrame(frame)
    const write = this.writeTail.then(async () => {
      this.throwIfBroken()
      if (interruption === undefined) {
        if (!this.child.stdin.write(bytes)) await this.awaitDrain()
        this.throwIfBroken()
        return
      }
      // A frame whose caller already gave up is not worth writing: a queued
      // write can sit out a whole budget behind one that is stuck.
      if (interruption.scope.aborted) throw interruption.failure()
      if (this.child.stdin.write(bytes)) return
      // Backpressure: wait for the drain, for the pipe to die under us, or for
      // the caller to give up on the answer this frame carries.
      const drained = await this.awaitDrain(interruption.scope)
      this.throwIfBroken()
      // A drained pipe already holds the frame; the caller's cancellation has
      // settled its promise on its own, so the write is done.
      if (drained) return
      // Bytes the pipe will not take leave every later write queued behind this
      // one, so the channel is reset instead of left wedged.
      this.fail(new Error('devcontainer: the container filesystem pipe stopped draining; the channel was closed'))
      throw interruption.failure()
    })
    this.writeTail = write.catch(() => {})
    if (interruption === undefined) {
      await write
      return
    }
    // A write still waiting for its turn behind other frames must not outlive
    // the request either: the caller stops waiting here, and the queued write
    // refuses itself when the queue reaches it.
    await Promise.race([write, abortedScope(interruption.scope)])
  }

  /**
   * Wait for the pipe to take buffered bytes.
   * @param scope - ends the wait when the caller gives up.
   * @returns true when the pipe drained, false when the wait ended another way.
   * @throws Error when the pipe died during the wait.
   */
  private async awaitDrain(scope?: AbortSignal): Promise<boolean> {
    let onDrain = (): void => {}
    const drained = new Promise<boolean>((resolve) => {
      onDrain = () => {
        this.child.stdin.off('drain', onDrain)
        resolve(true)
      }
    })
    this.child.stdin.once('drain', onDrain)
    let stopped: (() => void) | undefined
    try {
      return await Promise.race([
        drained,
        this.closed.promise.then(() => false),
        ...(scope === undefined ? [] : [new Promise<boolean>((resolve) => {
          stopped = () => { resolve(false) }
          scope.addEventListener('abort', stopped, { once: true })
        })]),
      ])
    } finally {
      this.child.stdin.off('drain', onDrain)
      if (stopped !== undefined && scope !== undefined) scope.removeEventListener('abort', stopped)
    }
  }

  /** Re-read the channel state, which an awaited step may have changed. */
  private throwIfBroken(): void {
    const failure = this.failure
    if (failure !== undefined) throw failure
  }

  private transportFailure(exit: { code: number | null, signal: string | null }): Error {
    const detail = this.stderrTail.trim() === '' ? 'no output' : this.stderrTail.trim()
    const status = exit.signal !== null ? `signal ${exit.signal}` : `exit ${exit.code === null ? 'unknown' : exit.code}`
    return new Error(
      `devcontainer: the container filesystem helper stopped (${status}): ${detail}. `
      + 'The outcome of any request that was in flight is unknown.',
    )
  }

  /**
   * The failure of a pipe that answered with prose instead of frames.
   *
   * A runtime without the `node` the helper needs replies with its own exec
   * diagnostic, so the first four bytes of `exec: ...` decode as a length header
   * of 1702389091 bytes. Reporting the frame size hides the cause; the collected
   * text is what the reader can act on.
   */
  private proseFailure(exit: { code: number | null, signal: string | null }): Error {
    const status = exit.signal !== null ? `signal ${exit.signal}` : `exit ${exit.code === null ? 'unknown' : exit.code}`
    const detail = this.preface.trim() === '' ? 'no output' : this.preface.trim()
    return new Error(
      `devcontainer: the filesystem helper could not be started in ${this.label} (${status}); `
      + `the runtime answered its pipe with text instead of RPC frames: ${detail}`,
    )
  }

  private fail(error: Error): void {
    if (this.failure !== undefined) return
    const partial = this.proseOnly ? false : this.decoder.pending
    this.failure = partial
      ? new Error(`${error.message} (the pipe ended inside a frame)`, { cause: error })
      : error
    for (const pending of this.pending.values()) pending.reject(this.failure)
    this.pending.clear()
    this.closed.resolve()
    try {
      this.child.kill('SIGTERM')
    } catch {
      // An already-dead child needs no termination.
    }
  }
}
