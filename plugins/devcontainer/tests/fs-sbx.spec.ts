import { dirname, join, parse } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { DevcontainerFileSystem } from '../src/fs.ts'
import type { ContainerRun } from '../src/exec.ts'
import { hostMountRejections } from '../src/host-mounts.ts'
import { registerHostMounts, repoRegistry, warnOnce } from '../src/registry.ts'
import type { ChannelTarget, ContainerRpcChannel } from '../src/rpc/client.ts'
import { RpcOperationError } from '../src/rpc/errors.ts'
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
 * @param absent - paths the sandbox does not have, which answer `FS_NOT_FOUND`.
 * @returns the channel and the requests it received.
 */
function sandboxChannel(workspace: string, absent: readonly string[] = []): SandboxChannel {
  const requests: Recorded[] = []
  const answer = (method: string, params: unknown): unknown => {
    const input = params as { path?: string, target?: { targetKey: string } }
    const path = input.path ?? input.target?.targetKey ?? ''
    if (absent.includes(path)) {
      // The helper answers a probe with "absent" and a read with the failure that
      // absence is, exactly as a POSIX errno would arrive.
      if (method === 'fs.resolve') return { targetKey: path, displayPath: path }
      if (method === 'fs.stat' || method === 'fs.lstat') return null
      throw new RpcOperationError(`cannot access '${path}': no such file`, 'FS_NOT_FOUND')
    }
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
  hostMounts?: readonly string[],
  absent?: readonly string[],
): Promise<{
  fs: DevcontainerFileSystem
  caller: Caller
  mounted: SandboxChannel
  calls: string[][]
  targets: ChannelTarget[]
}> {
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
  if (hostMounts !== undefined) registerHostMounts(ctx, () => hostMounts)
  await ctx.plugin(DevcontainerFileSystem, { cwd: root })
  const fs = ctx.fs as DevcontainerFileSystem
  const cli = sandboxCli(listing)
  fs.containerInternals.run = cli.run
  const mounted = sandboxChannel(mount, absent)
  const targets: ChannelTarget[] = []
  fs.containerInternals.channel = async (target) => {
    targets.push(target)
    return mounted.channel
  }
  return { fs, caller, mounted, calls: cli.calls, targets }
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

    // A metadata probe of a path no mount carries asks whether it is there, and the
    // sandbox's filesystem answers that it is not.
    await expect(fs.resolve('/f/personal/elsewhere/secret.txt'))
      .rejects.toMatchObject({ code: 'FS_NOT_FOUND' })
    // The answer is local: nothing about it reached the container.
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
      .rejects.toMatchObject({ code: 'FS_NOT_FOUND' })
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
      .rejects.toMatchObject({ code: 'FS_NOT_FOUND' })
    expect(mounted.requests).toEqual([])
  })
})
describe('a (sbx) session with the host AGENTS.md and skills mounted', () => {
  const AGENTS = 'C:\\Users\\me\\.dsh\\AGENTS.md'
  const AGENTS_MOUNT = '/d/agents.md'
  const SKILLS = 'C:\\Users\\me\\.agents\\skills'
  const SKILLS_MOUNT = '/c/Users/me/.agents/skills'
  const INJECTED = 'C:\\Users\\me\\AppData\\Local\\DockerSandboxes\\state\\agent-skills'

  /** The listing of a sandbox created with this row's two extra mounts. */
  function listing(): unknown[] {
    return [{
      name: sandboxNameFor(HOST),
      status: 'running',
      mounts: [
        `${HOST}:${MOUNT}`,
        `${AGENTS}:${AGENTS_MOUNT}:ro`,
        `${SKILLS}:${SKILLS_MOUNT}:ro`,
        `${INJECTED}:/home/agent/.claude/skills:ro`,
      ],
      workspaces: [HOST, `${AGENTS}:ro`, `${SKILLS}:ro`],
    }]
  }

  it('reads the host path through the mount the sandbox reported', async () => {
    const { fs, caller, mounted } = await setup(HOST, listing(), MOUNT, [AGENTS, SKILLS])
    caller.preset = 'delegate-only-sbx'

    const target = await fs.resolve(AGENTS)
    expect(String(target.targetKey)).toBe(AGENTS_MOUNT)
    expect(mounted.requests[0]).toEqual({ method: 'fs.resolve', params: { path: AGENTS_MOUNT } })

    const skill = await fs.resolve(`${SKILLS}\\demo\\SKILL.md`)
    expect(String(skill.targetKey)).toBe(`${SKILLS_MOUNT}/demo/SKILL.md`)
    expect(await fs.readText(skill)).toBe('body\n')
  })

  it('tells the helper which extra roots the session may read', async () => {
    const { fs, caller, targets } = await setup(HOST, listing(), MOUNT, [AGENTS, SKILLS])
    caller.preset = 'delegate-only-sbx'

    await fs.readText(await fs.resolve(AGENTS))
    const target = targets[0]
    expect(target?.kind === 'sbx' ? target.mounts : undefined)
      .toEqual([AGENTS_MOUNT, SKILLS_MOUNT])
  })

  it('translates a differently spelled host path into its mount instead of calling it absent', async () => {
    // The two checks a probe makes must agree: the host spelling is compared with the
    // mount's host side, and the translation folds case the same way. A path written
    // with other case or separators is therefore the same file, never "not there".
    const { fs, caller } = await setup(HOST, listing(), MOUNT, [AGENTS, SKILLS])
    caller.preset = 'delegate-only-sbx'

    for (const spelling of ['c:/users/me/.dsh/agents.md', 'C:/Users/me/.dsh/AGENTS.md', AGENTS]) {
      const target = await fs.resolve(spelling)
      expect(String(target.targetKey)).toBe(AGENTS_MOUNT)
      expect(await fs.stat(target)).toBeDefined()
    }
  })

  it('still keeps a host path no mount covers, and one the sandbox injected itself, out', async () => {
    const { fs, caller, mounted } = await setup(HOST, listing(), MOUNT, [AGENTS, SKILLS])
    caller.preset = 'delegate-only-sbx'

    await expect(fs.resolve('C:\\Users\\me\\.dsh\\other.md')).rejects.toMatchObject({ code: 'FS_NOT_FOUND' })
    await expect(fs.resolve('/home/agent/.claude/skills/demo/SKILL.md'))
      .rejects.toMatchObject({ code: 'FS_NOT_FOUND' })
    expect(mounted.requests).toEqual([])
  })

  it('keeps a declared mount whose source is gone out of the session', async () => {
    const gone = 'C:\\Users\\me\\.dsh\\missing.md'
    const listingWithout = [{
      name: sandboxNameFor(HOST),
      status: 'running',
      mounts: [`${HOST}:${MOUNT}`, `${AGENTS}:${AGENTS_MOUNT}:ro`],
      workspaces: [HOST, AGENTS],
    }]
    const { fs, caller, targets } = await setup(HOST, listingWithout, MOUNT, [AGENTS, gone])
    caller.preset = 'delegate-only-sbx'

    await fs.readText(await fs.resolve(AGENTS))
    const target = targets[0]
    expect(target?.kind === 'sbx' ? target.mounts : undefined).toEqual([AGENTS_MOUNT])
  })
})
describe('a declared mount no listing has reported yet', () => {
  it('is admitted at the drive convention, and a read there fails as a missing file', async () => {
    // The row just handed this path to `sbx create`, and no listing has said where
    // the sandbox put it: the convention is the only spelling available. It widens
    // nothing — the sandbox does not have the path, so the read is FS_NOT_FOUND,
    // never a fence that opened onto something else.
    const host = makeRepo({ 'src/a.ts': '' })
    const elsewhere = makeRepo({ 'AGENTS.md': '# agents\n', 'other.md': '# other\n' })
    const agents = join(elsewhere, 'AGENTS.md')
    const workspace = sandboxWorkspacePath(host) ?? host
    const conventional = sandboxWorkspacePath(agents) ?? agents
    const { fs, caller, mounted } = await setup(host, [], workspace, [agents], [conventional])
    caller.preset = 'delegate-only-sbx'

    const target = await fs.resolve(agents)
    expect(String(target.targetKey)).toBe(conventional)
    expect(mounted.requests[0]).toEqual({ method: 'fs.resolve', params: { path: conventional } })
    await expect(fs.readText(target)).rejects.toMatchObject({ code: 'FS_NOT_FOUND' })

    // The declaration is one file, not the directory around it.
    await expect(fs.resolve(join(elsewhere, 'other.md'))).rejects.toMatchObject({ code: 'FS_NOT_FOUND' })
  })

  it('keeps a single-file mount to that file: its siblings are not there', async () => {
    // The shape this row's `auto` set produces when the host has `~/.dsh/AGENTS.md`
    // and nothing else: one file, mounted read-only, beside its own directory.
    const host = makeRepo({ 'src/a.ts': '' })
    const dshHome = makeRepo({ 'AGENTS.md': '# agents\n', 'other.md': '# other\n' })
    const agents = join(dshHome, 'AGENTS.md')
    const agentsMount = sandboxWorkspacePath(agents) ?? agents
    const workspace = sandboxWorkspacePath(host) ?? host
    const { fs, caller } = await setup(host, [{
      name: sandboxNameFor(host),
      status: 'running',
      mounts: [`${host}:${workspace}`, `${agents}:${agentsMount}:ro`],
      workspaces: [host, `${agents}:ro`],
    }], workspace, [agents])
    caller.preset = 'delegate-only-sbx'

    expect(String((await fs.resolve(agents)).targetKey)).toBe(agentsMount)
    await expect(fs.resolve(join(dshHome, 'other.md'))).rejects.toMatchObject({ code: 'FS_NOT_FOUND' })
    await expect(fs.lstat(join(dshHome, 'other.md'))).rejects.toMatchObject({ code: 'FS_NOT_FOUND' })
    // Reading or writing one is not a question about existence but an attempt to
    // reach outside the mount, and that stays refused.
    const sibling = {
      targetKey: sandboxWorkspacePath(join(dshHome, 'other.md')) ?? join(dshHome, 'other.md'),
      displayPath: join(dshHome, 'other.md'),
    } as never
    await expect(fs.readText(sibling)).rejects.toMatchObject({ code: 'FS_PERMISSION_DENIED' })
    await expect(fs.writeText(sibling, '# other\n')).rejects.toMatchObject({ code: 'FS_PERMISSION_DENIED' })
  })
})
describe('a metadata probe of a path no mount carries', () => {
  // `agent-instructions` walks the ancestors of the session directory appending
  // `.git` to each one, and treats only an absent answer as "keep walking". A path
  // outside every mount is exactly that: not there, not a refusal.
  const OUTSIDE = 'D:\\personal\\.git'

  /** A target for a path that no mount carries, as the seam would hold it. */
  function outsideTarget(): never {
    return { targetKey: 'D:/personal/.git', displayPath: OUTSIDE } as never
  }

  it('answers absent for resolve, lstat and stat', async () => {
    const { fs, caller, mounted } = await setup(HOST, [{ name: sandboxNameFor(HOST), status: 'running' }], MOUNT)
    caller.preset = 'delegate-only-sbx'

    await expect(fs.resolve(OUTSIDE)).rejects.toMatchObject({ code: 'FS_NOT_FOUND' })
    await expect(fs.lstat(OUTSIDE)).rejects.toMatchObject({ code: 'FS_NOT_FOUND' })
    // The answer is this session's own: nothing was asked of the sandbox.
    expect(mounted.requests).toEqual([])
    await expect(fs.stat(outsideTarget())).rejects.toMatchObject({ code: 'FS_NOT_FOUND' })
    expect(mounted.requests.filter(request => request.method !== 'hello')).toEqual([])
  })

  it('names the mount, not an escape, in the absent answer', async () => {
    const { fs, caller } = await setup(HOST, [{ name: sandboxNameFor(HOST), status: 'running' }], MOUNT)
    caller.preset = 'delegate-only-sbx'

    await expect(fs.resolve(OUTSIDE)).rejects.toThrow(OUTSIDE)
    await expect(fs.resolve(OUTSIDE)).rejects.toThrow('not inside any mount')
    await expect(fs.resolve(OUTSIDE)).rejects.not.toThrow('resolves to')
  })

  it('still refuses to read or write the same path', async () => {
    const { fs, caller } = await setup(HOST, [{ name: sandboxNameFor(HOST), status: 'running' }], MOUNT)
    caller.preset = 'delegate-only-sbx'

    await expect(fs.readText(outsideTarget())).rejects.toMatchObject({ code: 'FS_PERMISSION_DENIED' })
    await expect(fs.streamText(outsideTarget())).rejects.toMatchObject({ code: 'FS_PERMISSION_DENIED' })
    await expect(fs.readBytes(outsideTarget(), undefined, 64)).rejects.toMatchObject({ code: 'FS_PERMISSION_DENIED' })
    await expect(fs.writeText(outsideTarget(), 'x\n')).rejects.toMatchObject({ code: 'FS_PERMISSION_DENIED' })
    await expect(fs.editText(outsideTarget(), { search: 'a', replace: 'b' } as never))
      .rejects.toMatchObject({ code: 'FS_PERMISSION_DENIED' })
  })

  it('lets a project-root walk climb past the mount and stop at the drive', async () => {
    const root = makeRepo({ 'src/a.ts': '' })
    const mount = sandboxWorkspacePath(root) ?? root
    const { fs, caller } = await setup(
      root,
      [{ name: sandboxNameFor(root), status: 'running', mounts: [`${root}:${mount}`], workspaces: [root] }],
      mount,
      [],
      [`${mount}/.git`],
    )
    caller.preset = 'delegate-only-sbx'

    const existsAsMarker = async (dir: string): Promise<boolean> => {
      try {
        return (await fs.stat(await fs.resolve(join(dir, '.git')))) !== undefined
      } catch (error: unknown) {
        if ((error as { code?: string }).code === 'FS_NOT_FOUND') return false
        throw error
      }
    }

    const visited: string[] = []
    let dir = root
    for (;;) {
      visited.push(dir)
      if (await existsAsMarker(dir)) throw new Error(`unexpected marker in ${dir}`)
      const parent = dirname(dir)
      if (parent === dir) break
      dir = parent
    }

    // It climbed past the mount instead of failing on it, and stopped at the drive.
    expect(visited[1]).toBe(dirname(root))
    expect(visited.at(-1)).toBe(parse(root).root)
  })
})
describe('a path a metadata probe cannot name at all', () => {
  it('answers absent for a host path no mount covers', async () => {
    const { fs, caller } = await setup(HOST, [{ name: sandboxNameFor(HOST), status: 'running' }], MOUNT)
    caller.preset = 'delegate-only-sbx'

    await expect(fs.resolve('D:\\personal\\elsewhere\\secret.txt'))
      .rejects.toMatchObject({ code: 'FS_NOT_FOUND' })
  })

  it('keeps a path it can translate, but whose identity escapes, a refusal', async () => {
    // A relative path resolves against the mount, and one that climbs out of it is
    // the escape case: the session names a path it can place, whose I/O identity
    // ends up outside. That is a refusal, never an absence.
    const { fs, caller } = await setup(HOST, [{ name: sandboxNameFor(HOST), status: 'running' }], MOUNT)
    caller.preset = 'delegate-only-sbx'

    await expect(fs.resolve('../../escape.txt', { cwd: HOST }))
      .rejects.toMatchObject({ code: 'FS_PERMISSION_DENIED' })
  })
})

describe('one diagnostic per composition', () => {
  it('reports the same mount rejection once, whichever row notices it', () => {
    const ctx = new Context()
    const seen: string[] = []
    const warn = (message: string): void => { seen.push(message) }
    const rejection = hostMountRejections(['C:/a/b.md:D:/c.md:ro'])[0] ?? ''

    // The shell row and the filesystem row each resolve the same sandbox from
    // their own cache; a person should read the refusal once.
    warnOnce(ctx, warn, rejection)
    warnOnce(ctx, warn, rejection)
    expect(seen).toEqual([rejection])

    // A different message is a different diagnostic, and another composition
    // starts with a clean slate.
    warnOnce(ctx, warn, 'devcontainer: something else')
    expect(seen).toHaveLength(2)
    warnOnce(new Context(), warn, rejection)
    expect(seen).toHaveLength(3)
  })
})