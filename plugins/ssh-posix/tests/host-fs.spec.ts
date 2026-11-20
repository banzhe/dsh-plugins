/** Host-local AGENTS.md and skills reads, against a fake SSH service that records every request. */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it } from 'vitest'
import { SshPosixFileSystem } from '../src/fs.ts'

/** One helper request the provider sent. */
interface Call {
  readonly method: string
  readonly path: string
}

/** Result validator the provider hands to the SSH service. */
interface ResultSchema {
  parse(value: unknown): unknown
}

/** This machine's roots, mirroring the harness home and the shared agent root. */
interface Host {
  readonly root: string
  readonly dshHome: string
  readonly agentsHome: string
  readonly workspace: string
}

const REMOTE_TARGET = { targetKey: '/srv/app/AGENTS.md', displayPath: '/srv/app/AGENTS.md' }

/** The only answers the fake helper serves: one remote file and its identity. */
const REMOTE: Record<string, unknown> = {
  'fs.resolve': REMOTE_TARGET,
  'fs.readText': '# remote agents\n',
}

const cleanups: (() => void)[] = []
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup() })

function write(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content, 'utf8')
}

function makeHost(): Host {
  const root = mkdtempSync(join(tmpdir(), 'ssh-posix-host-'))
  const dshHome = join(root, 'dsh')
  const agentsHome = join(root, 'agents')
  const workspace = join(root, 'workspace')
  write(join(dshHome, 'AGENTS.md'), '# dsh agents\n')
  write(join(dshHome, 'skills', 'demo', 'SKILL.md'), '# demo skill\n')
  write(join(dshHome, 'skills', 'demo', 'references', 'a.md'), '# reference a\n')
  write(join(dshHome, 'skills', 'demo', 'scripts', 'secret.sh'), 'TOPSECRET\necho hi\n')
  write(join(agentsHome, 'AGENTS.md'), '# agents home agents\n')
  write(join(agentsHome, 'skills', 'shared', 'SKILL.md'), '# shared skill\n')
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

/** Path a request addresses, whether it names a path or a resolved target. */
function requestedPath(params: unknown): string {
  const value = params as { path?: string; target?: { displayPath?: string } }
  return value.path ?? value.target?.displayPath ?? ''
}

async function setup(): Promise<{ fs: SshPosixFileSystem; host: Host; calls: Call[] }> {
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
        calls.push({ method, path: requestedPath(params) })
        const answer = REMOTE[method]
        if (answer === undefined) throw new Error(`unexpected helper request ${method}`)
        return schema.parse(answer)
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

describe('SshPosixFileSystem host AGENTS.md', () => {
  it('reads this machine\'s files from node without a helper request', async () => {
    const { fs, host, calls } = await setup()
    expect(await fs.readText(await fs.resolve(join(host.dshHome, 'AGENTS.md')))).toBe('# dsh agents\n')
    expect(await fs.readText(await fs.resolve(join(host.agentsHome, 'AGENTS.md')))).toBe('# agents home agents\n')
    expect(calls).toHaveLength(0)
  })

  it('reports an absent host file as absent instead of asking the helper', async () => {
    const { fs, host, calls } = await setup()
    rmSync(join(host.dshHome, 'AGENTS.md'))
    expect(await fs.stat(await fs.resolve(join(host.dshHome, 'AGENTS.md')))).toBeUndefined()
    expect(calls).toHaveLength(0)
  })
})

describe('SshPosixFileSystem host skills', () => {
  it('serves the skills roots, skill files and references from node', async () => {
    const { fs, host, calls } = await setup()
    const root = await fs.resolve(join(host.dshHome, 'skills'))
    expect((await fs.listDir(root)).map(entry => [entry.name, entry.type])).toEqual([['demo', 'directory']])
    expect(await fs.readText(await fs.resolve(join(host.dshHome, 'skills', 'demo', 'SKILL.md')))).toBe('# demo skill\n')
    expect(await fs.readText(await fs.resolve(join(host.dshHome, 'skills', 'demo', 'references', 'a.md')))).toBe('# reference a\n')
    expect(await fs.readText(await fs.resolve(join(host.agentsHome, 'skills', 'shared', 'SKILL.md')))).toBe('# shared skill\n')
    expect(calls).toHaveLength(0)
  })

  it('refuses a skill script without revealing it or reaching the helper', async () => {
    const { fs, host, calls } = await setup()
    const script = join(host.dshHome, 'skills', 'demo', 'scripts', 'secret.sh')
    expect(readFileSync(script, 'utf8')).toContain('TOPSECRET')
    const failure = await failureOf(fs.resolve(script).then(target => fs.readText(target)))
    expect(failure).toMatchObject({ code: 'FS_PERMISSION_DENIED' })
    expect(failure.message).not.toContain('TOPSECRET')
    expect(calls).toHaveLength(0)
  })
})

describe('SshPosixFileSystem remote paths', () => {
  it('forwards a workspace path instead of reading its local namesake', async () => {
    const { fs, host, calls } = await setup()
    const namesake = join(host.workspace, 'AGENTS.md')
    expect(await fs.readText(await fs.resolve(namesake))).toBe('# remote agents\n')
    expect(readFileSync(namesake, 'utf8')).toBe('# workspace agents (node)\n')
    expect(calls.map(call => call.method)).toEqual(['fs.resolve', 'fs.readText'])
  })

  it('does not follow a .. escape out of the skills tree onto a node namesake', async () => {
    const { fs, host, calls } = await setup()
    const escaped = join(host.dshHome, 'skills', 'demo', 'references', '..', '..', '..', '..', 'workspace', 'AGENTS.md')
    expect(await fs.readText(await fs.resolve(escaped))).toBe('# remote agents\n')
    expect(readFileSync(join(host.workspace, 'AGENTS.md'), 'utf8')).toBe('# workspace agents (node)\n')
    expect(calls).toHaveLength(2)
  })
})

describe('SshPosixFileSystem host mutations', () => {
  it('refuses to write this machine\'s AGENTS.md without reaching the helper', async () => {
    const { fs, host, calls } = await setup()
    const target = await fs.resolve(join(host.dshHome, 'AGENTS.md'))
    const failure = await failureOf(fs.writeText(target, '# overwritten\n'))
    expect(failure).toMatchObject({ code: 'FS_PERMISSION_DENIED' })
    expect(readFileSync(join(host.dshHome, 'AGENTS.md'), 'utf8')).toBe('# dsh agents\n')
    expect(calls).toHaveLength(0)
  })
})
