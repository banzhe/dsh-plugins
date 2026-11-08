import { existsSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { FsTargetKey } from '@deepseek-ai/dsh-fs'
import type { FsTarget } from '@deepseek-ai/dsh-fs'
import { SandboxedFileSystem } from '@deepseek-ai/dsh-fs-sandbox'
import { DevcontainerFileSystem } from '../src/fs.ts'
import { repoRegistry } from '../src/registry.ts'
import { cleanupTemporaryDirectories, makeRepo, temporaryDirectory } from './support.ts'

afterAll(cleanupTemporaryDirectories)

const CONFIG = '{ "workspaceFolder": "/workspaces/demo" }'

/** The preset the calling agent runs; a test retargets it between calls. */
interface Caller {
  /** A `…-devcontainer` preset id, or null for an ordinary one. */
  preset: string | null
}

/**
 * Boot the row with the three services it reads: the sandbox policy every
 * confined backend needs, and the two lookups that attribute a call to the agent
 * that issued it.
 */
async function setup(
  root: string,
  config: { requireContainer?: boolean } = {},
): Promise<{ fs: DevcontainerFileSystem; folder: string; caller: Caller }> {
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
  await ctx.plugin(DevcontainerFileSystem, { cwd: root, ...config })
  return { fs: ctx.fs as DevcontainerFileSystem, folder: '/workspaces/demo', caller }
}

describe('DevcontainerFileSystem.resolve', () => {
  it('maps a container path onto the host bind mount', async () => {
    const root = makeRepo({ '.devcontainer/devcontainer.json': CONFIG, 'src/a.ts': 'export {}\n' })
    const { fs, folder } = await setup(root)
    const target = await fs.resolve(`${folder}/src/a.ts`)
    expect(target.targetKey).toBe(realpathSync(join(root, 'src', 'a.ts')))
  })

  it('maps a drive-mangled container path', async () => {
    const root = makeRepo({ '.devcontainer/devcontainer.json': CONFIG, 'src/a.ts': '' })
    const { fs } = await setup(root)
    const mangled = 'C:\\workspaces\\demo\\src\\a.ts'
    const target = await fs.resolve(mangled)
    expect(String(target.targetKey)).toContain(join('src', 'a.ts'))
  })

  it('maps a relative path resolved against a container cwd', async () => {
    const root = makeRepo({ '.devcontainer/devcontainer.json': CONFIG, 'src/a.ts': '' })
    const { fs, folder } = await setup(root)
    const target = await fs.resolve('a.ts', { cwd: `${folder}/src` })
    expect(target.targetKey).toBe(realpathSync(join(root, 'src', 'a.ts')))
  })

  it('leaves host and unrelated paths alone', async () => {
    const root = makeRepo({ '.devcontainer/devcontainer.json': CONFIG, 'src/a.ts': '' })
    const { fs } = await setup(root)
    expect((await fs.resolve(join(root, 'src', 'a.ts'))).targetKey)
      .toBe(realpathSync(join(root, 'src', 'a.ts')))
    expect((await fs.resolve('src/a.ts')).targetKey).toBe(realpathSync(join(root, 'src', 'a.ts')))
  })

  it('uses the default mount point when the configuration omits workspaceFolder', async () => {
    const root = makeRepo({ '.devcontainer/devcontainer.json': '{ "image": "ubuntu" }', 'a.ts': '' })
    const { fs } = await setup(root)
    const target = await fs.resolve(`/workspaces/${basename(root)}/a.ts`)
    expect(target.targetKey).toBe(realpathSync(join(root, 'a.ts')))
  })
})

describe('DevcontainerFileSystem.lstat', () => {
  it('reports the mapped entry without following it', async () => {
    const root = makeRepo({ '.devcontainer/devcontainer.json': CONFIG, 'src/a.ts': 'x' })
    const { fs, folder } = await setup(root)
    expect((await fs.lstat(`${folder}/src/a.ts`))?.type).toBe('file')
    expect((await fs.lstat(`${folder}/src`))?.type).toBe('directory')
  })

  it('reports an absent path', async () => {
    const root = makeRepo({ '.devcontainer/devcontainer.json': CONFIG })
    const { fs, folder } = await setup(root)
    expect(await fs.lstat(`${folder}/missing.ts`)).toBeUndefined()
  })

  it('maps a container cwd override', async () => {
    const root = makeRepo({ '.devcontainer/devcontainer.json': CONFIG, 'src/a.ts': 'x' })
    const { fs, folder } = await setup(root)
    expect((await fs.lstat('a.ts', { cwd: `${folder}/src` }))?.type).toBe('file')
  })
})

describe('DevcontainerFileSystem under a (devContainer) preset', () => {
  it('refuses to resolve a host path when the repository declares no container', async () => {
    const root = makeRepo({ 'src/a.ts': 'export {}\n' })
    const { fs, caller } = await setup(root)
    caller.preset = 'delegate-only-devcontainer'
    const target = join(root, 'src', 'a.ts')

    await expect(fs.resolve(target)).rejects.toMatchObject({ code: 'FS_PERMISSION_DENIED' })
    await expect(fs.resolve(target)).rejects.toThrow('refused to access this path on the host')
    await expect(fs.resolve(target)).rejects.toThrow('delegate-only-devcontainer')
    await expect(fs.resolve(target)).rejects.toThrow('switch to an ordinary preset')
  })

  it('refuses the pre-resolve probe as well', async () => {
    const root = makeRepo({ 'src/a.ts': '' })
    const { fs, caller } = await setup(root)
    caller.preset = 'delegate-only-devcontainer'
    await expect(fs.lstat(join(root, 'src', 'a.ts'))).rejects.toMatchObject({ code: 'FS_PERMISSION_DENIED' })
  })

  it('writes nothing to the host', async () => {
    const root = makeRepo({ 'src/a.ts': 'old\n' })
    const { fs, caller } = await setup(root)
    caller.preset = 'delegate-only-devcontainer'

    await expect(fs.resolve(join(root, 'src', 'new.ts'))).rejects.toMatchObject({ code: 'FS_PERMISSION_DENIED' })
    expect(existsSync(join(root, 'src', 'new.ts'))).toBe(false)
    expect(readFileSync(join(root, 'src', 'a.ts'), 'utf8')).toBe('old\n')
  })

  it('fences a target resolved before the session became container-bound', async () => {
    const root = makeRepo({ 'src/a.ts': 'old\n' })
    const { fs, caller } = await setup(root)
    const target = await fs.resolve(join(root, 'src', 'a.ts'))
    // The preset changes after the target exists: the operation re-reads the
    // requirement instead of trusting the ingress check.
    caller.preset = 'delegate-only-devcontainer'

    await expect(fs.writeText(target, 'new\n')).rejects.toMatchObject({ code: 'FS_PERMISSION_DENIED' })
    await expect(fs.readText(target)).rejects.toMatchObject({ code: 'FS_PERMISSION_DENIED' })
    expect(readFileSync(join(root, 'src', 'a.ts'), 'utf8')).toBe('old\n')
  })

  it('names the subagent preset that issued the call', async () => {
    const root = makeRepo({ 'src/a.ts': '' })
    const { fs, caller } = await setup(root)
    caller.preset = 'subagent-coder-devcontainer'
    await expect(fs.resolve(join(root, 'src', 'a.ts'))).rejects.toThrow('subagent-coder-devcontainer')
  })

  it('delegates a container path to the container instead of the bind mount', async () => {
    const root = makeRepo({ '.devcontainer/devcontainer.json': CONFIG, 'src/a.ts': 'old\n' })
    const { fs, folder, caller } = await setup(root)
    // No Docker here: the probe answers empty, so the delegation fails at the
    // container instead of reaching for the host file.
    fs.containerInternals.run = () => Promise.resolve({ stdout: '', stderr: 'no docker', exitCode: 1 })
    caller.preset = 'standard-devcontainer'

    // This deployment has no Docker, so the delegation fails loud rather than
    // reading the host file through the mount — which is the whole point of the
    // row: a container-bound session must never fall back to the host.
    const failure = await fs.resolve(`${folder}/src/a.ts`).catch((error: unknown) => error)
    expect(failure).toMatchObject({ code: 'FS_IO_ERROR' })
    expect((failure as Error).message).toContain('devcontainer')
    expect(readFileSync(join(root, 'src', 'a.ts'), 'utf8')).toBe('old\n')
  })

  it('refuses a host path outside the repository before reaching the container', async () => {
    const root = makeRepo({ '.devcontainer/devcontainer.json': CONFIG })
    const outside = temporaryDirectory()
    const { fs, caller } = await setup(root)
    caller.preset = 'standard-devcontainer'
    // The refusal is local: no container round-trip is attempted for a path the
    // repository does not own.
    await expect(fs.resolve(join(outside, 'secret.txt'))).rejects.toMatchObject({ code: 'FS_PERMISSION_DENIED' })
  })

  it('keeps reading through the same link for an ordinary preset', async () => {
    const root = makeRepo({ '.devcontainer/devcontainer.json': CONFIG })
    const outside = temporaryDirectory()
    writeFileSync(join(outside, 'secret.txt'), 'TOP SECRET\n')
    symlinkSync(outside, join(root, 'linked'), 'junction')
    const { fs, folder } = await setup(root)

    const target = await fs.resolve(`${folder}/linked/secret.txt`)
    expect(await fs.readText(target)).toBe('TOP SECRET\n')
  })

  it('leaves an ordinary preset in the same repository alone', async () => {
    const root = makeRepo({ 'src/a.ts': 'old\n' })
    const { fs } = await setup(root)
    const target = await fs.resolve(join(root, 'src', 'a.ts'))
    await fs.writeText(target, 'new\n')
    expect(readFileSync(join(root, 'src', 'a.ts'), 'utf8')).toBe('new\n')
  })

  it('refuses a host path outside the repository even when that repository declares a container', async () => {
    const root = makeRepo({ '.devcontainer/devcontainer.json': CONFIG, 'src/a.ts': '' })
    const outside = temporaryDirectory()
    const { fs, caller } = await setup(root)
    caller.preset = 'standard-devcontainer'
    const elsewhere = join(outside, 'secret.txt')

    await expect(fs.resolve(elsewhere)).rejects.toMatchObject({ code: 'FS_PERMISSION_DENIED' })
    await expect(fs.resolve(elsewhere)).rejects.toThrow('standard-devcontainer')
  })

  it('refuses a relative path that climbs out of the repository', async () => {
    const root = makeRepo({ '.devcontainer/devcontainer.json': CONFIG, 'src/a.ts': '' })
    const { fs, caller } = await setup(root)
    caller.preset = 'standard-devcontainer'

    await expect(fs.resolve('../../escape.txt', { cwd: root })).rejects.toMatchObject({ code: 'FS_PERMISSION_DENIED' })
  })

  it('still resolves a host path outside the repository for an ordinary preset', async () => {
    const root = makeRepo({ '.devcontainer/devcontainer.json': CONFIG })
    const outside = temporaryDirectory()
    const { fs } = await setup(root)

    expect((await fs.resolve(join(outside, 'secret.txt'))).displayPath).toContain('secret.txt')
  })

  it('refuses for a deployment that requires containers for every preset', async () => {
    const root = makeRepo({ 'src/a.ts': '' })
    const { fs } = await setup(root, { requireContainer: true })
    await expect(fs.lstat(join(root, 'src', 'a.ts'))).rejects.toMatchObject({ code: 'FS_PERMISSION_DENIED' })
    await expect(fs.resolve(join(root, 'src', 'a.ts'))).rejects.toThrow('a (devContainer) preset')
  })
})

/** The target-taking mutations a newer backend declares; this build types none of them. */
interface InheritedMutations {
  patchText(target: FsTarget, hunks: readonly unknown[]): Promise<unknown>
  deleteFile(target: FsTarget): Promise<unknown>
  moveFile(source: FsTarget, destination: FsTarget, options: unknown): Promise<unknown>
}

/**
 * Install the target-taking mutations a NEWER `SandboxedFileSystem` declares and
 * this build does not type, then remove them again.
 */
function installInheritedMutations(calls: string[]): () => void {
  const proto = SandboxedFileSystem.prototype as unknown as Record<string, unknown>
  const record = (name: string) => function (this: unknown): Promise<unknown> {
    calls.push(name)
    return Promise.resolve({})
  }
  proto.patchText = record('patchText')
  proto.deleteFile = record('deleteFile')
  proto.moveFile = record('moveFile')
  return () => {
    delete proto.patchText
    delete proto.deleteFile
    delete proto.moveFile
  }
}

describe('DevcontainerFileSystem defensive mutation fence', () => {
  const target = (root: string): FsTarget => ({
    targetKey: FsTargetKey(join(root, 'src', 'a.ts')),
    displayPath: join(root, 'src', 'a.ts'),
  })

  it('refuses mutations the base class does not declare, before they run', async () => {
    const root = makeRepo({ 'src/a.ts': 'old\n' })
    const calls: string[] = []
    const restore = installInheritedMutations(calls)
    try {
      const { fs, caller } = await setup(root)
      caller.preset = 'delegate-only-devcontainer'
      const file = target(root)
      const mutations = fs as unknown as InheritedMutations

      await expect(mutations.patchText(file, [])).rejects.toMatchObject({ code: 'FS_PERMISSION_DENIED' })
      await expect(mutations.deleteFile(file)).rejects.toMatchObject({ code: 'FS_PERMISSION_DENIED' })
      await expect(mutations.moveFile(file, file, {})).rejects.toMatchObject({ code: 'FS_PERMISSION_DENIED' })
      // Nothing reached the inherited implementation.
      expect(calls).toEqual([])
    } finally {
      restore()
    }
  })

  it('fences the destination of a move as well as its source', async () => {
    const root = makeRepo({ '.devcontainer/devcontainer.json': CONFIG, 'src/a.ts': '' })
    const outside = temporaryDirectory()
    const calls: string[] = []
    const restore = installInheritedMutations(calls)
    try {
      const { fs, caller } = await setup(root)
      caller.preset = 'standard-devcontainer'
      const mutations = fs as unknown as InheritedMutations
      const destination: FsTarget = {
        targetKey: FsTargetKey(join(outside, 'elsewhere.ts')),
        displayPath: join(outside, 'elsewhere.ts'),
      }

      await expect(mutations.moveFile(target(root), destination, {})).rejects.toMatchObject({ code: 'FS_PERMISSION_DENIED' })
      expect(calls).toEqual([])
    } finally {
      restore()
    }
  })

  it('still delegates the inherited mutations for an ordinary session', async () => {
    const root = makeRepo({ 'src/a.ts': 'old\n' })
    const calls: string[] = []
    const restore = installInheritedMutations(calls)
    try {
      const { fs } = await setup(root)
      const mutations = fs as unknown as InheritedMutations

      await expect(mutations.patchText(target(root), [])).resolves.toEqual({})
      expect(calls).toEqual(['patchText'])
    } finally {
      restore()
    }
  })
})
