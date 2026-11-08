import { afterAll, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { DevcontainerFileSystem } from '../src/fs.ts'
import type { ContainerRun } from '../src/exec.ts'
import { repoRegistry } from '../src/registry.ts'
import type { ContainerRpcChannel } from '../src/rpc/client.ts'
import { sandboxNameFor, sandboxWorkspacePath } from '../src/sbx.ts'
import { cleanupTemporaryDirectories, makeRepo } from './support.ts'

afterAll(cleanupTemporaryDirectories)

/** The workspace a Windows host mounts as `/f/personal/asmr-manager` in its sandbox. */
const HOST = 'F:\\personal\\asmr-manager'

/** The path that workspace has inside the sandbox. */
const MOUNT = '/f/personal/asmr-manager'

/** The preset the calling agent runs; a test retargets it between calls. */
interface Caller {
  /** A `…-sbx` preset id, or null for an ordinary one. */
  preset: string | null
}

/** One request the filesystem row sent over the channel. */
interface Recorded {
  readonly method: string
  readonly params: unknown
}

/** The row's channel stand-in, plus what it was asked for. */
interface SandboxChannel {
  readonly channel: ContainerRpcChannel
  readonly requests: Recorded[]
}

/**
 * A CLI stand-in that answers the two calls a sandbox probe makes.
 * @param listing - the `sbx ls --json` rows to report.
 * @returns the runner and every argv it was asked for.
 */
function sandboxCli(listing: readonly unknown[]): { calls: string[][], run: ContainerRun } {
  const calls: string[][] = []
  const run: ContainerRun = (argv) => {
    calls.push([...argv])
    if (argv[0] !== 'sbx') return Promise.resolve({ stdout: '', stderr: 'unexpected', exitCode: 1 })
    if (argv[1] === 'ls') return Promise.resolve({ stdout: JSON.stringify(listing), stderr: '', exitCode: 0 })
    if (argv[1] === 'exec') return Promise.resolve({ stdout: '/usr/local/bin/node\n', stderr: '', exitCode: 0 })
    return Promise.resolve({ stdout: '', stderr: '', exitCode: 0 })
  }
  return { calls, run }
}

/**
 * A channel stand-in for a container that holds one `src/a.ts` and nothing else.
 *
 * It answers in the container's own paths — the real helper resolves the mount
 * the sandbox reports — and records every request, so a test can assert which
 * path the row decided to send.
 * @param workspace - the folder the helper was started in.
 * @returns the channel and the requests it received.
 */
function sandboxChannel(workspace: string): SandboxChannel {
  const requests: Recorded[] = []
  const answer = (method: string, params: unknown): unknown => {
    const input = params as { path?: string, target?: { targetKey: string } }
    const path = input.path ?? input.target?.targetKey ?? ''
    switch (method) {
      case 'fs.resolve':
        return { targetKey: path, displayPath: path }
      case 'fs.lstat':
      case 'fs.stat':
        return { version: 'v1', type: path.endsWith('.ts') ? 'file' : 'directory', size: path.endsWith('.ts') ? 3 : undefined }
      case 'fs.readText':
        return 'body\n'
      case 'fs.list':
        return [{
          name: 'a.ts',
          type: 'file',
          target: { targetKey: `${path}/a.ts`, displayPath: `${path}/a.ts` },
          version: 'v1',
          size: 3,
        }]
      default:
        throw new Error(`unexpected request: ${method}`)
    }
  }
  const channel = {
    handshake: { workspace, workspaceReal: workspace },
    isClosed: false,
    closedPromise: Promise.resolve(),
    request: (method: string, params: unknown): Promise<unknown> => {
      requests.push({ method, params })
      return Promise.resolve(answer(method, params))
    },
  } as unknown as ContainerRpcChannel
  return { channel, requests }
}

/** Boot the row with the services it reads, bound to one sandbox. */
async function setup(
  root: string,
  listing: readonly unknown[],
  mount: string,
): Promise<{ fs: DevcontainerFileSystem, caller: Caller, mounted: SandboxChannel, calls: string[][] }> {
  repoRegistry().reset()
  const ctx = new Context()
  const caller: Caller = { preset: null }
  const session = {}
  const policy = {
    defaultMode: 'danger-full-access',
    resolve: () => ({ mode: 'danger-full-access', workspaceRoot: root }),
  }
  await ctx.plugin((child: Context) => {
    child.provide('sandboxPolicy' as string, policy)
    child.provide('agents' as string, { currentInitiator: () => ({ session }) })
    child.provide('agentPresets' as string, { presetForSession: () => caller.preset })
  })
  await ctx.plugin(DevcontainerFileSystem, { cwd: root })
  const fs = ctx.fs as DevcontainerFileSystem
  const cli = sandboxCli(listing)
  fs.containerInternals.run = cli.run
  const mounted = sandboxChannel(mount)
  fs.containerInternals.channel = async () => mounted.channel
  return { fs, caller, mounted, calls: cli.calls }
}

describe('a (sbx) session over a Windows workspace', () => {
  it('resolves the path its sandbox mounts the workspace at', async () => {
    const { fs, caller } = await setup(HOST, [{ name: sandboxNameFor(HOST), status: 'running' }], MOUNT)
    caller.preset = 'delegate-only-sbx'

    const target = await fs.resolve(MOUNT)
    expect(target.targetKey).toBe(MOUNT)
    expect(target.displayPath).toBe(MOUNT)
  })

  it('resolves a path below the mount point without rebuilding it from a host path', async () => {
    const { fs, caller, mounted } = await setup(HOST, [{ name: sandboxNameFor(HOST), status: 'running' }], MOUNT)
    caller.preset = 'delegate-only-sbx'

    const target = await fs.resolve(`${MOUNT}/src/a.ts`)
    expect(target.targetKey).toBe(`${MOUNT}/src/a.ts`)
    expect(mounted.requests[0]).toEqual({ method: 'fs.resolve', params: { path: `${MOUNT}/src/a.ts` } })
  })

  it('reads and lists below the mount point instead of refusing', async () => {
    const { fs, caller } = await setup(HOST, [{ name: sandboxNameFor(HOST), status: 'running' }], MOUNT)
    caller.preset = 'delegate-only-sbx'

    const file = await fs.resolve(`${MOUNT}/src/a.ts`)
    expect(await fs.readText(file)).toBe('body\n')
    expect(await fs.stat(file)).toMatchObject({ type: 'file', size: 3 })
    expect((await fs.lstat(`${MOUNT}/src`))?.type).toBe('directory')

    const listing = await fs.listDir(await fs.resolve(`${MOUNT}/src`))
    expect(listing.map(entry => entry.name)).toEqual(['a.ts'])
    expect(String(listing[0]?.target.targetKey)).toBe(`${MOUNT}/src/a.ts`)
  })

  it('translates the host spelling of the workspace into the mount point', async () => {
    const { fs, caller, mounted } = await setup(HOST, [{ name: sandboxNameFor(HOST), status: 'running' }], MOUNT)
    caller.preset = 'delegate-only-sbx'

    const target = await fs.resolve('F:\\personal\\asmr-manager\\src\\a.ts')
    expect(target.targetKey).toBe(`${MOUNT}/src/a.ts`)
    expect(mounted.requests[0]).toEqual({ method: 'fs.resolve', params: { path: `${MOUNT}/src/a.ts` } })
  })

  it('still refuses a sandbox path outside the workspace', async () => {
    const { fs, caller, mounted } = await setup(HOST, [{ name: sandboxNameFor(HOST), status: 'running' }], MOUNT)
    caller.preset = 'delegate-only-sbx'

    await expect(fs.resolve('/f/personal/elsewhere/secret.txt'))
      .rejects.toMatchObject({ code: 'FS_PERMISSION_DENIED' })
    // The refusal is local: nothing about it reached the container.
    expect(mounted.requests).toEqual([])
  })
})

describe('a (sbx) session over a repository that declares a container', () => {
  it('attributes the path its sandbox mounts the repository at to that repository', async () => {
    const root = makeRepo({ '.devcontainer/devcontainer.json': '{ "workspaceFolder": "/workspaces/demo" }', 'src/a.ts': '' })
    const mount = sandboxWorkspacePath(root) ?? root
    const { fs, caller } = await setup(root, [{ name: sandboxNameFor(root), status: 'running' }], mount)
    caller.preset = 'standard-sbx'

    // The declaration's `/workspaces/demo` is a directory the sandbox does not
    // have, so the path the sandbox really mounts the repository at has to be the
    // one recognised as inside it.
    const target = await fs.resolve(`${mount}/src/a.ts`)
    expect(target.targetKey).toBe(`${mount}/src/a.ts`)
    expect(await fs.readText(target)).toBe('body\n')
  })
})

describe('a (sbx) session whose sandbox reports its own mount', () => {
  it('uses the mount the listing reported instead of the host convention', async () => {
    const host = 'F:\\personal\\other-repo'
    const reported = '/workspace/other-repo'
    const { fs, caller, mounted } = await setup(
      host,
      [{ name: sandboxNameFor(host), status: 'running', mounts: [`${host}:${reported}`] }],
      reported,
    )
    caller.preset = 'delegate-only-sbx'

    const target = await fs.resolve(`${reported}/src/a.ts`)
    expect(target.targetKey).toBe(`${reported}/src/a.ts`)
    expect(mounted.requests[0]).toEqual({ method: 'fs.resolve', params: { path: `${reported}/src/a.ts` } })

    const fromHost = await fs.resolve('F:\\personal\\other-repo\\src\\a.ts')
    expect(fromHost.targetKey).toBe(`${reported}/src/a.ts`)
  })
})

describe('a (sbx) session whose row is configured with another directory', () => {
  it('attributes a sandbox path to the workspace its sandbox mounts', async () => {
    // One row serves every session on the host, so its configured cwd is the
    // directory DSH itself started in, not the session's workspace.
    const server = makeRepo({ 'main.ts': '' })
    const { fs, caller, mounted } = await setup(
      server,
      [{ name: sandboxNameFor(HOST), status: 'running', mounts: [`${HOST}:${MOUNT}`] }],
      MOUNT,
    )
    caller.preset = 'delegate-only-sbx'

    const target = await fs.resolve(MOUNT)
    expect(target.targetKey).toBe(MOUNT)
    expect(mounted.requests[0]).toEqual({ method: 'fs.resolve', params: { path: MOUNT } })
  })

  it('attributes a path below that workspace the same way', async () => {
    const server = makeRepo({ 'main.ts': '' })
    const { fs, caller, mounted } = await setup(
      server,
      [{ name: sandboxNameFor(HOST), status: 'running', mounts: [`${HOST}:${MOUNT}`] }],
      MOUNT,
    )
    caller.preset = 'delegate-only-sbx'

    const file = await fs.resolve(`${MOUNT}/src/a.ts`)
    expect(await fs.readText(file)).toBe('body\n')
    expect(mounted.requests.map(entry => entry.method)).toEqual(['fs.resolve', 'fs.readText'])
  })

  it('still refuses a sandbox path no mount covers', async () => {
    const server = makeRepo({ 'main.ts': '' })
    const { fs, caller, mounted } = await setup(
      server,
      [{ name: sandboxNameFor(HOST), status: 'running', mounts: [`${HOST}:${MOUNT}`] }],
      MOUNT,
    )
    caller.preset = 'delegate-only-sbx'

    await expect(fs.resolve('/f/personal/elsewhere/secret.txt'))
      .rejects.toMatchObject({ code: 'FS_PERMISSION_DENIED' })
    expect(mounted.requests).toEqual([])
  })
})
describe('a (sbx) session whose sandbox path names a repository no listing reported', () => {
  // The drive convention is a Windows host's: the directory a sandbox path spells
  // has to exist here before a declaration above it can be found.
  const onWindows = it.skipIf(process.platform !== 'win32')

  onWindows('attributes the repository that declares a container above the drive directory', async () => {
    const root = makeRepo({ '.devcontainer/devcontainer.json': '{ "workspaceFolder": "/workspaces/demo" }' })
    const mount = sandboxWorkspacePath(root) ?? root
    const server = makeRepo({ 'main.ts': '' })
    const { fs, caller } = await setup(server, [], mount)
    caller.preset = 'delegate-only-sbx'

    const target = await fs.resolve(`${mount}/src/a.ts`)
    expect(target.targetKey).toBe(`${mount}/src/a.ts`)
    expect(await fs.readText(target)).toBe('body\n')
  })

  onWindows('still refuses a drive directory no repository declares', async () => {
    const server = makeRepo({ 'main.ts': '' })
    const { fs, caller, mounted } = await setup(server, [], '/c/definitely-not-a-workspace-here')
    caller.preset = 'delegate-only-sbx'

    await expect(fs.resolve('/c/definitely-not-a-workspace-here/src/a.ts'))
      .rejects.toMatchObject({ code: 'FS_PERMISSION_DENIED' })
    expect(mounted.requests).toEqual([])
  })
})
