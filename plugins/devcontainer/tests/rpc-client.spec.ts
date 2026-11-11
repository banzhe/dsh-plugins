import { spawn as spawnProcess } from 'node:child_process'
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs'
import { join, posix } from 'node:path'
import { PassThrough, Writable } from 'node:stream'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { HELPER_CONTAINER_PATH } from '../src/helper-source.ts'
import { ContainerRpcChannel, runtimeExecArgv } from '../src/rpc/client.ts'
import type { ChannelTarget, ContainerChild, ContainerChildSpawn } from '../src/rpc/client.ts'
import { RpcOperationError } from '../src/rpc/errors.ts'
import { encodeFrame, FrameDecoder, RPC_PROTOCOL_VERSION } from '../src/rpc/frames.ts'
import { ContainerRpcPool } from '../src/rpc/pool.ts'
import { cleanupTemporaryDirectories, fakeContainer, temporaryDirectory } from './support.ts'

afterAll(cleanupTemporaryDirectories)

/** A repository tree on this host, and the POSIX spelling the helper accepts as its workspace. */
function workspaceTree(files: Record<string, string> = {}): { root: string, workspace: string } {
  const source = temporaryDirectory()
  for (const [relative, content] of Object.entries(files)) {
    const absolute = join(source, ...relative.split('/'))
    mkdirSync(join(absolute, '..'), { recursive: true })
    writeFileSync(absolute, content, 'utf8')
  }
  const root = realpathSync(source)
  return { root, workspace: root.split('\\').join('/') }
}

/**
 * A spawn stand-in whose helper completes the handshake and never drains again.
 *
 * Every write is over the mark, so the channel always waits for a drain; this
 * pipe drains the handshake only, which is what a container stuck behind a full
 * stdin looks like from the host side.
 */
function stalledSpawn(): ContainerChildSpawn {
  return (argv) => {
    if (argv.includes('sh')) {
      const stdin = new Writable({ write(_chunk, _encoding, callback) { callback() } })
      const exited = new Promise<{ code: number | null, signal: string | null }>((resolve) => {
        stdin.on('finish', () => { resolve({ code: 0, signal: null }) })
      })
      return { stdin, stdout: new PassThrough(), stderr: new PassThrough(), exited, kill: () => {} }
    }
    const stdout = new PassThrough()
    const decoder = new FrameDecoder()
    const stdin = new Writable({
      highWaterMark: 1,
      write(chunk: Buffer, _encoding, _callback) {
        for (const frame of decoder.push(Buffer.from(chunk))) {
          if (frame.type !== 'request' || frame.method !== 'hello') continue
          stdout.write(encodeFrame({
            type: 'result',
            id: frame.id,
            value: {
              protocol: RPC_PROTOCOL_VERSION,
              platform: 'linux',
              nodeVersion: 'v22.0.0',
              workspace: '/workspaces/demo',
              workspaceReal: '/workspaces/demo',
            },
          }))
          setImmediate(() => { stdin.emit('drain') })
        }
        // The callback is never called, so later frames stay buffered and the
        // pipe reports no further drain.
      },
    })
    return {
      stdin,
      stdout,
      stderr: new PassThrough(),
      exited: new Promise<{ code: number | null, signal: string | null }>(() => {}),
      kill: () => {},
    }
  }
}

/** A spawn stand-in whose container refuses the staged helper. */
function refusingSpawn(message: string): ContainerChildSpawn {
  return () => {
    const stdin = new Writable({ write(_chunk, _encoding, callback) { callback() } })
    const stderr = new PassThrough()
    const exited = new Promise<{ code: number | null, signal: string | null }>((resolve) => {
      // The reader attaches its listener before the process fails, exactly as a
      // real child reports its stderr before it exits.
      setTimeout(() => {
        stderr.write(message)
        resolve({ code: 125, signal: null })
      }, 0)
    })
    const child: ContainerChild = {
      stdin,
      stdout: new PassThrough(),
      stderr,
      exited,
      kill: () => {},
    }
    return child
  }
}
describe('the container channel', () => {
  it('stages the helper and completes the handshake', async () => {
    const container = fakeContainer()
    const { workspace } = workspaceTree()
    const channel = await ContainerRpcChannel.open({
      target: { kind: 'docker', containerId: 'demo', workspace }, spawn: container.spawn, timeoutMs: 30_000,
    })
    try {
      expect(channel.isClosed).toBe(false)
      expect(channel.handshake.protocol).toBe(3)
      expect(channel.handshake.workspace).toBe(workspace)
      expect(container.spawns).toHaveLength(2)
      expect(container.spawns[0]?.slice(0, 5)).toEqual(['docker', 'exec', '-i', 'demo', 'sh'])
      expect(container.spawns[1]?.slice(0, 5)).toEqual(['docker', 'exec', '-i', 'demo', 'node'])
    } finally {
      await channel.close()
    }
  })

  it('stages and starts the helper through the sandbox CLI', async () => {
    const container = fakeContainer()
    const { workspace } = workspaceTree()
    const channel = await ContainerRpcChannel.open({
      target: { kind: 'sbx', sandboxName: 'dsh-demo', workspace }, spawn: container.spawn, timeoutMs: 30_000,
    })
    try {
      expect(channel.handshake.workspace).toBe(workspace)
      // `sbx exec` separates its own flags from the command with `--`, and the
      // helper is staged and started exactly as it is in a container.
      expect(container.spawns[0]?.slice(0, 6)).toEqual(['sbx', 'exec', '-i', 'dsh-demo', '--', 'sh'])
      expect(container.spawns[1]).toEqual(['sbx', 'exec', '-i', 'dsh-demo', '--', 'node', HELPER_CONTAINER_PATH])
    } finally {
      await channel.close()
    }
  })

  it('answers requests over the pipe', async () => {
    const container = fakeContainer()
    const { workspace } = workspaceTree({ 'src/a.ts': 'export {}\n' })
    const channel = await ContainerRpcChannel.open({
      target: { kind: 'docker', containerId: 'demo', workspace }, spawn: container.spawn, timeoutMs: 30_000,
    })
    try {
      const target = await channel.request<{ targetKey: string }>('fs.resolve', { path: posix.join(workspace, 'src/a.ts') })
      expect(target.targetKey.split('\\').join('/').endsWith('src/a.ts')).toBe(true)
      expect(await channel.request('fs.readText', { target })).toBe('export {}\n')
      await expect(channel.ping()).resolves.toMatchObject({ pong: true })
    } finally {
      await channel.close()
    }
  })

  it('reports a remote failure with its filesystem code', async () => {
    const container = fakeContainer()
    const { workspace } = workspaceTree()
    const channel = await ContainerRpcChannel.open({
      target: { kind: 'docker', containerId: 'demo', workspace }, spawn: container.spawn, timeoutMs: 30_000,
    })
    try {
      const failure = await channel.request('fs.readText', {
        target: { targetKey: posix.join(workspace, 'missing.ts'), displayPath: 'missing.ts' },
      }).catch((error: unknown) => error)
      expect(failure).toBeInstanceOf(RpcOperationError)
      expect((failure as RpcOperationError).code).toBe('FS_NOT_FOUND')
    } finally {
      await channel.close()
    }
  })

  it('refuses a request after the channel closed', async () => {
    const container = fakeContainer()
    const { workspace } = workspaceTree()
    const channel = await ContainerRpcChannel.open({
      target: { kind: 'docker', containerId: 'demo', workspace }, spawn: container.spawn, timeoutMs: 30_000,
    })
    await channel.close()
    expect(channel.isClosed).toBe(true)
    await expect(channel.request('ping', {})).rejects.toThrow('closed')
  })
  it('honours a cancelled request without poisoning the channel', async () => {
    const container = fakeContainer()
    const { workspace } = workspaceTree()
    const channel = await ContainerRpcChannel.open({
      target: { kind: 'docker', containerId: 'demo', workspace }, spawn: container.spawn, timeoutMs: 30_000,
    })
    try {
      const aborted = AbortSignal.abort(new Error('caller gave up'))
      await expect(channel.request('ping', {}, { signal: aborted })).rejects.toThrow('gave up')
      await expect(channel.ping()).resolves.toMatchObject({ pong: true })
    } finally {
      await channel.close()
    }
  })

  it('ends a request whose frame a stuck pipe will not take', async () => {
    const channel = await ContainerRpcChannel.open({
      target: { kind: 'docker', containerId: 'demo', workspace: '/workspaces/demo' },
      spawn: stalledSpawn(),
      timeoutMs: 30_000,
    })
    const controller = new AbortController()
    const pending = channel.request('ping', {}, { signal: controller.signal })
    setTimeout(() => { controller.abort() }, 20)
    await expect(pending).rejects.toThrow('"ping" was cancelled')
    // The buffered bytes leave the pipe wedged, so the channel is reset rather
    // than leaving every later write queued behind them.
    expect(channel.isClosed).toBe(true)
  })

  it('ends a write that outlived its budget', async () => {
    const channel = await ContainerRpcChannel.open({
      target: { kind: 'docker', containerId: 'demo', workspace: '/workspaces/demo' },
      spawn: stalledSpawn(),
      timeoutMs: 30_000,
    })
    await expect(channel.request('ping', {}, { timeoutMs: 50 })).rejects.toThrow('timed out after 50 ms')
    expect(channel.isClosed).toBe(true)
  })

  it('reports a helper that never answers its handshake as a timeout', async () => {
    const container = fakeContainer()
    const silent: ContainerChildSpawn = (argv, options) => {
      if (argv[4] === 'sh') return container.spawn(argv, options)
      const child = spawnProcess(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      })
      child.stdin.on('error', () => {})
      return {
        stdin: child.stdin,
        stdout: child.stdout,
        stderr: child.stderr,
        exited: new Promise((resolve) => { child.once('exit', (code, signal) => { resolve({ code, signal }) }) }),
        kill: (signal?: NodeJS.Signals) => { child.kill(signal) },
      }
    }
    await expect(ContainerRpcChannel.open({
      target: { kind: 'docker', containerId: 'demo', workspace: '/workspaces/demo' }, spawn: silent, timeoutMs: 200,
    })).rejects.toThrow('timed out after 200 ms')
  })

  it('fails everything pending when the container dies', async () => {
    const container = fakeContainer()
    const { workspace } = workspaceTree()
    const channel = await ContainerRpcChannel.open({
      target: { kind: 'docker', containerId: 'demo', workspace }, spawn: container.spawn, timeoutMs: 30_000,
    })
    container.crash()
    await channel.closedPromise
    expect(channel.isClosed).toBe(true)
    await expect(channel.request('ping', {})).rejects.toThrow(/stopped|closed/)
  })

  it('reports why the container refused the helper', async () => {
    const opening = ContainerRpcChannel.open({
      target: { kind: 'docker', containerId: 'gone', workspace: '/workspaces/demo' },
      spawn: refusingSpawn('Error: No such container: gone'),
      timeoutMs: 30_000,
    })
    await expect(opening).rejects.toThrow('cannot stage the filesystem helper in container "gone"')
    await expect(ContainerRpcChannel.open({
      target: { kind: 'docker', containerId: 'gone', workspace: '/workspaces/demo' },
      spawn: refusingSpawn('Error: No such container: gone'),
      timeoutMs: 30_000,
    })).rejects.toThrow('No such container: gone')
  })

  it('reports a pipe that carried prose instead of RPC frames', async () => {
    const container = fakeContainer()
    const { workspace } = workspaceTree()
    // A runtime without a `node` for the helper answers its pipe with its own
    // exec diagnostic; "exec" reads as a 1702389091-byte frame header.
    const prose: ContainerChildSpawn = (argv, options) => {
      if (argv.includes('sh')) return container.spawn(argv, options)
      const stdout = new PassThrough()
      const exited = new Promise<{ code: number | null, signal: string | null }>((resolve) => {
        setTimeout(() => {
          stdout.write('exec: "node": executable file not found in $PATH')
          stdout.end()
          resolve({ code: 1, signal: null })
        }, 0)
      })
      return {
        stdin: new Writable({ write(_chunk, _encoding, callback) { callback() } }),
        stdout,
        stderr: new PassThrough(),
        exited,
        kill: () => {},
      }
    }
    const failure = await ContainerRpcChannel.open({
      target: { kind: 'sbx', sandboxName: 'dsh-empty', workspace }, spawn: prose, timeoutMs: 30_000,
    }).catch((error: unknown) => error) as Error
    expect(failure.message).toContain('the filesystem helper could not be started in sandbox "dsh-empty" (exit 1)')
    expect(failure.message).toContain('answered its pipe with text instead of RPC frames')
    expect(failure.message).toContain('executable file not found')
    expect(failure.message).not.toMatch(/\d+-byte RPC frame/)
  })

  it('reports a container that has no node to run the helper', async () => {
    const container = fakeContainer()
    const { workspace } = workspaceTree()
    const spawn: ContainerChildSpawn = (argv, options) => {
      if (argv[4] === 'sh') return container.spawn(argv, options)
      return refusingSpawn('exec: node: executable file not found in PATH')(argv, options)
    }
    await expect(ContainerRpcChannel.open({
      target: { kind: 'docker', containerId: 'demo', workspace }, spawn, timeoutMs: 30_000,
    })).rejects.toThrow(/stopped|handshake|timed out/)
  })
})

describe('runtimeExecArgv', () => {
  it('asks the driver for the runtime endpoint the target names', () => {
    expect(runtimeExecArgv({ kind: 'docker', containerId: 'abc', workspace: '/w' }, ['node', 'x']))
      .toEqual(['docker', 'exec', '-i', 'abc', 'node', 'x'])
    expect(runtimeExecArgv({ kind: 'sbx', sandboxName: 'box', workspace: '/w' }, ['node', 'x']))
      .toEqual(['sbx', 'exec', '-i', 'box', '--', 'node', 'x'])
  })
})

describe('the container channel pool', () => {
  it('reuses one channel and re-opens after the container dies', async () => {
    const container = fakeContainer()
    const { workspace } = workspaceTree()
    const pool = new ContainerRpcPool(container.spawn)
    try {
      const first = await pool.channel({ kind: 'docker', containerId: 'demo', workspace }, { timeoutMs: 30_000 })
      const again = await pool.channel({ kind: 'docker', containerId: 'demo', workspace }, { timeoutMs: 30_000 })
      expect(again).toBe(first)
      expect(container.spawns).toHaveLength(2)

      container.crash()
      await first.closedPromise
      const restarted = await pool.channel({ kind: 'docker', containerId: 'demo', workspace }, { timeoutMs: 30_000 })
      expect(restarted).not.toBe(first)
      await expect(restarted.ping()).resolves.toMatchObject({ pong: true })
      expect(container.spawns).toHaveLength(4)
    } finally {
      await pool.closeAll()
    }
  })

  /** One sandbox target with the extra roots its helper should be handshaken with. */
  function sandboxTarget(workspace: string, mounts: readonly string[]): ChannelTarget {
    return { kind: 'sbx', sandboxName: 'dsh-demo', workspace, mounts }
  }

  it('replaces the one channel when the extra roots differ, and closes the one it replaced', async () => {
    // The extra roots are part of the handshake, while the endpoint and workspace are
    // one channel: a row that changes hostMounts replaces it in place, so two rows
    // that disagree about the roots cannot evict each other's channel.
    const container = fakeContainer()
    const { workspace } = workspaceTree()
    const pool = new ContainerRpcPool(container.spawn)
    try {
      const first = await pool.channel(sandboxTarget(workspace, ['/d/agents.md']), { timeoutMs: 30_000 })
      const second = await pool.channel(sandboxTarget(workspace, ['/d/agents.md', '/d/skills']), { timeoutMs: 30_000 })
      expect(second).not.toBe(first)
      expect(first.isClosed).toBe(true)
      await expect(first.closedPromise).resolves.toBeUndefined()
      // The replacement is the one that answers, and it answers under the new roots.
      await expect(second.ping()).resolves.toMatchObject({ pong: true })
    } finally {
      await pool.closeAll()
    }
  })

  it('reuses the live channel for a caller that wants the same extra roots', async () => {
    // A second row asking for the same thing must not disturb the channel a request is
    // already running on: no close, no re-stage.
    const container = fakeContainer()
    const { workspace } = workspaceTree()
    const pool = new ContainerRpcPool(container.spawn)
    try {
      const first = await pool.channel(sandboxTarget(workspace, ['/d/agents.md']), { timeoutMs: 30_000 })
      const spawns = container.spawns.length
      const again = await pool.channel(sandboxTarget(workspace, ['/d/agents.md']), { timeoutMs: 30_000 })
      expect(again).toBe(first)
      expect(again.isClosed).toBe(false)
      expect(container.spawns).toHaveLength(spawns)
    } finally {
      await pool.closeAll()
    }
  })

  it('keeps one channel across A, B and back to A', async () => {
    const container = fakeContainer()
    const { workspace } = workspaceTree()
    const pool = new ContainerRpcPool(container.spawn)
    const a = ['/d/agents.md']
    const b = ['/d/agents.md', '/d/skills']
    try {
      const first = await pool.channel(sandboxTarget(workspace, a), { timeoutMs: 30_000 })
      const second = await pool.channel(sandboxTarget(workspace, b), { timeoutMs: 30_000 })
      const third = await pool.channel(sandboxTarget(workspace, a), { timeoutMs: 30_000 })
      // Each switch retires the channel it replaces, so nothing accumulates: two
      // closed channels, one live, and no helper left behind.
      expect(new Set([first, second, third]).size).toBe(3)
      await expect(first.closedPromise).resolves.toBeUndefined()
      await expect(second.closedPromise).resolves.toBeUndefined()
      expect(third.isClosed).toBe(false)
      await expect(third.ping()).resolves.toMatchObject({ pong: true })
    } finally {
      await pool.closeAll()
    }
  })


  /** A workspace spelling the stubbed pool only ever keys on: no helper runs for these. */
  function workspaceOf(): string {
    return '/f/personal/pool-demo'
  }

  /** A close a test can observe and hold open. */
  interface CloseHold {
    /** Resolves the moment the pool enters close(). */
    readonly entered: Promise<void>
    /** Lets the close finish. */
    readonly release: () => void
  }

  /** A channel the pool can hand out, with a close a test can hold open. */
  interface FakeChannel {
    readonly channel: ContainerRpcChannel
    /** Whether the pool closed it. */
    closed: () => boolean
    /** Hold the next close(), and report the moment it is entered. */
    holdClose: () => CloseHold
    /** Hold the next request() until the returned function is called. */
    holdRequest: () => () => void
  }

  function fakeChannel(): FakeChannel {
    let closed = false
    let releaseClose: (() => void) | undefined
    let entered: (() => void) | undefined
    const closedPromise = new Promise<void>((resolve) => { releaseClose = resolve })
    const enteredClose = new Promise<void>((resolve) => { entered = resolve })
    const held = { close: undefined as Promise<void> | undefined, request: undefined as Promise<void> | undefined }
    const channel = {
      isClosed: false,
      closedPromise,
      async close(): Promise<void> {
        entered?.()
        entered = undefined
        if (held.close !== undefined) await held.close
        if (closed) return
        closed = true
        ;(channel as { isClosed: boolean }).isClosed = true
        releaseClose?.()
      },
      async request(): Promise<unknown> {
        if (held.request !== undefined) await held.request
        return null
      },
      async ping(): Promise<{ pong: true }> { return { pong: true } },
    }
    return {
      channel: channel as unknown as ContainerRpcChannel,
      closed: () => closed,
      holdClose: () => {
        let release: () => void = () => {}
        held.close = new Promise<void>((resolve) => { release = resolve })
        return { entered: enteredClose, release: () => { release() } }
      },
      holdRequest: () => {
        let open: () => void = () => {}
        held.request = new Promise<void>((resolve) => { open = resolve })
        return open
      },
    }
  }

  /** A pool whose channels are the ones a test hands it, plus the record of what it made. */
  function stubbedPool(): { pool: ContainerRpcPool, made: FakeChannel[] } {
    const made: FakeChannel[] = []
    vi.spyOn(ContainerRpcChannel, 'open').mockImplementation(async () => {
      const fake = fakeChannel()
      made.push(fake)
      return fake.channel
    })
    return { pool: new ContainerRpcPool(() => { throw new Error('the stubbed pool opens nothing') }), made }
  }

  it('serialises a replacement, so a caller inside the close window cannot leak a channel', async () => {
    // The old race: B dropped the key, awaited close(), and only then put its channel
    // back — a C arriving in that window opened a third channel that B then overwrote,
    // leaving it running with nobody holding it.
    const { pool, made } = stubbedPool()
    const opts = { timeoutMs: 30_000 }
    try {
      const first = await pool.channel(sandboxTarget(workspaceOf(), ['/a']), opts)
      const hold = made[0]?.holdClose() ?? { entered: Promise.resolve(), release: () => {} }
      const second = pool.channel(sandboxTarget(workspaceOf(), ['/b']), opts)
      // Wait until the replacement is genuinely inside close(), then arrive with a
      // third request while it cannot possibly have written its channel yet.
      await hold.entered
      const third = pool.channel(sandboxTarget(workspaceOf(), ['/c']), opts)
      hold.release()
      const [middle, last] = await Promise.all([second, third])

      // Three channels were made, two were closed, exactly one is live — and it is the
      // one the last caller asked for, held by the pool under the same key.
      expect(made).toHaveLength(3)
      expect(made[0]?.closed()).toBe(true)
      expect(made[1]?.closed()).toBe(true)
      expect(made[2]?.closed()).toBe(false)
      expect(middle).not.toBe(first)
      expect(last).not.toBe(middle)
      await expect(pool.channel(sandboxTarget(workspaceOf(), ['/c']), opts)).resolves.toBe(last)
    } finally {
      vi.restoreAllMocks()
      await pool.closeAll()
    }
  })

  it('leaves an in-flight request alone when a caller asks for the same roots', async () => {
    const { pool, made } = stubbedPool()
    const opts = { timeoutMs: 30_000 }
    try {
      const first = await pool.channel(sandboxTarget(workspaceOf(), ['/a']), opts)
      const release = made[0]?.holdRequest() ?? (() => {})
      const inFlight = first.request('fs.resolve', { path: '/a/x' })
      const again = await pool.channel(sandboxTarget(workspaceOf(), ['/a']), opts)
      expect(again).toBe(first)
      expect(made[0]?.closed()).toBe(false)
      release()
      await expect(inFlight).resolves.toBeNull()
      expect(made).toHaveLength(1)
    } finally {
      vi.restoreAllMocks()
      await pool.closeAll()
    }
  })

  it('starts no helper for a replacement the closing pool no longer needs', async () => {
    // `closeAll` sets the flag, then drains the queues. A replacement already inside
    // close() finishes that close on the queue, then finds the pool closed: it spawns
    // nothing, and the channel it replaced is closed, so no helper is left running and
    // `closeAll` does not have to wait for one it would only close again.
    const { pool, made } = stubbedPool()
    const opts = { timeoutMs: 30_000 }
    await pool.channel(sandboxTarget(workspaceOf(), ['/a']), opts)
    const hold = made[0]?.holdClose() ?? { entered: Promise.resolve(), release: () => {} }
    const second = pool.channel(sandboxTarget(workspaceOf(), ['/b']), opts)
    await hold.entered
    const stopping = pool.closeAll()
    hold.release()

    await expect(second).rejects.toThrow('the container channel pool is closed')
    await stopping
    expect(made).toHaveLength(1)
    expect(made[0]?.closed()).toBe(true)
    await expect(pool.channel(sandboxTarget(workspaceOf(), ['/b']), opts))
      .rejects.toThrow('the container channel pool is closed')
  })

  it('closes the channel forget discards, and still opens a fresh one afterwards', async () => {
    const { pool, made } = stubbedPool()
    const opts = { timeoutMs: 30_000 }
    try {
      await pool.channel(sandboxTarget(workspaceOf(), ['/a']), opts)
      const hold = made[0]?.holdClose() ?? { entered: Promise.resolve(), release: () => {} }
      const replacing = pool.channel(sandboxTarget(workspaceOf(), ['/b']), opts)
      await hold.entered
      // Forget queues behind the replacement, so it discards the channel the replacement
      // installs — not the one it is busy closing — and closes it.
      const forgetting = pool.forget(sandboxTarget(workspaceOf(), ['/b']))
      hold.release()
      await replacing
      await forgetting
      expect(made[0]?.closed()).toBe(true)
      expect(made[1]?.closed()).toBe(true)

      const again = await pool.channel(sandboxTarget(workspaceOf(), ['/b']), opts)
      expect(again).toBe(made[2]?.channel)
      expect(made[2]?.closed()).toBe(false)
    } finally {
      vi.restoreAllMocks()
      await pool.closeAll()
    }
  })
  it('starts nothing once the pool is closed', async () => {
    const container = fakeContainer()
    const { workspace } = workspaceTree()
    const pool = new ContainerRpcPool(container.spawn)
    const first = await pool.channel(sandboxTarget(workspace, ['/a']), { timeoutMs: 30_000 })
    const spawns = container.spawns.length
    await pool.closeAll()

    // A closed pool neither starts a helper nor hands out the one it is closing.
    await expect(pool.channel(sandboxTarget(workspace, ['/a']), { timeoutMs: 30_000 }))
      .rejects.toThrow('the container channel pool is closed')
    expect(container.spawns).toHaveLength(spawns)
    expect(first.isClosed).toBe(true)
  })

  it('refuses a cached channel when the pool closed while the caller waited', async () => {
    // The reuse path would otherwise answer with a channel `closeAll` is about to close.
    const { pool, made } = stubbedPool()
    const opts = { timeoutMs: 30_000 }
    const first = await pool.channel(sandboxTarget(workspaceOf(), ['/a']), opts)
    expect(made[0]?.closed()).toBe(false)

    const stopping = pool.closeAll()
    // Queued behind the close, so it reaches the reuse path after the flag is set.
    const late = pool.channel(sandboxTarget(workspaceOf(), ['/a']), opts)
    await expect(late).rejects.toThrow('the container channel pool is closed')
    await stopping
    expect(first.isClosed).toBe(true)
  })
  it('does not lock a key when closing the replaced channel fails', async () => {
    const { pool, made } = stubbedPool()
    const opts = { timeoutMs: 30_000 }
    try {
      await pool.channel(sandboxTarget(workspaceOf(), ['/a']), opts)
      const first = made[0]?.channel as unknown as { close: () => Promise<void> }
      first.close = () => Promise.reject(new Error('the pipe is already gone'))
      const replaced = await pool.channel(sandboxTarget(workspaceOf(), ['/b']), opts)
      expect(replaced).toBe(made[1]?.channel)
      const again = await pool.channel(sandboxTarget(workspaceOf(), ['/b']), opts)
      expect(again).toBe(replaced)
    } finally {
      vi.restoreAllMocks()
      await pool.closeAll()
    }
  })

  it('tells apart two root lists that would join into the same token', async () => {
    const { pool, made } = stubbedPool()
    const opts = { timeoutMs: 30_000 }
    try {
      const joined = await pool.channel(sandboxTarget(workspaceOf(), ['/a,/b']), opts)
      const split = await pool.channel(sandboxTarget(workspaceOf(), ['/a', '/b']), opts)
      expect(split).not.toBe(joined)
      expect(made).toHaveLength(2)
    } finally {
      vi.restoreAllMocks()
      await pool.closeAll()
    }
  })

  it('does not cache a channel that failed to open', async () => {
    const pool = new ContainerRpcPool(refusingSpawn('boom'))
    await expect(pool.channel({ kind: 'docker', containerId: 'gone', workspace: '/workspaces/demo' }, { timeoutMs: 30_000 }))
      .rejects.toThrow('cannot stage')
    await expect(pool.channel({ kind: 'docker', containerId: 'gone', workspace: '/workspaces/demo' }, { timeoutMs: 30_000 }))
      .rejects.toThrow('cannot stage')
    await pool.closeAll()
  })
})