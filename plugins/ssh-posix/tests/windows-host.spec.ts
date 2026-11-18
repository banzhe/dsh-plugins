/** Windows-host startup, per-stream forwarding, client probing, and target-shell parity for this fork. */
import { EventEmitter } from 'node:events'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Duplex, PassThrough } from 'node:stream'
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { z } from 'zod'
import { SshConnection } from '../src/index.ts'
import type { Config } from '../src/index.ts'
import { SshRpcPeer } from '../src/protocol.ts'
import { launchCommand } from '../src/target-shell.ts'

const transport = vi.hoisted(() => ({ spawn: vi.fn(), exec: vi.fn(), connect: vi.fn(), tls: vi.fn(), directory: vi.fn(), remove: vi.fn() }))
vi.mock('node:child_process', async original => ({ ...await original<typeof import('node:child_process')>(), spawn: transport.spawn, execFile: transport.exec }))
vi.mock('node:net', async original => ({ ...await original<typeof import('node:net')>(), createConnection: transport.connect }))
vi.mock('node:tls', async original => ({ ...await original<typeof import('node:tls')>(), connect: transport.tls }))
vi.mock('node:fs/promises', async original => ({ ...await original<typeof import('node:fs/promises')>(), mkdtemp: transport.directory, rm: transport.remove }))

const POSIX_BANNER = 'OpenSSH_9.9p1, LibreSSL 3.8.2'
const WINDOWS_BANNER = 'OpenSSH_for_Windows_9.5p1, LibreSSL 3.8.2'

class Stream extends Duplex {
  override _read(): void {}
  override _write(_bytes: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void { callback() }
  disableRenegotiation(): void {}
}

class Child extends EventEmitter {
  readonly stdin = new PassThrough()
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()
  readonly signals: string[] = []
  exitCode: number | null = null
  signalCode: NodeJS.Signals | null = null
  ignoreTerm = false
  holdClose = false
  private closed = false
  kill(signal: NodeJS.Signals = 'SIGTERM'): boolean {
    this.signals.push(signal)
    if (this.holdClose || (this.ignoreTerm && signal !== 'SIGKILL')) return true
    this.settle(signal === 'SIGKILL' ? null : 0, signal === 'SIGKILL' ? signal : null)
    return true
  }
  /** End the process once, recording how it ended before the close event. */
  settle(code: number | null, termination: NodeJS.Signals | null): void {
    if (this.closed) return
    this.closed = true
    this.exitCode = code
    this.signalCode = termination
    queueMicrotask(() => { this.emit('close', code, termination) })
  }
  /** Report a spawn failure on the next microtask, as ChildProcess does. */
  failWith(error: Error): void {
    queueMicrotask(() => { this.emit('error', error) })
  }
}

const config: Config = {
  host: 'test-alias', launch: { kind: 'node-script', node: '/remote/node' }, helper: '/remote/helper.js',
  helperHash: 'a'.repeat(64), workspace: '/remote/workspace',
  requestTimeoutMs: 1000, maxFrameBytes: 4096, maxPending: 8, leaseMs: 30_000,
}
const hello = {
  protocol: 3, hash: 'a'.repeat(64), platform: 'linux', nodeVersion: 'v24.19.0',
  kind: 'node-script', executable: '/canonical/node', root: '/tmp/remote-helper', workspace: '/canonical/workspace',
}

/** A refused loopback connection, as a listener the client has not bound yet reports it. */
const REFUSED = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1'), { code: 'ECONNREFUSED' })

interface SetupOptions {
  platform?: NodeJS.Platform
  banner?: string
  probeFailure?: Error
  refusedOnce?: Error
  /** Fail every loopback connection attempt, so only the deadline or an exit ends the wait. */
  refuseAll?: boolean
  /** Shorten the connection deadline for the retry boundaries. */
  requestTimeoutMs?: number
  /** Prepare each spawned stream child before the service sees it. */
  streamChild?: (child: Child) => void
}

function setup(options: SetupOptions = {}) {
  const platform = vi.spyOn(process, 'platform', 'get').mockReturnValue(options.platform ?? 'win32')
  const ctx = new Context()
  const master = new Child()
  const streamChildren: Child[] = []
  const sockets: Stream[] = []
  const secure = new Stream()
  const calls: { method: string; params: unknown }[] = []
  const helper = new SshRpcPeer(master.stdin, master.stdout, 4096, 8, async (method, params) => {
    calls.push({ method, params })
    if (method === 'hello') return hello
    if (method === 'echo') return params
    if (method === 'heartbeat' || method === 'close') return null
    throw new Error(`unexpected helper request ${method}`)
  })
  transport.directory.mockResolvedValue('/virtual/ssh-startup')
  transport.remove.mockResolvedValue(undefined)
  let spawnedMaster = false
  transport.spawn.mockImplementation(() => {
    if (!spawnedMaster) { spawnedMaster = true; return master }
    const child = new Child()
    options.streamChild?.(child)
    streamChildren.push(child)
    return child
  })
  transport.exec.mockImplementation((
    _file: string, args: string[], _options: unknown,
    callback: (error: Error | null, stdout: string, stderr: string) => void,
  ) => {
    const command = new Child()
    queueMicrotask(() => {
      if (!args.includes('-V')) callback(null, '', '')
      else if (options.probeFailure === undefined) callback(null, '', options.banner ?? WINDOWS_BANNER)
      else callback(options.probeFailure, '', '')
      command.kill()
    })
    return command
  })
  let refused = options.refusedOnce
  transport.connect.mockImplementation(() => {
    const socket = new Stream()
    sockets.push(socket)
    const failure = options.refuseAll === true ? REFUSED : refused
    refused = undefined
    if (failure !== undefined) queueMicrotask(() => { socket.emit('error', failure) })
    else queueMicrotask(() => { socket.emit('connect') })
    return socket
  })
  transport.tls.mockImplementation((settings: { socket: Stream }) => {
    settings.socket.on('error', (error: Error) => { secure.destroy(error) })
    settings.socket.once('close', () => { secure.destroy() })
    secure.once('close', () => { settings.socket.destroy() })
    queueMicrotask(() => { secure.emit('secureConnect') })
    return secure
  })
  const service = new SshConnection(ctx, options.requestTimeoutMs === undefined ? config : { ...config, requestTimeoutMs: options.requestTimeoutMs })
  onTestFinished(async () => {
    for (const socket of sockets) socket.destroy()
    secure.destroy()
    try { await service.dispose() } finally {
      helper.close()
      master.kill()
      await ctx.fiber.dispose()
      platform.mockRestore()
      vi.restoreAllMocks()
      for (const mock of Object.values(transport)) mock.mockReset()
    }
  })
  return { service, master, streamChildren, sockets, secure, calls }
}

/** The value following -L in one spawned argument list. */
function forwardSpec(args: readonly string[]): string {
  const index = args.indexOf('-L')
  const spec = args[index + 1]
  if (index < 0 || spec === undefined) throw new Error('the stream child carries no -L specification')
  return spec
}

/** Arguments of one spawned connection, in spawn order. */
function spawnArguments(index: number): string[] {
  const call = transport.spawn.mock.calls[index]
  if (call === undefined) throw new Error(`the service spawned no connection at index ${index}`)
  return call[1] as string[]
}

describe('Windows host', () => {
  it('starts instead of refusing the platform', async () => {
    const test = setup()
    await test.service.ready
    expect(transport.spawn).toHaveBeenCalled()
    expect(spawnArguments(0)).not.toContain('-M')
    expect(spawnArguments(0)).not.toContain('-S')
    expect(test.calls[0]?.method).toBe('hello')
  })

  it('forwards a stream through a loopback listener instead of a Unix socket', async () => {
    const test = setup()
    await test.service.ready
    const socket = await test.service.connectStream({ path: '/tmp/remote-helper/control', capability: 'b'.repeat(64) })
    expect(socket).toBe(test.secure)
    const args = spawnArguments(1)
    const spec = forwardSpec(args)
    expect(spec).toMatch(/^127\.0\.0\.1:\d+:\/tmp\/remote-helper\/control$/u)
    const port = Number(spec.split(':')[1])
    expect(port).toBeGreaterThan(0)
    expect(port).toBeLessThanOrEqual(65_535)
    expect(transport.connect).toHaveBeenCalledWith({ host: '127.0.0.1', port, allowHalfOpen: true })
    // The forwarding child keeps the shared-master options out, including the one that would drop -L.
    expect(args).not.toContain('-M')
    expect(args).not.toContain('ClearAllForwardings=yes')
    expect(test.streamChildren).toHaveLength(1)
  })

  it('retries the loopback connection while the forwarding still authenticates', async () => {
    const test = setup({ refusedOnce: REFUSED })
    await test.service.ready
    const socket = await test.service.connectStream({ path: '/tmp/remote-helper/control', capability: 'b'.repeat(64) })
    expect(socket).toBe(test.secure)
    expect(test.sockets.length).toBe(2)
    expect(test.sockets[0]?.destroyed).toBe(true)
  })

  it('reclaims the forwarding child when the stream socket closes', async () => {
    const test = setup()
    await test.service.ready
    const socket = await test.service.connectStream({ path: '/tmp/remote-helper/control', capability: 'b'.repeat(64) })
    socket.destroy()
    await expect.poll(() => test.streamChildren[0]?.signals).toContain('SIGTERM')
    await test.service.dispose()
    // No shared master, so no control socket and no directory to release.
    expect(transport.directory).not.toHaveBeenCalled()
    expect(transport.remove).not.toHaveBeenCalled()
    expect(test.master.signals).toContain('SIGTERM')
  })

  it('spawns the per-stream client with the shipped options and the loopback forward', async () => {
    const test = setup()
    await test.service.ready
    await test.service.connectStream({ path: '/tmp/remote-helper/control', capability: 'b'.repeat(64) })
    const args = spawnArguments(1)
    const port = Number(forwardSpec(args).split(':')[1])
    expect(args).toEqual([
      '-T', '-N', '-L', `127.0.0.1:${port}:/tmp/remote-helper/control`, '-o', 'ExitOnForwardFailure=yes',
      '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'ForwardAgent=no',
      '-o', 'ServerAliveInterval=10', '-o', 'ServerAliveCountMax=3', 'test-alias',
    ])
  })

  it('reports a spawn failure as the stream failure', async () => {
    const failure = new Error('spawn ssh ENOENT')
    const test = setup({ refuseAll: true, streamChild: child => { child.failWith(failure) } })
    await test.service.ready
    await expect(test.service.connectStream({ path: '/tmp/remote-helper/control', capability: 'b'.repeat(64) })).rejects.toBe(failure)
  })

  it('reports how a stream child ended before its listener accepted', async () => {
    const test = setup({ refuseAll: true, streamChild: child => { child.exitCode = 255 } })
    await test.service.ready
    await expect(test.service.connectStream({ path: '/tmp/remote-helper/control', capability: 'b'.repeat(64) }))
      .rejects.toThrow(/exited \(exit code 255\) before 127\.0\.0\.1:\d+ accepted a connection/u)
  })

  it('stops retrying when the forwarding deadline expires', async () => {
    const test = setup({ refuseAll: true, requestTimeoutMs: 120 })
    await test.service.ready
    await expect(test.service.connectStream({ path: '/tmp/remote-helper/control', capability: 'b'.repeat(64) }))
      .rejects.toThrow(/did not accept a connection on 127\.0\.0\.1:\d+/u)
  })
  it('reports the signal that ended a stream child before its listener accepted', async () => {
    const test = setup({ refuseAll: true, streamChild: child => { child.signalCode = 'SIGTERM' } })
    await test.service.ready
    await expect(test.service.connectStream({ path: '/tmp/remote-helper/control', capability: 'b'.repeat(64) }))
      .rejects.toThrow(/exited \(signal SIGTERM\) before 127\.0\.0\.1:\d+ accepted a connection/u)
  })

  it('appends the client standard-error tail to a stream failure', async () => {
    const test = setup({
      refuseAll: true,
      requestTimeoutMs: 120,
      streamChild: child => { child.stderr.write('Permission denied (publickey)\n') },
    })
    await test.service.ready
    await expect(test.service.connectStream({ path: '/tmp/remote-helper/control', capability: 'b'.repeat(64) }))
      .rejects.toThrow(/: Permission denied \(publickey\)$/u)
  })

  it('keeps only the trailing standard-error window in that message', async () => {
    const test = setup({
      refuseAll: true,
      requestTimeoutMs: 120,
      streamChild: child => { child.stderr.write(`${'A'.repeat(8 * 1024)}Z`) },
    })
    await test.service.ready
    const failure = await test.service.connectStream({ path: '/tmp/remote-helper/control', capability: 'b'.repeat(64) })
      .then(() => undefined, (error: unknown) => error)
    expect(failure).toBeInstanceOf(Error)
    const message = failure instanceof Error ? failure.message : ''
    expect(message.endsWith('Z')).toBe(true)
    expect(message).not.toContain('A'.repeat(4 * 1024))
    expect(message.length).toBeLessThan(4 * 1024 + 200)
  })

  it('kills a stream child that ignores SIGTERM before disposal completes', async () => {
    const test = setup({ requestTimeoutMs: 60, streamChild: child => { child.ignoreTerm = true } })
    await test.service.ready
    await test.service.connectStream({ path: '/tmp/remote-helper/control', capability: 'b'.repeat(64) })
    const child = test.streamChildren[0]
    await test.service.dispose()
    expect(child?.signals).toContain('SIGTERM')
    expect(child?.signals).toContain('SIGKILL')
    expect(child?.signalCode).toBe('SIGKILL')
  })

  it('joins a live stream child during disposal instead of leaving its listener behind', async () => {
    const test = setup({ streamChild: child => { child.holdClose = true } })
    await test.service.ready
    await test.service.connectStream({ path: '/tmp/remote-helper/control', capability: 'b'.repeat(64) })
    const child = test.streamChildren[0]
    let disposed = false
    const disposal = test.service.dispose().then(() => { disposed = true })
    await expect.poll(() => child?.signals).toContain('SIGTERM')
    await new Promise<void>((resolve) => { setImmediate(resolve) })
    expect(disposed).toBe(false)
    child?.settle(0, null)
    await disposal
    expect(disposed).toBe(true)
  })
})

describe('POSIX host parity', () => {
  it('allocates its temporary directory under the operating system temporary directory', async () => {
    const test = setup({ platform: 'linux', banner: POSIX_BANNER })
    await test.service.ready
    expect(transport.directory).toHaveBeenCalledWith(join(tmpdir(), 'dsh-ssh-'))
    expect(transport.remove).not.toHaveBeenCalled()
  })

  it('spawns the shipped master arguments and remote command verbatim', async () => {
    const test = setup({ platform: 'linux', banner: POSIX_BANNER })
    await test.service.ready
    expect(spawnArguments(0)).toEqual([
      '-T', '-M', '-S', join('/virtual/ssh-startup', 'master'), '-o', 'ControlPersist=no', '-o', 'BatchMode=yes',
      '-o', 'StrictHostKeyChecking=yes', '-o', 'ForwardAgent=no', '-o', 'ClearAllForwardings=yes',
      '-o', 'ServerAliveInterval=10', '-o', 'ServerAliveCountMax=3', 'test-alias',
      "'/remote/node' '--disable-sigusr1' '/remote/helper.js'",
    ])
    await test.service.dispose()
    expect(transport.remove).toHaveBeenCalledWith('/virtual/ssh-startup', { recursive: true, force: true })
  })
})

describe('Remote target shell', () => {
  it('quotes every executable path the shipped helper invocation quotes', () => {
    expect(launchCommand({ kind: 'node-script', node: '/remote/node' }, "/remote/helper's file.js"))
      .toEqual({ command: "'/remote/node' '--disable-sigusr1' '/remote/helper'\\''s file.js'" })
    expect(launchCommand({ kind: 'node-script', node: '/remote/node', bootstrapPath: '/remote/process.js', bootstrapHash: 'b'.repeat(64) }, '/remote/helper.js'))
      .toEqual({ command: "'/remote/node' '--disable-sigusr1' '/remote/helper.js'", bootstrapPath: '/remote/process.js', bootstrapHash: 'b'.repeat(64) })
    expect(launchCommand({ kind: 'executable' }, '/remote/helper with spaces'))
      .toEqual({ command: "NODE_OPTIONS='--disable-sigusr1' '/remote/helper with spaces'" })
    expect(launchCommand({ kind: 'executable' }, 'plain')).toEqual({ command: "NODE_OPTIONS='--disable-sigusr1' 'plain'" })
  })
})

describe('Local SSH client probe', () => {
  it('fails loudly when the client is unusable', async () => {
    const failure = new Error('spawn ssh ENOENT')
    const test = setup({ probeFailure: failure })
    await expect(test.service.ready).rejects.toThrow(`SSH client 'ssh' is unusable on win32: spawn ssh ENOENT`)
    expect(transport.spawn).not.toHaveBeenCalled()
    expect(transport.directory).not.toHaveBeenCalled()
    await expect(test.service.request('echo', {}, z.unknown())).rejects.toThrow(/unusable on win32/u)
  })

  it('falls back to per-stream forwarding when the client does not multiplex', async () => {
    const test = setup({ platform: 'linux', banner: 'Sun_SSH_1.5, SSH protocol 2.0' })
    await test.service.ready
    expect(spawnArguments(0)).not.toContain('-M')
    expect(transport.directory).not.toHaveBeenCalled()
  })
})
