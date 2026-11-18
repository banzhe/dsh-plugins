/** OpenSSH connection owner for one version-matched POSIX helper and its independent forwarded streams. */

import { spawn, execFile, type ChildProcess, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { createConnection, type Socket } from 'node:net'
import { setTimeout as delay } from 'node:timers/promises'
import { Context, Service } from '@deepseek-ai/cordis'
import schema from '@deepseek-ai/schemastery'
import { z } from 'zod'
import { assertNever } from '@deepseek-ai/dsh-util-values'
import { SshRpcPeer, SSH_PROTOCOL_VERSION } from './protocol.ts'
import { helloSchema, type SshStreamEndpoint } from './schemas.ts'
import { authenticateStream } from './stream-security.ts'
import { LOOPBACK_HOST, createTemporaryDirectory, reserveLoopbackPort } from './local-endpoints.ts'
import { launchCommand, type HelperLaunch } from './target-shell.ts'

export type { HelperLaunch }

type Hello = z.infer<typeof helloSchema>

/** Deployment-owned SSH identity and installed helper; no model argument selects these values. */
export interface Config {
  /** OpenSSH host alias, including its existing user, key and known-host configuration. */
  host: string
  /** Explicit script or self-contained executable invocation. */
  launch: HelperLaunch
  /** Absolute path to the installed, bundled helper entry. */
  helper: string
  /** SHA-256 of that bundled helper; mismatches refuse the connection. */
  helperHash: string
  /** Absolute remote default workspace. */
  workspace: string
  /** Connection and administrative-request deadline, at most 2,147,483,647 milliseconds. */
  requestTimeoutMs?: number
  /** Maximum JSON payload bytes per helper request or response. */
  maxFrameBytes?: number
  /** Maximum ordinary requests; heartbeat and bounded resource cleanup have reserved capacity. */
  maxPending?: number
  /** Remote helper lease; loss of heartbeats starts remote managed cleanup. */
  leaseMs?: number
}

/**
 * How this connection carries the administrative RPC stream and the authenticated stream forwards.
 * 'multiplexed' is one OpenSSH master on a POSIX host; 'per-stream' gives every stream its own
 * long-lived 'ssh -L' child, the arrangement this Bundle uses on a Windows host.
 */
type Forwarding = 'multiplexed' | 'per-stream'

/** Client banner identifying the OpenSSH implementation this connection drives. */
const OPENSSH_BANNER = /OpenSSH/iu
/** Retained output while probing the local client; one 'ssh -V' banner fits well under this. */
const PROBE_MAX_BYTES = 64 * 1024
/** Delay between attempts to reach a per-stream forwarding whose listener the SSH client still owns. */
const FORWARD_POLL_MS = 50
/** Retained standard-error bytes from one stream child, appended to its failure messages. */
const STDERR_TAIL_BYTES = 4 * 1024
/** Longest SIGTERM grace before a stream child is killed outright. */
const CHILD_KILL_GRACE_MS = 5_000
/** A remote stream path stays inside the helper root and cannot carry a forwarding delimiter. */
const INVALID_STREAM_PATH = /[:\r\n\0]/u
/** Options every helper connection sets; the shipped master passes them in this order. */
const CLIENT_OPTIONS = ['-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'ForwardAgent=no'] as const
/** Keepalive options closing that set. */
const LIVENESS_OPTIONS = ['-o', 'ServerAliveInterval=10', '-o', 'ServerAliveCountMax=3'] as const

declare module '@deepseek-ai/cordis' {
  interface Context { ssh: SshConnection }
}

/** One per-stream SSH child: its forwarding listener, its failure, and how to stop it. */
class StreamChild {
  /** The spawn failure, set when the client never started. */
  failure: Error | undefined
  /** Resolves when the process settled, by exit or by spawn failure. */
  readonly settled: Promise<void>
  private tail = ''

  constructor(private readonly child: ChildProcess, private readonly graceMs: number) {
    const settle = Promise.withResolvers<void>()
    this.settled = settle.promise
    child.on('error', (error: Error) => { this.failure ??= error; settle.resolve() })
    child.once('close', () => { settle.resolve() })
    // SSH diagnostics can name configured paths; only a bounded tail reaches a failure message.
    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', (chunk: string) => { this.tail = `${this.tail}${chunk}`.slice(-STDERR_TAIL_BYTES) })
  }

  /** How the client ended, when it has: its terminating signal or its exit code. */
  status(): string | undefined {
    if (this.child.signalCode !== null) return `signal ${this.child.signalCode}`
    return this.child.exitCode === null ? undefined : `exit code ${this.child.exitCode}`
  }

  /** Ask the client to stop without waiting for it. */
  terminate(): void { this.child.kill('SIGTERM') }

  /** Terminate the client with SIGKILL escalation, then join its settle. */
  async stop(): Promise<void> {
    this.terminate()
    const force = setTimeout(() => { this.child.kill('SIGKILL') }, this.graceMs)
    try { await this.settled } finally { clearTimeout(force) }
  }

  /** Standard-error tail formatted for one failure message, or nothing when the client printed nothing. */
  diagnostics(): string {
    const tail = this.tail.trim()
    return tail === '' ? '' : `: ${tail}`
  }
}

/** One non-reconnecting SSH session; loss invalidates all active operations. */
export class SshConnection extends Service {
  static Config: schema<Config> = schema.object({
    host: schema.string().required(), helper: schema.string().required(),
    launch: schema.union([
      schema.object({ kind: schema.const('node-script').required(), node: schema.string().required(), bootstrapPath: schema.string(), bootstrapHash: schema.string() }),
      schema.object({ kind: schema.const('executable').required() }),
    ]).required(),
    helperHash: schema.string().required(), workspace: schema.string().required(),
    requestTimeoutMs: schema.number().default(30_000), maxFrameBytes: schema.number().default(64 * 1024 * 1024),
    maxPending: schema.number().default(128), leaseMs: schema.number().default(30_000),
  })

  /** Verified remote helper coordinates; callers must await this before launch. */
  readonly ready: Promise<Hello>
  private rpc: SshRpcPeer | undefined
  private child: ChildProcessWithoutNullStreams | undefined
  private childClosed: Promise<void> | undefined
  private directory: string | undefined
  private heartbeat: NodeJS.Timeout | undefined
  private closed = false
  private readonly lifetime = new AbortController()
  private readonly operations = new Set<Promise<unknown>>()
  private disposal: Promise<void> | undefined
  private failure: Error | undefined
  private sockets = new Set<Socket>()
  private streamChildren = new Set<StreamChild>()
  private forwarding: Forwarding = 'multiplexed'
  private nextSocket = 0
  private readonly config: Required<Config>
  private remote: Hello | undefined

  constructor(ctx: Context, config: Config) {
    super(ctx, 'ssh')
    this.config = z.object({
      host: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.@-]*$/),
      launch: z.discriminatedUnion('kind', [
        z.object({ kind: z.literal('node-script'), node: z.string().startsWith('/'),
          bootstrapPath: z.string().startsWith('/').optional(), bootstrapHash: z.string().regex(/^[0-9a-f]{64}$/).optional(),
        }).strict().refine(value => (value.bootstrapPath === undefined) === (value.bootstrapHash === undefined), 'bootstrapPath and bootstrapHash must be paired'),
        z.object({ kind: z.literal('executable') }).strict(),
      ]),
      helper: z.string().startsWith('/'), helperHash: z.string().regex(/^[0-9a-f]{64}$/),
      workspace: z.string().startsWith('/'), requestTimeoutMs: z.number().int().positive().max(2_147_483_647),
      maxFrameBytes: z.number().int().positive().max(64 * 1024 * 1024), maxPending: z.number().int().positive().max(128),
      leaseMs: z.number().int().min(3000).max(600_000),
    }).strict().parse(config) as Required<Config>
    this.ready = this.start()
    // Startup uses Node I/O, local validation, and Error-valued RPC failures.
    void this.ready.catch((error: unknown) => { this.fail(error as Error) })
    ctx.effect(() => () => this.dispose())
  }

  /** Hold plugin readiness until the remote identity and helper digest are verified. */
  async [Service.init](): Promise<void> { await this.ready }

  /** Verified remote PTC launch configuration; script deployments require a verified bootstrap. */
  get ptcLaunch(): { kind: 'embedded'; executable: string } | { kind: 'node-script'; executable: string; bootstrapPath: string } {
    if (this.remote === undefined) throw new Error('SSH helper is not ready')
    const launch = this.config.launch
    switch (launch.kind) {
      case 'executable': return { kind: 'embedded', executable: this.remote.executable }
      case 'node-script':
        if (launch.bootstrapPath === undefined) throw new Error('SSH PTC requires a verified bootstrapPath and bootstrapHash')
        return { kind: 'node-script', executable: this.remote.executable, bootstrapPath: launch.bootstrapPath }
      /* v8 ignore next -- Config parsing admits only these two launch kinds. */
      default: return assertNever(launch)
    }
  }

  /**
   * Send a helper operation; cancellation never replays an ambiguous mutation.
   * @param method - the private helper operation.
   * @param params - JSON request fields validated by the helper.
   * @param result - response validation before returning provider-visible data.
   * @param signal - cancellation, which does not undo completed remote effects.
   * @param wait - allow a process observation to outlast the administrative deadline.
   * @returns the validated remote result.
   */
  async request<T>(method: string, params: unknown, result: z.ZodType<T>, signal?: AbortSignal, wait: boolean = false): Promise<T> {
    this.assertOpen()
    await this.ready
    this.assertOpen()
    const bounded = wait ? signal : signal === undefined
      ? AbortSignal.timeout(this.config.requestTimeoutMs)
      : AbortSignal.any([signal, AbortSignal.timeout(this.config.requestTimeoutMs)])
    return (this.rpc as SshRpcPeer).request(method, params, result, bounded)
  }

  /**
   * Forward one authenticated stream through an independent SSH channel.
   * @param endpoint - private coordinates issued by this connection's helper.
   * @param signal - cancellation of allocation and the resulting socket.
   * @returns a paused socket; attach a consumer before resuming it.
   */
  async connectStream(endpoint: SshStreamEndpoint, signal?: AbortSignal): Promise<Socket> {
    return this.track(this.establishStream(endpoint, signal))
  }

  private async establishStream(endpoint: SshStreamEndpoint, signal?: AbortSignal): Promise<Socket> {
    const hello = await this.ready
    this.assertOpen()
    signal = signal === undefined ? this.lifetime.signal : AbortSignal.any([signal, this.lifetime.signal])
    const remote = endpoint.path
    if (!remote.startsWith(`${hello.root}/`) || INVALID_STREAM_PATH.test(remote)) throw new Error('SSH helper returned an invalid stream path')
    signal.throwIfAborted()
    return this.forwarding === 'multiplexed'
      ? await this.forwardThroughMaster(remote, endpoint, signal)
      : await this.forwardThroughProcess(remote, endpoint, signal)
  }

  /** Reserve a Unix-socket forward on the shared master, then authenticate the socket it exposes. */
  private async forwardThroughMaster(remote: string, endpoint: SshStreamEndpoint, signal: AbortSignal): Promise<Socket> {
    const local = join(this.directory as string, `s${this.nextSocket++}`)
    const forward = `${local}:${remote}`
    const cancelForward = async (): Promise<void> => {
      // An unavailable master already removed its forwarding listeners.
      if (!this.closed) await this.controlCommand(['-O', 'cancel', '-L', forward]).catch(() => {})
      await rm(local, { force: true })
    }
    try {
      await this.controlCommand(['-O', 'forward', '-o', 'ExitOnForwardFailure=yes', '-L', forward], signal)
    } catch (error) { await cancelForward(); throw error }
    signal.throwIfAborted()
    const socket = createConnection({ path: local, allowHalfOpen: true })
    this.sockets.add(socket)
    socket.once('close', () => {
      this.sockets.delete(socket)
      void this.track(cancelForward()).catch(() => {})
    })
    await awaitConnection(socket, signal)
    return await this.authenticate(socket, endpoint, signal)
  }

  /** Start one 'ssh -L' child for this stream and authenticate the loopback socket it exposes. */
  private async forwardThroughProcess(remote: string, endpoint: SshStreamEndpoint, signal: AbortSignal): Promise<Socket> {
    const port = await reserveLoopbackPort()
    signal.throwIfAborted()
    const entry = new StreamChild(spawn('ssh', [
      // No ClearAllForwardings: it would drop the very forwarding this child exists for.
      '-T', '-N', '-L', `${LOOPBACK_HOST}:${port}:${remote}`, '-o', 'ExitOnForwardFailure=yes',
      ...CLIENT_OPTIONS, ...LIVENESS_OPTIONS, this.config.host,
    ], { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true }), Math.min(this.config.requestTimeoutMs, CHILD_KILL_GRACE_MS))
    this.trackStreamChild(entry)
    try {
      const socket = await this.connectLoopback(port, entry, signal)
      this.sockets.add(socket)
      socket.once('close', () => {
        this.sockets.delete(socket)
        void this.track(entry.stop()).catch(() => {})
      })
      return await this.authenticate(socket, endpoint, signal)
    } catch (error) {
      await entry.stop()
      throw error
    }
  }

  /** Reach the loopback listener a stream child bound, waiting while the client still authenticates. */
  private async connectLoopback(port: number, entry: StreamChild, signal: AbortSignal): Promise<Socket> {
    const deadline = Date.now() + this.config.requestTimeoutMs
    const unreachable = (): Error => {
      const status = entry.status()
      const detail = entry.diagnostics()
      return new Error(status === undefined
        ? `SSH stream forwarding did not accept a connection on ${LOOPBACK_HOST}:${port}${detail}`
        : `SSH stream forwarding exited (${status}) before ${LOOPBACK_HOST}:${port} accepted a connection${detail}`)
    }
    for (;;) {
      signal.throwIfAborted()
      const spawnFailure = entry.failure
      if (spawnFailure !== undefined) throw spawnFailure
      const socket = createConnection({ host: LOOPBACK_HOST, port, allowHalfOpen: true })
      try {
        await awaitConnection(socket, signal)
        return socket
      } catch (error) {
        socket.destroy()
        if (!refusedConnection(error)) throw error
        const failure = entry.failure
        if (failure !== undefined) throw failure
        if (entry.status() !== undefined || Date.now() >= deadline) throw unreachable()
        await delay(FORWARD_POLL_MS, undefined, { signal })
      }
    }
  }

  /** Register one stream child for disposal and forget it once it settled. */
  private trackStreamChild(entry: StreamChild): void {
    this.streamChildren.add(entry)
    void entry.settled.then(() => { this.streamChildren.delete(entry) })
  }

  /** Wrap one established forwarded socket in its private TLS-PSK channel. */
  private async authenticate(socket: Socket, endpoint: SshStreamEndpoint, signal: AbortSignal): Promise<Socket> {
    const authenticated = await authenticateStream(socket, endpoint.capability, this.config.requestTimeoutMs, signal)
    this.sockets.add(authenticated)
    authenticated.on('error', () => { authenticated.destroy() })
    authenticated.once('close', () => { this.sockets.delete(authenticated) })
    return authenticated
  }

  /** Tear down the helper's remote managed ranges before releasing every forwarding and the helper process when reachable. */
  dispose(): Promise<void> {
    this.disposal ??= this.disposeOnce()
    return this.disposal
  }

  private async disposeOnce(): Promise<void> {
    this.closed = true
    this.lifetime.abort(new Error('SSH connection is closing'))
    if (this.heartbeat !== undefined) clearInterval(this.heartbeat)
    try {
      await this.ready.catch(() => {})
      if (this.failure === undefined) await this.rpc?.request('close', {}, z.null(), AbortSignal.timeout(this.config.requestTimeoutMs))
    } finally {
      this.rpc?.close()
      // TLS wrappers release their reads before their underlying sockets close.
      const socketClosures = [...this.sockets].reverse().map(socket => new Promise<void>((resolve) => {
        if (socket.closed) resolve()
        else { socket.once('close', () => { resolve() }); socket.destroy() }
      }))
      this.child?.kill('SIGTERM')
      const force = setTimeout(() => { this.child?.kill('SIGKILL') }, this.config.requestTimeoutMs)
      try { await this.childClosed } finally { clearTimeout(force) }
      await this.stopStreamChildren()
      await Promise.all(socketClosures)
      // oxlint-disable-next-line unicorn/no-useless-spread -- keeps the shipped statement verbatim.
      while (this.operations.size > 0) await Promise.allSettled([...this.operations])
      if (this.directory !== undefined) await rm(this.directory, { recursive: true, force: true })
    }
  }

  /** Terminate every per-stream child and join its settle, so no forwarding listener outlives the connection. */
  private async stopStreamChildren(): Promise<void> {
    await Promise.all([...this.streamChildren].map(entry => entry.stop()))
  }

  private controlPath(): string { return join(this.directory as string, 'master') }

  private assertOpen(): void {
    if (this.closed) throw new Error('SSH connection is closed')
    if (this.failure !== undefined) throw this.failure
  }

  private track<T>(operation: Promise<T>): Promise<T> {
    this.operations.add(operation)
    void operation.finally(() => { this.operations.delete(operation) }).catch(() => {})
    return operation
  }

  private async controlCommand(args: string[], signal?: AbortSignal): Promise<void> {
    const signals = [this.lifetime.signal, AbortSignal.timeout(this.config.requestTimeoutMs)]
    if (signal !== undefined) signals.push(signal)
    const combined = AbortSignal.any(signals)
    combined.throwIfAborted()
    const result = Promise.withResolvers<undefined>()
    const command = execFile('ssh', ['-S', this.controlPath(), ...args, this.config.host], {
      signal: combined, maxBuffer: 64 * 1024,
    }, (error) => { if (error === null) result.resolve(undefined); else result.reject(error) })
    const closed = new Promise<void>((resolve) => { command.once('close', () => { resolve() }) })
    let force: NodeJS.Timeout | undefined
    const escalate = (): void => {
      force = setTimeout(() => { command.kill('SIGKILL') }, this.config.requestTimeoutMs)
      force.unref()
    }
    combined.addEventListener('abort', escalate, { once: true })
    try { await result.promise }
    finally {
      await closed
      combined.removeEventListener('abort', escalate)
      if (force !== undefined) clearTimeout(force)
    }
  }

  private fail(error: Error): void {
    if (this.failure !== undefined) return
    this.failure = error
    this.lifetime.abort(error)
    if (this.heartbeat !== undefined) clearInterval(this.heartbeat)
    this.rpc?.close(error)
    for (const socket of [...this.sockets].reverse()) socket.destroy(error)
    for (const entry of this.streamChildren) entry.terminate()
    this.child?.kill('SIGTERM')
  }

  private async start(): Promise<Hello> {
    this.forwarding = (await this.probeClient()) ? 'multiplexed' : 'per-stream'
    if (this.forwarding === 'multiplexed') this.directory = await createTemporaryDirectory()
    if (this.closed) throw new Error('SSH connection closed before startup')
    const launch = launchCommand(this.config.launch, this.config.helper)
    const child = spawn('ssh', [
      '-T',
      ...(this.forwarding === 'multiplexed' ? ['-M', '-S', this.controlPath(), '-o', 'ControlPersist=no'] : []),
      ...CLIENT_OPTIONS, '-o', 'ClearAllForwardings=yes', ...LIVENESS_OPTIONS, this.config.host, launch.command,
    ], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
    this.child = child
    this.childClosed = new Promise((resolve) => { child.once('close', () => { resolve() }) })
    child.stderr.resume() // SSH diagnostics can contain configured paths; operation errors remain structured.
    child.once('error', (error) => { this.fail(error) })
    child.once('close', () => { this.fail(new Error('SSH helper disconnected; remote outcomes and cleanup are unknown')) })
    const rpc = new SshRpcPeer(child.stdout, child.stdin, this.config.maxFrameBytes, this.config.maxPending)
    this.rpc = rpc
    rpc.once('closed', (error) => { this.fail(error as Error) })
    const hello = await rpc.request('hello', {
      protocol: SSH_PROTOCOL_VERSION, workspace: this.config.workspace, leaseMs: this.config.leaseMs,
      ...(launch.bootstrapPath === undefined ? {} : { bootstrapPath: launch.bootstrapPath }),
    }, helloSchema, AbortSignal.timeout(this.config.requestTimeoutMs))
    if (hello.hash !== this.config.helperHash) throw new Error('SSH helper digest differs from the configured artifact')
    if (hello.kind !== this.config.launch.kind) throw new Error('SSH helper runtime differs from the configured launch kind')
    if (hello.bootstrapHash !== launch.bootstrapHash) throw new Error('SSH PTC bootstrap digest differs from the configured artifact')
    this.remote = hello
    let heartbeatPending: Promise<unknown> | undefined
    this.heartbeat = setInterval(() => {
      heartbeatPending ??= rpc.request('heartbeat', {}, z.null(), AbortSignal.timeout(this.config.leaseMs / 2))
        .catch((error: unknown) => { this.fail(error as Error) })
        .finally(() => { heartbeatPending = undefined })
    }, Math.floor(this.config.leaseMs / 3))
    this.heartbeat.unref()
    return hello
  }

  /** Identify the local client, reporting a connection that closed during startup as such. */
  private async probeClient(): Promise<boolean> {
    try {
      return await probeSshClient(AbortSignal.any([this.lifetime.signal, AbortSignal.timeout(this.config.requestTimeoutMs)]))
    } catch (error) {
      if (this.closed) throw new Error('SSH connection closed before startup')
      throw error
    }
  }
}

/**
 * Identify the local SSH client before any connection work, so a missing or unusable client fails loudly.
 * @param signal - cancellation of the probe, bounded by the caller's startup deadline.
 * @returns whether one master may carry the administrative stream and command-line forwards.
 */
function probeSshClient(signal: AbortSignal): Promise<boolean> {
  return new Promise((resolve, reject) => {
    execFile('ssh', ['-V'], { signal, maxBuffer: PROBE_MAX_BYTES, windowsHide: true }, (error, stdout, stderr) => {
      // OpenSSH writes its banner to standard error and exits zero.
      const identified = OPENSSH_BANNER.test(`${stdout}${stderr}`)
      if (!signal.aborted && (error === null || identified)) {
        resolve(multiplexesClient(process.platform, identified))
        return
      }
      const detail = signal.aborted
        ? `the probe was cancelled${signal.reason instanceof Error ? `: ${signal.reason.message}` : ''}`
        : error === null ? 'the client answered without a version banner' : error.message
      reject(new Error(`SSH client 'ssh' is unusable on ${process.platform}: ${detail}`))
    })
  })
}

/**
 * Decide whether one master may carry the administrative stream and command-line forwards.
 * Win32-OpenSSH multiplexing and Unix-socket forwarding are unverified, so a Windows host always
 * forwards per stream; a POSIX host multiplexes only on an identified OpenSSH client.
 * @param platform - the local host platform.
 * @param identified - whether the client answered as OpenSSH.
 * @returns whether the shared-master arrangement is available.
 */
function multiplexesClient(platform: NodeJS.Platform, identified: boolean): boolean {
  return platform !== 'win32' && identified
}

/** Resolve once one socket is connected; reject on its error, close, or the caller's cancellation. */
function awaitConnection(socket: Socket, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const cleanup = (): void => {
      signal.removeEventListener('abort', aborted)
      socket.off('connect', connected)
      socket.off('error', failed)
      socket.off('close', closed)
    }
    const connected = (): void => { cleanup(); resolve() }
    const failed = (error: Error): void => { cleanup(); reject(error) }
    const closed = (): void => { failed(new Error('SSH connection closed before stream establishment')) }
    const aborted = (): void => { socket.destroy(signal.reason instanceof Error ? signal.reason : new Error(String(signal.reason))) }
    socket.once('connect', connected)
    socket.once('error', failed)
    socket.once('close', closed)
    signal.addEventListener('abort', aborted, { once: true })
  })
}

/** Whether a failed connection attempt only means the forwarding listener is not bound yet. */
function refusedConnection(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ECONNREFUSED'
}

export default SshConnection
