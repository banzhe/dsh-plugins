import { afterAll, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import { apply, Config } from '../src/index.ts'
import { joinHostRoot } from '../src/paths.ts'
import { repoRegistry } from '../src/registry.ts'
import { mapSpawnCwd, repositoryOfPath } from '../src/subprocess.ts'
import {
  cleanupTemporaryDirectories,
  CONTAINER_MOUNT,
  DEFAULT_OPTIONS,
  FakeSubprocess,
  makeContainerRepo,
  repoSpec,
  temporaryDirectory,
} from './support.ts'

afterAll(cleanupTemporaryDirectories)

/** One fully specified spawn request, as a consumer of the seam writes it. */
function spec(cwd: string): SubprocessSpawnSpec {
  return {
    argv: ['node', '-e', ''],
    cwd,
    stdio: { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', control: 'pipe' },
    graceMs: 1_000,
  }
}

/** One composition with the host row mounted over a subprocess provider. */
interface Mounted {
  readonly ctx: Context
  readonly subprocess: FakeSubprocess
}

/**
 * Mount the host row the way the Loader does.
 * @param project - the host directory the session started in, or undefined for a composition with no initiator.
 * @returns the context and the recording provider.
 */
async function mounted(project: string | undefined): Promise<Mounted> {
  repoRegistry().reset()
  const ctx = new Context()
  await ctx.plugin(FakeSubprocess)
  if (project !== undefined) {
    ctx.provide('workingDirectory', { get: () => project })
    ctx.provide('agents', {
      currentInitiator: () => ({ session: { header: { cwd: project } } }),
    })
  }
  apply(ctx, Config({ presets: { win32Only: false } }))
  const subprocess = ctx.subprocess as FakeSubprocess
  // `ctx.inject` resolves its callback on a later tick; an unpatched seam would
  // make every assertion below pass vacuously against a container path.
  await vi.waitFor(() => { expect(Object.hasOwn(subprocess, 'spawn')).toBe(true) })
  return { ctx, subprocess }
}

describe('mapSpawnCwd', () => {
  it('translates the mount point and everything under it onto the host root', () => {
    const root = makeContainerRepo().root
    const repository = repoSpec(root)
    expect(mapSpawnCwd(CONTAINER_MOUNT, repository)).toBe(root)
    expect(mapSpawnCwd(`${CONTAINER_MOUNT}/src/main.ts`, repository)).toBe(joinHostRoot(root, 'src/main.ts'))
    // A model that resolves the leading slash back into a separator writes the
    // same directory, and a host that spells paths the other way still maps it.
    expect(mapSpawnCwd(`${CONTAINER_MOUNT}\\src`, repository)).toBe(joinHostRoot(root, 'src'))
  })

  it('leaves a host path, a foreign container path, and a relative path alone', () => {
    const root = makeContainerRepo().root
    const repository = repoSpec(root)
    expect(mapSpawnCwd(root, repository)).toBe(root)
    expect(mapSpawnCwd('/workspaces/another-repository/src', repository)).toBe('/workspaces/another-repository/src')
    expect(mapSpawnCwd('src', repository)).toBe('src')
  })

  it('leaves every path alone when no declaration owns it', () => {
    expect(mapSpawnCwd(CONTAINER_MOUNT, undefined)).toBe(CONTAINER_MOUNT)
  })
})

describe('repositoryOfPath', () => {
  it('finds the repository a container path belongs to through the initiating session', async () => {
    const root = makeContainerRepo().root
    const { ctx } = await mounted(root)
    expect(repositoryOfPath(ctx, `${CONTAINER_MOUNT}/src`, DEFAULT_OPTIONS)?.hostWorkspaceRoot).toBe(root)
  })

  it('finds it from the discovery cache when no Agent initiated the call', async () => {
    const root = makeContainerRepo().root
    const { ctx } = await mounted(undefined)
    expect(repoRegistry(ctx).discover(root)).toBeDefined()
    expect(repositoryOfPath(ctx, CONTAINER_MOUNT, DEFAULT_OPTIONS)?.hostWorkspaceRoot).toBe(root)
    expect(repositoryOfPath(ctx, '/workspaces/another-repository', DEFAULT_OPTIONS)).toBeUndefined()
  })
})

describe('the spawn directory of a container-bound session', () => {
  it('starts the process in the host repository root instead of the container mount', async () => {
    const root = makeContainerRepo().root
    const { subprocess } = await mounted(root)
    subprocess.spawn(spec(`${CONTAINER_MOUNT}/src`))
    expect(subprocess.spawns[0]?.cwd).toBe(joinHostRoot(root, 'src'))
    // Only the directory moves: the request is otherwise the caller's.
    expect(subprocess.spawns[0]?.argv).toEqual(['node', '-e', ''])
    expect(subprocess.spawns[0]?.graceMs).toBe(1_000)
    expect(subprocess.spawns[0]?.stdio).toEqual({ stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', control: 'pipe' })
  })

  it('maps the mount point itself onto the host root', async () => {
    const root = makeContainerRepo().root
    const { subprocess } = await mounted(root)
    subprocess.spawn(spec(CONTAINER_MOUNT))
    expect(subprocess.spawns[0]?.cwd).toBe(root)
  })

  it('leaves a spawn outside every container repository exactly as it was', async () => {
    const root = makeContainerRepo().root
    const outside = temporaryDirectory()
    const { subprocess } = await mounted(root)
    subprocess.spawn(spec(outside))
    subprocess.spawn(spec('/workspaces/another-repository/src'))
    subprocess.spawn(spec(`${CONTAINER_MOUNT}-not-this-one/src`))
    expect(subprocess.spawns.map(spawn => spawn.cwd)).toEqual([
      outside,
      '/workspaces/another-repository/src',
      `${CONTAINER_MOUNT}-not-this-one/src`,
    ])
  })

  it('gives the provider its own method back when the row unloads', async () => {
    const root = makeContainerRepo().root
    const { ctx, subprocess } = await mounted(root)
    await ctx.fiber.dispose()
    await expect.poll(() => Object.hasOwn(subprocess, 'spawn')).toBe(false)
    subprocess.spawn(spec(`${CONTAINER_MOUNT}/src`))
    expect(subprocess.spawns[0]?.cwd).toBe(`${CONTAINER_MOUNT}/src`)
  })
})
