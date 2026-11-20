/** Local and remote file behaviour of the SSH POSIX provider, against a fake helper that records every request. */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it } from 'vitest'
import { SshPosixFileSystem } from '../src/fs.ts'
import { RemoteOperationError } from '../src/protocol.ts'

/** One helper request the provider sent. */
interface Call {
  readonly method: string
  readonly params: unknown
}

/** Result validator the provider hands to the SSH service. */
interface ResultSchema {
  parse(value: unknown): unknown
}

/** What the fake helper answers for one method. */
type Answer = (method: string, params: unknown) => unknown

/** This machine's roots, mirroring the harness home and the shared agent root. */
interface Host {
  readonly root: string
  readonly dshHome: string
  readonly agentsHome: string
  readonly workspace: string
}

/** A remote file's text, long enough that streaming it yields more than one chunk. */
const BIG_TEXT = Array.from({ length: 4096 }, (_, index) => `line ${index} ${'x'.repeat(40)}\n`).join('')
/** The bytes a remote helper hands back for the file the specs read. */
const REMOTE_BYTES = Buffer.from([0x00, 0x01, 0x02])
/** The iterator identity a remote text stream is opened under. */
const STREAM_ID = '11111111-1111-4111-8111-111111111111'

const cleanups: (() => void)[] = []
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup() })

function write(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content, 'utf8')
}

function makeHost(): Host {
  const root = mkdtempSync(join(tmpdir(), 'ssh-posix-fs-'))
  const dshHome = join(root, 'dsh')
  const agentsHome = join(root, 'agents')
  const workspace = join(root, 'workspace')
  write(join(dshHome, 'AGENTS.md'), '# dsh agents\n')
  write(join(dshHome, 'skills', 'demo', 'SKILL.md'), '# demo skill\n')
  write(join(dshHome, 'skills', 'demo', 'references', 'big.txt'), BIG_TEXT)
  write(join(dshHome, 'skills', 'demo', 'references', 'notes.md'), '# notes\n')
  write(join(agentsHome, 'AGENTS.md'), '# agents home agents\n')
  write(join(workspace, 'AGENTS.md'), '# workspace agents (node)\n')
  return { root, dshHome, agentsHome, workspace }
}

/** The rejection an operation was expected to produce. */
async function failureOf(operation: Promise<unknown>): Promise<{ code?: string; message?: string }> {
  return await operation.then(
    () => { throw new Error('the operation was expected to fail') },
    (error: unknown) => error as { code?: string; message?: string },
  )
}

/** Path a request addresses, whether it names a path or a carried target. */
function addressed(params: unknown): string {
  const value = params as { path?: string; target?: { targetKey?: string } }
  return value.path ?? value.target?.targetKey ?? ''
}

/** Target one remote file effect was sent for. */
function targetOf(params: unknown): string {
  const value = params as { target?: { targetKey?: string } }
  return value.target?.targetKey ?? ''
}

/** Answer every identity lookup with the caller's own remote path. */
function remoteAnswer(serve: Answer): Answer {
  return (method, params) => method === 'fs.resolve'
    ? { targetKey: addressed(params), displayPath: addressed(params) }
    : serve(method, params)
}

function unexpectedRequest(method: string): never {
  throw new Error(`unexpected helper request ${method}`)
}

async function setup(answer: Answer = unexpectedRequest): Promise<{ fs: SshPosixFileSystem; host: Host; calls: Call[] }> {
  const host = makeHost()
  const calls: Call[] = []
  process.env.DSH_HOME = host.dshHome
  process.env.DSH_AGENTS_HOME = host.agentsHome
  cleanups.push(() => {
    rmSync(host.root, { recursive: true, force: true })
    delete process.env.DSH_HOME
    delete process.env.DSH_AGENTS_HOME
  })
  const ctx = new Context()
  await ctx.plugin((child: Context) => {
    child.provide('ssh' as string, {
      request: async (method: string, params: unknown, schema: ResultSchema) => {
        calls.push({ method, params })
        return schema.parse(answer(method, params))
      },
    })
    child.provide('sandboxPolicy' as string, {
      defaultMode: 'workspace-write',
      resolve: () => ({ mode: 'workspace-write', workspaceRoot: '/srv/app' }),
    })
  })
  await ctx.plugin(SshPosixFileSystem)
  return { fs: ctx.fs as SshPosixFileSystem, host, calls }
}

/** The host file the byte specs read, as resolved and as stored. */
async function hostFile(fs: SshPosixFileSystem, host: Host): Promise<{ target: Awaited<ReturnType<SshPosixFileSystem['resolve']>>; stored: Buffer }> {
  const path = join(host.dshHome, 'skills', 'demo', 'references', 'big.txt')
  return { target: await fs.resolve(path), stored: readFileSync(path) }
}

describe('SshPosixFileSystem host file bytes', () => {
  it('returns the bytes the file holds when it fits the cap', async () => {
    const { fs, host } = await setup()
    const { target, stored } = await hostFile(fs, host)
    const read = await fs.readBytes(target, undefined, stored.byteLength)
    expect(Buffer.from(read).equals(stored)).toBe(true)
  })

  it('refuses a file larger than the cap without returning its content', async () => {
    const { fs, host, calls } = await setup()
    const { target, stored } = await hostFile(fs, host)
    const failure = await failureOf(fs.readBytes(target, undefined, stored.byteLength - 1))
    expect(failure).toMatchObject({ code: 'FS_TOO_LARGE' })
    expect(failure.message).not.toContain(BIG_TEXT.slice(0, 24))
    expect(calls).toHaveLength(0)
  })

  it('returns only the requested byte window', async () => {
    const { fs, host } = await setup()
    const { target, stored } = await hostFile(fs, host)
    const window = await fs.readByteRange(target, { offset: 10, length: 32 })
    expect(Buffer.from(window).equals(stored.subarray(10, 42))).toBe(true)
  })

  it('returns nothing for a window with no bytes or one that starts past the end', async () => {
    const { fs, host } = await setup()
    const { target, stored } = await hostFile(fs, host)
    expect((await fs.readByteRange(target, { offset: 0, length: 0 })).byteLength).toBe(0)
    expect((await fs.readByteRange(target, { offset: stored.byteLength + 8, length: 16 })).byteLength).toBe(0)
  })

  it('streams the file text whole', async () => {
    const { fs, host } = await setup()
    const { target } = await hostFile(fs, host)
    const chunks: string[] = []
    for await (const chunk of await fs.streamText(target)) chunks.push(chunk)
    expect(chunks.join('')).toBe(BIG_TEXT)
  })

  it('stops reading this machine\'s file once the caller aborts', async () => {
    const { fs, host } = await setup()
    const { target, stored } = await hostFile(fs, host)
    const abort = new AbortController()
    const chunks = await fs.streamText(target, abort.signal)
    const iterator = chunks[Symbol.asyncIterator]()
    const first = await iterator.next()
    expect(first.done).toBe(false)
    abort.abort()
    const failure = await failureOf(iterator.next())
    expect(failure).toMatchObject({ code: 'FS_ABORTED' })
    const rest = await iterator.next()
    expect(rest.done).toBe(true)
    expect(Buffer.byteLength(String(first.value), 'utf8')).toBeLessThan(stored.byteLength)
  })
})

describe('SshPosixFileSystem host paths that carry no file', () => {
  it('reports an absent host file as missing for whole reads and for a window', async () => {
    const { fs, host, calls } = await setup()
    const missing = await fs.resolve(join(host.dshHome, 'skills', 'demo', 'references', 'missing.txt'))
    expect(await failureOf(fs.readText(missing))).toMatchObject({ code: 'FS_NOT_FOUND' })
    expect(await failureOf(fs.readBytes(missing, undefined, 16))).toMatchObject({ code: 'FS_NOT_FOUND' })
    expect(await failureOf(fs.readByteRange(missing, { offset: 0, length: 16 }))).toMatchObject({ code: 'FS_NOT_FOUND' })
    expect(await fs.stat(missing)).toBeUndefined()
    expect(calls).toHaveLength(0)
  })

  it('reports a directory listing that names a file or an absent path', async () => {
    const { fs, host, calls } = await setup()
    const file = await fs.resolve(join(host.dshHome, 'skills', 'demo', 'references', 'big.txt'))
    expect(await failureOf(fs.listDir(file))).toMatchObject({ code: 'FS_NOT_DIRECTORY' })
    const missing = await fs.resolve(join(host.dshHome, 'skills', 'demo', 'references', 'nope'))
    expect(await failureOf(fs.listDir(missing))).toMatchObject({ code: 'FS_NOT_FOUND' })
    expect(calls).toHaveLength(0)
  })

  it('lists a host directory in name order', async () => {
    const { fs, host, calls } = await setup()
    const entries = await fs.listDir(await fs.resolve(join(host.dshHome, 'skills', 'demo', 'references')))
    expect(entries.map(entry => [entry.name, entry.type])).toEqual([['big.txt', 'file'], ['notes.md', 'file']])
    expect(calls).toHaveLength(0)
  })

  it('refuses a host listing the caller already aborted', async () => {
    const { fs, host, calls } = await setup()
    const directory = await fs.resolve(join(host.dshHome, 'skills', 'demo', 'references'))
    const abort = new AbortController()
    abort.abort()
    expect(await failureOf(fs.listDir(directory, abort.signal))).toMatchObject({ code: 'FS_ABORTED' })
    expect(calls).toHaveLength(0)
  })

  it('treats an agent-adjacent path under the harness home as the SSH host\'s', async () => {
    const { fs, host, calls } = await setup((method) => {
      if (method === 'fs.resolve') return { targetKey: '/srv/app/config.json', displayPath: '/srv/app/config.json' }
      throw new Error(`unexpected helper request ${method}`)
    })
    const target = await fs.resolve(join(host.dshHome, 'config.json'))
    expect(target.targetKey).toBe('/srv/app/config.json')
    expect(calls.map(call => call.method)).toEqual(['fs.resolve'])
  })
})

describe('SshPosixFileSystem remote reads', () => {
  it('asks the helper for a remote file\'s bytes and returns them', async () => {
    const { fs, calls } = await setup(remoteAnswer((method) => {
      if (method === 'fs.readBytes') return REMOTE_BYTES.toString('base64')
      throw new Error(`unexpected helper request ${method}`)
    }))
    const target = await fs.resolve('/srv/app/notes.bin')
    const read = await fs.readBytes(target, undefined, 4096)
    expect(Array.from(read)).toEqual([0, 1, 2])
    expect(calls.map(call => call.method)).toEqual(['fs.resolve', 'fs.readBytes'])
    expect(targetOf(calls[1]?.params)).toBe('/srv/app/notes.bin')
  })

  it('asks the helper for one remote byte window', async () => {
    const { fs, calls } = await setup(remoteAnswer((method) => {
      if (method === 'fs.readRange') return Buffer.from([0x41, 0x42]).toString('base64')
      throw new Error(`unexpected helper request ${method}`)
    }))
    const target = await fs.resolve('/srv/app/notes.bin')
    const window = await fs.readByteRange(target, { offset: 4, length: 2 })
    expect(Buffer.from(window).toString('utf8')).toBe('AB')
    expect(calls.at(-1)?.method).toBe('fs.readRange')
  })

  it('streams a remote file from the helper\'s iterator', async () => {
    const replies = [
      { done: false, value: 'a' },
      { done: false, value: '' },
      { done: true, value: '' },
    ]
    const { fs, calls } = await setup(remoteAnswer((method) => {
      if (method === 'fs.stream') return STREAM_ID
      if (method === 'fs.next') return replies.shift()
      throw new Error(`unexpected helper request ${method}`)
    }))
    const target = await fs.resolve('/srv/app/notes.txt')
    const chunks: string[] = []
    for await (const chunk of await fs.streamText(target)) chunks.push(chunk)
    expect(chunks.join('')).toBe('a')
    expect(calls.map(call => call.method)).toEqual(['fs.resolve', 'fs.stream', 'fs.next', 'fs.next', 'fs.next'])
  })

  it('closes the remote stream and reads no further once the caller aborts', async () => {
    const { fs, calls } = await setup(remoteAnswer((method) => {
      if (method === 'fs.stream') return STREAM_ID
      if (method === 'fs.next') return { done: false, value: 'a' }
      if (method === 'fs.streamClose') return null
      throw new Error(`unexpected helper request ${method}`)
    }))
    const target = await fs.resolve('/srv/app/notes.txt')
    const abort = new AbortController()
    const iterator = (await fs.streamText(target, abort.signal))[Symbol.asyncIterator]()
    expect(await iterator.next()).toEqual({ done: false, value: 'a' })
    abort.abort()
    const failure = await failureOf(iterator.next())
    expect(failure.message).toMatch(/abort/iu)
    expect(calls.filter(call => call.method === 'fs.next')).toHaveLength(1)
    expect(calls.at(-1)?.method).toBe('fs.streamClose')
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(calls.filter(call => call.method === 'fs.next')).toHaveLength(1)
  })

  it('reports remote metadata, including a path that is a symlink', async () => {
    const { fs, calls } = await setup(remoteAnswer((method) => {
      if (method === 'fs.stat') return null
      if (method === 'fs.lstat') return { version: 'v1', type: 'symlink', size: 12 }
      throw new Error(`unexpected helper request ${method}`)
    }))
    const target = await fs.resolve('/srv/app/link')
    expect(await fs.stat(target)).toBeUndefined()
    expect(await fs.lstat('/srv/app/link')).toEqual({ version: 'v1', type: 'symlink', size: 12 })
    expect(calls.map(call => call.method)).toEqual(['fs.resolve', 'fs.stat', 'fs.lstat'])
  })

  it('lists a remote directory from the helper\'s entries', async () => {
    const entries = [{ name: 'notes.txt', type: 'file', target: { targetKey: '/srv/app/notes.txt', displayPath: 'notes.txt' }, size: 4 }]
    const { fs, calls } = await setup(remoteAnswer((method) => {
      if (method === 'fs.list') return entries
      throw new Error(`unexpected helper request ${method}`)
    }))
    const target = await fs.resolve('/srv/app')
    expect(await fs.listDir(target)).toEqual(entries)
    expect(calls.at(-1)?.method).toBe('fs.list')
  })
})

describe('SshPosixFileSystem remote mutations', () => {
  it('forwards a write under the deployment policy and returns the helper\'s outcome', async () => {
    const outcome = { operation: 'update', version: 'v2', before: 'old\n', after: 'new\n' }
    const { fs, calls } = await setup(remoteAnswer((method) => {
      if (method === 'fs.write') return outcome
      throw new Error(`unexpected helper request ${method}`)
    }))
    const target = await fs.resolve('/srv/app/notes.txt')
    expect(await fs.writeText(target, 'new\n')).toEqual(outcome)
    expect(calls.at(-1)?.method).toBe('fs.write')
    expect(calls.at(-1)?.params).toMatchObject({ content: 'new\n', policy: { mode: 'workspace-write', workspaceRoot: '/srv/app' } })
  })

  it('forwards an edit and returns the helper\'s outcome', async () => {
    const outcome = { version: 'v2', before: 'old\n', after: 'new\n' }
    const { fs, calls } = await setup(remoteAnswer((method) => {
      if (method === 'fs.edit') return outcome
      throw new Error(`unexpected helper request ${method}`)
    }))
    const target = await fs.resolve('/srv/app/notes.txt')
    expect(await fs.editText(target, { oldString: 'old', newString: 'new', replaceAll: false })).toEqual(outcome)
    const sent = calls.at(-1)
    expect(sent?.method).toBe('fs.edit')
    expect(sent?.params).toMatchObject({ edit: { oldString: 'old', newString: 'new', replaceAll: false } })
  })

  it('forwards a patch and returns the helper\'s outcome', async () => {
    const outcome = { version: 'v3', before: 'a\n', after: 'b\n' }
    const { fs, calls } = await setup(remoteAnswer((method) => {
      if (method === 'fs.patch') return outcome
      throw new Error(`unexpected helper request ${method}`)
    }))
    const target = await fs.resolve('/srv/app/notes.txt')
    const hunks = [{ lineNumber: 1, oldLines: ['a'], newLines: ['b'], isEndOfFile: false }]
    expect(await fs.patchText(target, hunks)).toEqual(outcome)
    expect(calls.at(-1)?.method).toBe('fs.patch')
    expect(calls.at(-1)?.params).toMatchObject({ hunks })
  })

  it('forwards a delete and returns the helper\'s outcome', async () => {
    const { fs, calls } = await setup(remoteAnswer((method) => {
      if (method === 'fs.delete') return { before: 'removed\n' }
      throw new Error(`unexpected helper request ${method}`)
    }))
    const target = await fs.resolve('/srv/app/notes.txt')
    expect(await fs.deleteFile(target)).toEqual({ before: 'removed\n' })
    expect(calls.at(-1)?.method).toBe('fs.delete')
  })

  it('forwards a move and returns the helper\'s outcome', async () => {
    const outcome = {
      sourceBefore: 'moved\n',
      destination: { operation: 'create', version: 'v1', before: null, after: 'moved\n' },
      sourceDeleted: true,
    }
    const { fs, calls } = await setup(remoteAnswer((method) => {
      if (method === 'fs.move') return outcome
      throw new Error(`unexpected helper request ${method}`)
    }))
    const source = await fs.resolve('/srv/app/notes.txt')
    const destination = await fs.resolve('/srv/app/archive/notes.txt')
    expect(await fs.moveFile(source, destination, {})).toEqual(outcome)
    const sent = calls.at(-1)
    expect(sent?.method).toBe('fs.move')
    expect(sent?.params).toMatchObject({
      source: { targetKey: '/srv/app/notes.txt' },
      destination: { targetKey: '/srv/app/archive/notes.txt' },
    })
  })

  it('reports a helper failure with the code the helper named', async () => {
    const { fs } = await setup(remoteAnswer((method) => {
      if (method === 'fs.readText') throw new RemoteOperationError('no such file', 'FS_NOT_FOUND')
      throw new Error(`unexpected helper request ${method}`)
    }))
    const target = await fs.resolve('/srv/app/missing.txt')
    expect(await failureOf(fs.readText(target))).toMatchObject({ code: 'FS_NOT_FOUND', message: 'no such file' })
  })

  it('reports an unclassified helper failure as an I/O error', async () => {
    const { fs } = await setup(remoteAnswer((method) => {
      if (method === 'fs.readText') throw new Error('connection reset')
      throw new Error(`unexpected helper request ${method}`)
    }))
    const target = await fs.resolve('/srv/app/notes.txt')
    expect(await failureOf(fs.readText(target))).toMatchObject({ code: 'FS_IO_ERROR', message: 'connection reset' })
  })

  it('reports a helper call the caller aborted as aborted', async () => {
    const { fs } = await setup(remoteAnswer((method) => {
      if (method === 'fs.readText') throw new Error('socket closed')
      throw new Error(`unexpected helper request ${method}`)
    }))
    const abort = new AbortController()
    abort.abort()
    const target = { targetKey: '/srv/app/notes.txt', displayPath: '/srv/app/notes.txt' }
    expect(await failureOf(fs.readText(target as Parameters<SshPosixFileSystem['readText']>[0], abort.signal))).toMatchObject({ code: 'FS_ABORTED' })
  })
})

describe('SshPosixFileSystem host mutations', () => {
  it('refuses to edit or patch this machine\'s AGENTS.md without reaching the helper', async () => {
    const { fs, host, calls } = await setup()
    const target = await fs.resolve(join(host.dshHome, 'AGENTS.md'))
    const edit = await failureOf(fs.editText(target, { oldString: 'dsh', newString: 'x', replaceAll: false }))
    const patch = await failureOf(fs.patchText(target, [{ lineNumber: 1, oldLines: ['x'], newLines: ['y'], isEndOfFile: false }]))
    expect(edit).toMatchObject({ code: 'FS_PERMISSION_DENIED' })
    expect(patch).toMatchObject({ code: 'FS_PERMISSION_DENIED' })
    expect(readFileSync(join(host.dshHome, 'AGENTS.md'), 'utf8')).toBe('# dsh agents\n')
    expect(calls).toHaveLength(0)
  })

  it('refuses to delete a skill file or move it onto this machine', async () => {
    const { fs, host, calls } = await setup()
    const skill = await fs.resolve(join(host.dshHome, 'skills', 'demo', 'SKILL.md'))
    const denied = await failureOf(fs.deleteFile(skill))
    expect(denied).toMatchObject({ code: 'FS_PERMISSION_DENIED' })
    expect(calls).toHaveLength(0)
    const moved = await failureOf(fs.moveFile(skill, await fs.resolve(join(host.agentsHome, 'AGENTS.md')), {}))
    expect(moved).toMatchObject({ code: 'FS_PERMISSION_DENIED' })
    expect(calls).toHaveLength(0)
    expect(readFileSync(join(host.dshHome, 'skills', 'demo', 'SKILL.md'), 'utf8')).toBe('# demo skill\n')
  })
})

describe('SshPosixFileSystem target identity', () => {
  it('names a remote target with a file URL', async () => {
    const { fs } = await setup(remoteAnswer((method) => { throw new Error(`unexpected helper request ${method}`) }))
    const target = await fs.resolve('/srv/app/AGENTS.md')
    const url = fs.fileUrl(target)
    expect(url.startsWith('file://')).toBe(true)
    expect(new URL(url).pathname.endsWith('/srv/app/AGENTS.md')).toBe(true)
  })

  it('contains a remote target and its descendants but not an unrelated path', async () => {
    const { fs } = await setup(remoteAnswer((method) => { throw new Error(`unexpected helper request ${method}`) }))
    const workspace = await fs.resolve('/srv/app')
    expect(fs.contains(workspace, await fs.resolve('/srv/app/AGENTS.md'))).toBe(true)
    expect(fs.contains(workspace, workspace)).toBe(true)
    expect(fs.contains(workspace, await fs.resolve('/srv/other/notes.txt'))).toBe(false)
  })

  it('reports the deployment sandbox mode for mutations', async () => {
    const { fs } = await setup()
    expect(fs.sandboxMode).toBe('workspace-write')
  })
})
