import { existsSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { afterAll, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { FsTarget } from '@deepseek-ai/dsh-fs'
import { DevcontainerFileSystem } from '../src/fs.ts'
import type { ContainerRun } from '../src/exec.ts'
import { repoRegistry } from '../src/registry.ts'
import type { ContainerRpcChannel } from '../src/rpc/client.ts'
import { RpcOperationError } from '../src/rpc/errors.ts'
import {
  CONTAINER_MOUNT,
  cleanupTemporaryDirectories,
  helperChannel,
  makeContainerRepo,
  temporaryDirectory,
} from './support.ts'
import type { HelperChannel } from './support.ts'

afterAll(cleanupTemporaryDirectories)

/** The preset the calling agent runs; a test retargets it between calls. */
interface Caller {
  /** A `…-devcontainer` preset id, or null for an ordinary one. */
  preset: string | null
}

/** A Docker CLI stand-in that reports one running container for the repository. */
function fakeDockerCli(root: string, containerId = 'container-1'): { run: ContainerRun, calls: string[][] } {
  const calls: string[][] = []
  const run: ContainerRun = (argv) => {
    calls.push([...argv])
    if (argv[0] === 'docker' && argv[1] === 'ps') {
      return Promise.resolve({ stdout: `${containerId}\t${root}\n`, stderr: '', exitCode: 0 })
    }
    return Promise.resolve({ stdout: '', stderr: 'unexpected', exitCode: 1 })
  }
  return { run, calls }
}

/** A channel the row can be pointed at directly, so no process is started. */
function stubChannel(handshake: { workspace: string, workspaceReal: string }, request: HelperChannel['request']): ContainerRpcChannel {
  return {
    handshake,
    request,
    isClosed: false,
    closedPromise: Promise.resolve(),
  } as unknown as ContainerRpcChannel
}

/** Boot the row with the services it reads, pointed at a container stand-in. */
async function setup(
  root: string,
  options: { channel?: ContainerRpcChannel, config?: Record<string, unknown> } = {},
): Promise<{ fs: DevcontainerFileSystem, caller: Caller, cli: ReturnType<typeof fakeDockerCli>, channel: HelperChannel }> {
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
  await ctx.plugin(DevcontainerFileSystem, { cwd: root, ...options.config })
  const fs = ctx.fs as DevcontainerFileSystem
  const cli = fakeDockerCli(root)
  fs.containerInternals.run = cli.run
  const channel = await helperChannel(CONTAINER_MOUNT, root)
  fs.containerInternals.channel = async () => options.channel ?? stubChannel(
    channel.handshake,
    (method, params) => channel.request(method, params),
  )
  return { fs, caller, cli, channel }
}

describe('a container-bound session delegates every path to the container', () => {
  it('resolves a container path without touching the host filesystem', async () => {
    const { root } = makeContainerRepo({ 'src/a.ts': 'export {}\n' })
    const { fs, caller } = await setup(root)
    caller.preset = 'standard-devcontainer'

    const target = await fs.resolve(`${CONTAINER_MOUNT}/src/a.ts`)
    expect(String(target.targetKey)).toBe(`${CONTAINER_MOUNT}/src/a.ts`)
    expect(target.displayPath).toBe(`${CONTAINER_MOUNT}/src/a.ts`)
    expect(await fs.readText(target)).toBe('export {}\n')
  })

  it('translates a host spelling of the same file into the container mount', async () => {
    const { root } = makeContainerRepo({ 'src/a.ts': 'export {}\n' })
    const { fs, caller } = await setup(root)
    caller.preset = 'standard-devcontainer'

    const target = await fs.resolve(join(root, 'src', 'a.ts'))
    expect(String(target.targetKey)).toBe(`${CONTAINER_MOUNT}/src/a.ts`)
  })

  it('resolves a relative path against the container cwd', async () => {
    const { root } = makeContainerRepo({ 'src/a.ts': '' })
    const { fs, caller } = await setup(root)
    caller.preset = 'standard-devcontainer'

    const target = await fs.resolve('a.ts', { cwd: `${CONTAINER_MOUNT}/src` })
    expect(String(target.targetKey)).toBe(`${CONTAINER_MOUNT}/src/a.ts`)
  })

  it('reads metadata, listings, bytes and text from the container', async () => {
    const { root } = makeContainerRepo({ 'src/a.ts': 'abcdef', 'docs/b.md': '# b\n' })
    const { fs, caller } = await setup(root)
    caller.preset = 'standard-devcontainer'

    const file = await fs.resolve(`${CONTAINER_MOUNT}/src/a.ts`)
    expect(await fs.stat(file)).toMatchObject({ type: 'file', size: 6 })
    expect(await fs.lstat(`${CONTAINER_MOUNT}/src`)).toMatchObject({ type: 'directory' })
    expect(await fs.lstat(`${CONTAINER_MOUNT}/missing.ts`)).toBeUndefined()

    const directory = await fs.resolve(`${CONTAINER_MOUNT}/src`)
    const listing = await fs.listDir(directory)
    expect(listing.map(entry => entry.name)).toEqual(['a.ts'])
    expect(String(listing[0]?.target.targetKey)).toBe(`${CONTAINER_MOUNT}/src/a.ts`)

    expect(Buffer.from(await fs.readBytes(file, undefined, 1024)).toString()).toBe('abcdef')
    expect(Buffer.from(await fs.readByteRange(file, { offset: 1, length: 3 })).toString()).toBe('bcd')

    let streamed = ''
    for await (const chunk of await fs.streamText(file)) streamed += chunk
    expect(streamed).toBe('abcdef')
  })

  it('opens the text stream only when it is first read', async () => {
    const { root } = makeContainerRepo({ 'src/a.ts': 'abcdef' })
    const { fs, caller, channel } = await setup(root)
    caller.preset = 'standard-devcontainer'
    const target = await fs.resolve(`${CONTAINER_MOUNT}/src/a.ts`)
    const methods: string[] = []
    fs.containerInternals.channel = async () => stubChannel(channel.handshake, (method, params, options) => {
      methods.push(method)
      return channel.request(method, params, options)
    })

    const stream = await fs.streamText(target)
    // An iterator nobody reads must hold no helper slot: the request belongs to
    // the first iteration, which is also what keeps the close reachable.
    expect(methods).toEqual([])

    let text = ''
    for await (const chunk of stream) text += chunk
    expect(text).toBe('abcdef')
    expect(methods[0]).toBe('fs.stream')
  })

  it('closes a stream the caller stops reading', async () => {
    const { root } = makeContainerRepo({ 'src/a.ts': 'abcdef' })
    const { fs, caller, channel } = await setup(root)
    caller.preset = 'standard-devcontainer'
    const target = await fs.resolve(`${CONTAINER_MOUNT}/src/a.ts`)
    const methods: string[] = []
    fs.containerInternals.channel = async () => stubChannel(channel.handshake, (method, params, options) => {
      methods.push(method)
      return channel.request(method, params, options)
    })

    for await (const chunk of await fs.streamText(target)) {
      expect(chunk).toBe('abcdef')
      break
    }
    expect(methods).toContain('fs.streamClose')
  })

  it('writes, edits, patches, moves and deletes inside the container', async () => {
    const { root } = makeContainerRepo({ 'src/a.ts': 'one\ntwo\n' })
    const { fs, caller } = await setup(root)
    caller.preset = 'standard-devcontainer'

    const created = await fs.writeText(await fs.resolve(`${CONTAINER_MOUNT}/src/new.ts`), 'fresh\n')
    expect(created.operation).toBe('create')
    expect(readFileSync(join(root, 'src', 'new.ts'), 'utf8')).toBe('fresh\n')
    await expect(fs.writeText(await fs.resolve(`${CONTAINER_MOUNT}/src/new.ts`), 'x', { kind: 'createIfAbsent' }))
      .rejects.toMatchObject({ code: 'FS_NOT_OBSERVED' })

    const file = await fs.resolve(`${CONTAINER_MOUNT}/src/a.ts`)
    const info = await fs.stat(file)
    const edited = await fs.editText(file, { oldString: 'two', newString: 'three', replaceAll: false }, info === undefined ? undefined : { version: info.version })
    expect(edited.before).toBe('one\ntwo\n')
    expect(edited.after).toBe('one\nthree\n')
    await expect(fs.editText(file, { oldString: 'three', newString: 'x', replaceAll: false }, { version: info?.version ?? info?.version as never }))
      .rejects.toMatchObject({ code: 'FS_STALE_VERSION' })

    // The three target-taking mutations this DSH build does not declare are
    // installed by the row itself.
    const mutations = fs as unknown as {
      patchText(target: FsTarget, hunks: readonly unknown[]): Promise<{ after: string }>
      moveFile(source: FsTarget, destination: FsTarget, options: object): Promise<{ sourceDeleted: boolean }>
      deleteFile(target: FsTarget): Promise<{ before: string | null }>
    }
    const patched = await mutations.patchText(file, [
      { lineNumber: 1, oldLines: ['three'], newLines: ['four'], isEndOfFile: false },
    ])
    expect(patched.after).toBe('one\nfour\n')

    const moved = await mutations.moveFile(file, await fs.resolve(`${CONTAINER_MOUNT}/src/moved.ts`), {})
    expect(moved.sourceDeleted).toBe(true)
    expect(readFileSync(join(root, 'src', 'moved.ts'), 'utf8')).toBe('one\nfour\n')

    const removed = await mutations.deleteFile(await fs.resolve(`${CONTAINER_MOUNT}/src/moved.ts`))
    expect(removed.before).toBe('one\nfour\n')
    expect(existsSync(join(root, 'src', 'moved.ts'))).toBe(false)
  })

  it('refuses a link inside the repository that points out of the mount', async () => {
    const { root } = makeContainerRepo({ 'src/a.ts': '' })
    const outside = temporaryDirectory()
    writeFileSync(join(outside, 'secret.txt'), 'TOP SECRET\n')
    symlinkSync(outside, join(root, 'linked'), 'junction')
    const { fs, caller } = await setup(root)
    caller.preset = 'standard-devcontainer'

    // The container resolves the link to a location outside the mount, so the
    // ingress refuses before any call can carry that identity.
    await expect(fs.resolve(`${CONTAINER_MOUNT}/linked/secret.txt`))
      .rejects.toMatchObject({ code: 'FS_PERMISSION_DENIED' })

    // A target that already carries an escaping identity is refused by every
    // operation, not just by the ingress.
    await fs.resolve(`${CONTAINER_MOUNT}/src/a.ts`)
    const escaped = {
      targetKey: `${CONTAINER_MOUNT}/linked/../../secret.txt` as never,
      displayPath: `${CONTAINER_MOUNT}/linked/secret.txt`,
    }
    for (const call of [
      () => fs.readText(escaped),
      () => fs.streamText(escaped),
      () => fs.readBytes(escaped, undefined, 1024),
      () => fs.listDir(escaped),
      () => fs.stat(escaped),
    ]) {
      await expect(call()).rejects.toMatchObject({ code: 'FS_PERMISSION_DENIED' })
    }
    await expect(fs.writeText(escaped, 'payload\n')).rejects.toMatchObject({ code: 'FS_PERMISSION_DENIED' })
    expect(existsSync(join(outside, 'secret.txt'))).toBe(true)
    expect(readFileSync(join(outside, 'secret.txt'), 'utf8')).toBe('TOP SECRET\n')
  })

  it('names the escape, both spellings and the preset', async () => {
    const { root } = makeContainerRepo()
    const outside = temporaryDirectory()
    writeFileSync(join(outside, 'secret.txt'), 'TOP SECRET\n')
    symlinkSync(outside, join(root, 'linked'), 'junction')
    const { fs, caller } = await setup(root)
    caller.preset = 'standard-devcontainer'

    const refusal = fs.resolve(`${CONTAINER_MOUNT}/linked/secret.txt`)
    await expect(refusal).rejects.toThrow('refused to access this path')
    await expect(fs.resolve(`${CONTAINER_MOUNT}/linked/secret.txt`)).rejects.toThrow('resolves to')
    await expect(fs.resolve(`${CONTAINER_MOUNT}/linked/secret.txt`)).rejects.toThrow('standard-devcontainer')
    await expect(fs.resolve(`${CONTAINER_MOUNT}/linked/secret.txt`)).rejects.toThrow('must not point out of it')
  })

  it('refuses a host path outside every container repository', async () => {
    const { root } = makeContainerRepo()
    const { fs, caller } = await setup(root)
    caller.preset = 'standard-devcontainer'
    await expect(fs.resolve(join(temporaryDirectory(), 'secret.txt')))
      .rejects.toMatchObject({ code: 'FS_PERMISSION_DENIED' })
  })

  it('writes nothing to the host when the repository declares no container', async () => {
    const root = temporaryDirectory()
    writeFileSync(join(root, 'a.ts'), 'old\n')
    const { fs, caller } = await setup(root)
    caller.preset = 'standard-devcontainer'
    await expect(fs.resolve(join(root, 'a.ts'))).rejects.toMatchObject({ code: 'FS_PERMISSION_DENIED' })
    expect(readFileSync(join(root, 'a.ts'), 'utf8')).toBe('old\n')
  })
})

describe('a container-bound session isolates RPC failures', () => {
  it('reports a transport failure as an I/O error and re-probes the container', async () => {
    const { root } = makeContainerRepo({ 'src/a.ts': 'export {}\n' })
    const { fs, caller, cli } = await setup(root)
    caller.preset = 'standard-devcontainer'

    // First call resolves the container through the CLI and the channel works.
    await fs.readText(await fs.resolve(`${CONTAINER_MOUNT}/src/a.ts`))
    const probes = cli.calls.length
    expect(probes).toBeGreaterThan(0)

    const broken = stubChannel(
      { workspace: CONTAINER_MOUNT, workspaceReal: CONTAINER_MOUNT },
      () => Promise.reject(new Error('the container filesystem helper stopped (exit 137)')),
    )
    fs.containerInternals.channel = async () => broken
    const failure = await fs.resolve(`${CONTAINER_MOUNT}/src/a.ts`).catch((error: unknown) => error)
    expect(failure).toMatchObject({ code: 'FS_IO_ERROR' })
    expect((failure as Error).message).toContain('stopped')

    // The failed call dropped the cached container id, so the next one probes
    // Docker again instead of reusing an id the container may have replaced.
    const restored = await helperChannel(CONTAINER_MOUNT, root)
    fs.containerInternals.channel = async () => stubChannel(
      restored.handshake,
      (method, params) => restored.request(method, params),
    )
    expect(await fs.readText(await fs.resolve(`${CONTAINER_MOUNT}/src/a.ts`))).toBe('export {}\n')
    expect(cli.calls.length).toBeGreaterThan(probes)
  })

  it('keeps a remote filesystem code instead of flattening it', async () => {
    const { root } = makeContainerRepo({ 'src/a.ts': 'export {}\n' })
    const { fs, caller } = await setup(root)
    caller.preset = 'standard-devcontainer'
    const target = await fs.resolve(`${CONTAINER_MOUNT}/missing.ts`)
    const failure = await fs.readText(target).catch((error: unknown) => error)
    expect(failure).toMatchObject({ code: 'FS_NOT_FOUND' })
  })

  it('reports a container that cannot be found', async () => {
    const { root } = makeContainerRepo({ 'src/a.ts': '' })
    const { fs, caller, cli } = await setup(root)
    caller.preset = 'standard-devcontainer'
    fs.containerInternals.run = (argv) => {
      cli.calls.push([...argv])
      return Promise.resolve({ stdout: '', stderr: '', exitCode: 1 })
    }
    const failure = await fs.resolve(`${CONTAINER_MOUNT}/src/a.ts`).catch((error: unknown) => error)
    expect(failure).toMatchObject({ code: 'FS_IO_ERROR' })
    expect((failure as Error).message).toContain('devcontainer up failed')
  })

  it('keeps a refusal the helper raised', async () => {
    const { root } = makeContainerRepo({ 'src/a.ts': 'export {}\n' })
    const { fs, caller } = await setup(root)
    caller.preset = 'standard-devcontainer'
    const target = await fs.resolve(`${CONTAINER_MOUNT}/src/a.ts`)
    fs.containerInternals.channel = async () => stubChannel(
      { workspace: CONTAINER_MOUNT, workspaceReal: CONTAINER_MOUNT },
      () => Promise.reject(new RpcOperationError('the helper refused', 'FS_PERMISSION_DENIED')),
    )
    await expect(fs.readText(target)).rejects.toMatchObject({ code: 'FS_PERMISSION_DENIED' })
    await expect(fs.readText(target)).rejects.toThrow('the helper refused')
  })
})

describe('a container-bound session watches through the container', () => {
  it('stops polling when the caller aborts the watch', async () => {
    const { root } = makeContainerRepo({ 'src/a.ts': 'one\n' })
    const { fs, caller } = await setup(root)
    caller.preset = 'standard-devcontainer'
    const target = await fs.resolve(`${CONTAINER_MOUNT}/src/a.ts`)
    const controller = new AbortController()
    let changes = 0

    await fs.watch(target, () => { changes += 1 }, controller.signal)
    controller.abort()
    writeFileSync(join(root, 'src', 'a.ts'), 'changed\n', 'utf8')
    await delay(1_500)
    expect(changes).toBe(0)
  })

  it('keeps polling when the reporter throws', async () => {
    const { root } = makeContainerRepo({ 'src/a.ts': 'one\n' })
    const { fs, caller } = await setup(root)
    caller.preset = 'standard-devcontainer'
    const target = await fs.resolve(`${CONTAINER_MOUNT}/src/a.ts`)
    const controller = new AbortController()
    let reports = 0
    const stop = await fs.watch(target, () => {
      reports += 1
      throw new Error('the reporter is broken')
    }, controller.signal)

    writeFileSync(join(root, 'src', 'a.ts'), 'two\n', 'utf8')
    await expect.poll(() => reports, { timeout: 5_000, interval: 100 }).toBeGreaterThan(0)
    writeFileSync(join(root, 'src', 'a.ts'), 'three\n', 'utf8')
    await expect.poll(() => reports, { timeout: 5_000, interval: 100 }).toBeGreaterThan(1)
    await stop()
  })

  it('reports a change without opening a host watcher', async () => {
    const { root } = makeContainerRepo({ 'src/a.ts': 'one\n' })
    const { fs, caller } = await setup(root)
    caller.preset = 'standard-devcontainer'
    const target = await fs.resolve(`${CONTAINER_MOUNT}/src/a.ts`)
    const controller = new AbortController()
    let changes = 0
    const stop = await fs.watch(target, () => { changes += 1 }, controller.signal)
    writeFileSync(join(root, 'src', 'a.ts'), 'two\n', 'utf8')
    await expect.poll(() => changes, { timeout: 5_000, interval: 100 }).toBeGreaterThan(0)
    await stop()
  })
})
