import { spawn as spawnProcess } from 'node:child_process'
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs'
import { join, posix } from 'node:path'
import { PassThrough, Writable } from 'node:stream'
import { afterAll, describe, expect, it } from 'vitest'
import { HELPER_CONTAINER_PATH } from '../src/helper-source.ts'
import { ContainerRpcChannel, runtimeExecArgv } from '../src/rpc/client.ts'
import type { ContainerChild, ContainerChildSpawn } from '../src/rpc/client.ts'
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

  it('does not cache a channel that failed to open', async () => {
    const pool = new ContainerRpcPool(refusingSpawn('boom'))
    await expect(pool.channel({ kind: 'docker', containerId: 'gone', workspace: '/workspaces/demo' }, { timeoutMs: 30_000 }))
      .rejects.toThrow('cannot stage')
    await expect(pool.channel({ kind: 'docker', containerId: 'gone', workspace: '/workspaces/demo' }, { timeoutMs: 30_000 }))
      .rejects.toThrow('cannot stage')
    await pool.closeAll()
  })
})
