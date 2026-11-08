import { afterAll, describe, expect, it } from 'vitest'
import { win32 } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import WorkingDirectory from '@deepseek-ai/dsh-working-directory'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { DevcontainerFileSystem } from '../src/fs.ts'
import type { ContainerRun } from '../src/exec.ts'
import { repoRegistry } from '../src/registry.ts'
import type { ContainerRpcChannel } from '../src/rpc/client.ts'
import { sandboxNameFor } from '../src/sbx.ts'
import { cleanupTemporaryDirectories } from './support.ts'

afterAll(cleanupTemporaryDirectories)

/** The workspace a Windows host mounts as `/f/personal/asmr-manager` in its sandbox. */
const HOST = 'F:\\personal\\asmr-manager'

/** The path that workspace has inside the sandbox. */
const MOUNT = '/f/personal/asmr-manager'

/** One event a fake Session recorded. */
interface RecordedEvent {
  readonly type: string
  readonly data: Record<string, unknown>
}

/** The Session slice the working-directory service and its projection read. */
interface FakeSession {
  readonly header: { readonly cwd: string }
  readonly events: RecordedEvent[]
  append(type: string, data: Record<string, unknown>): void
}

/** The projection schema the registry was handed, so the state can be folded here. */
interface ProjectionSchema {
  init(header: { readonly cwd?: string }): string | null
  apply(state: string | null, event: RecordedEvent): string | null
}

/**
 * The projection registry the working-directory service registers into.
 *
 * The service reads its recorded directory from `sessionProjections.stateOf`,
 * so this folds the events the Session logged under the schema the service
 * registered — the same answer the real registry gives.
 * @returns the registry a test context provides.
 */
function projectionRegistry(): {
  register(config: ProjectionSchema & { key: string }): { key: string }
  stateOf(session: FakeSession, key: string): string | null
} {
  const schemas = new Map<string, ProjectionSchema>()
  return {
    register(config) {
      schemas.set(config.key, config)
      return { key: config.key }
    },
    stateOf(session, key) {
      const schema = schemas.get(key)
      if (schema === undefined) return null
      let state = schema.init(session.header)
      for (const event of session.events) state = schema.apply(state, event)
      return state
    },
  }
}

/**
 * A CLI stand-in answering the two calls a sandbox probe makes.
 * @param listing - the `sbx ls --json` rows to report.
 * @returns the runner every probe goes through.
 */
function sandboxCli(listing: readonly unknown[]): ContainerRun {
  return (argv) => {
    if (argv[0] !== 'sbx') return Promise.resolve({ stdout: '', stderr: 'unexpected', exitCode: 1 })
    if (argv[1] === 'ls') return Promise.resolve({ stdout: JSON.stringify(listing), stderr: '', exitCode: 0 })
    if (argv[1] === 'exec') return Promise.resolve({ stdout: '/usr/local/bin/node\n', stderr: '', exitCode: 0 })
    return Promise.resolve({ stdout: '', stderr: '', exitCode: 0 })
  }
}

/**
 * A channel stand-in for a sandbox holding the workspace mount.
 *
 * It answers in the container's own paths, which is what the real helper does,
 * and records every request so a test can see which spelling the row sent.
 * @returns the channel and the requests it received.
 */
function sandboxChannel(): { channel: ContainerRpcChannel, requests: { method: string, params: unknown }[] } {
  const requests: { method: string, params: unknown }[] = []
  const answer = (method: string, params: unknown): unknown => {
    const input = params as { path?: string, target?: { targetKey: string } }
    const path = input.path ?? input.target?.targetKey ?? ''
    switch (method) {
      case 'fs.resolve':
        return { targetKey: path, displayPath: path }
      case 'fs.stat':
      case 'fs.lstat':
        return { version: 'v1', type: 'directory' }
      default:
        throw new Error(`unexpected request: ${method}`)
    }
  }
  const channel = {
    handshake: { workspace: MOUNT, workspaceReal: MOUNT },
    isClosed: false,
    closedPromise: Promise.resolve(),
    request: (method: string, params: unknown): Promise<unknown> => {
      requests.push({ method, params })
      return Promise.resolve(answer(method, params))
    },
  } as unknown as ContainerRpcChannel
  return { channel, requests }
}

/** The row, its Session, and the two seams under test. */
interface Fixture {
  readonly workingDirectory: { get(session: FakeSession): string, set(agent: Agent, path: string): Promise<string> }
  readonly fs: DevcontainerFileSystem
  readonly agent: Agent
  readonly session: FakeSession
  readonly injected: unknown[]
  readonly requests: { method: string, params: unknown }[]
}

/**
 * Boot the filesystem row, the real working-directory service, and one Session
 * whose recorded project is the host workspace.
 * @returns the seams a test drives, and what they recorded.
 */
async function setup(): Promise<Fixture> {
  repoRegistry().reset()
  const ctx = new Context()
  const caller: { preset: string | null } = { preset: 'delegate-only-sbx' }
  const session: FakeSession = {
    header: { cwd: HOST },
    events: [],
    append(type, data) { this.events.push({ type, data }) },
  }
  const injected: unknown[] = []
  await ctx.plugin((child: Context) => {
    child.provide('sandboxPolicy' as string, {
      defaultMode: 'danger-full-access',
      resolve: () => ({ mode: 'danger-full-access', workspaceRoot: HOST }),
    })
    child.provide('agents' as string, { currentInitiator: () => ({ session }) })
    child.provide('agentPresets' as string, { presetForSession: () => caller.preset })
    child.provide('sessionProjections' as string, projectionRegistry())
    child.provide('systemPrompt' as string, { context: () => {}, getContextOrder: () => 100 })
  })
  await ctx.plugin(DevcontainerFileSystem, { cwd: HOST })
  const fs = ctx.fs as DevcontainerFileSystem
  fs.containerInternals.run = sandboxCli([{ name: sandboxNameFor(HOST), status: 'running' }])
  const mounted = sandboxChannel()
  fs.containerInternals.channel = async () => mounted.channel
  await ctx.plugin(WorkingDirectory, { defaultDirectory: HOST })
  const agent = {
    session,
    ctx: { fiber: { assertActive: () => {} } },
    inject: (message: unknown) => { injected.push(message) },
  } as unknown as Agent
  return {
    workingDirectory: ctx.workingDirectory as unknown as Fixture['workingDirectory'],
    fs,
    agent,
    session,
    injected,
    requests: mounted.requests,
  }
}

describe('a (sbx) Session over a Windows workspace', () => {
  it('records the host directory as the Session directory', async () => {
    const f = await setup()
    await expect(f.workingDirectory.set(f.agent, HOST)).resolves.toBe(HOST)
    expect(f.workingDirectory.get(f.session)).toBe(HOST)
    // The session was already in that directory, so nothing changed and the
    // model is told nothing.
    expect(f.session.events).toEqual([])
    expect(f.injected).toEqual([])
  })

  it('keeps the directory a host-side project walk resolves `.git` against', async () => {
    const f = await setup()
    await f.workingDirectory.set(f.agent, HOST)
    // The failure this guards: recording `/f/personal/asmr-manager` made the
    // host walk look in `F:\f\personal\asmr-manager\.git`, a directory no
    // repository contains.
    expect(win32.resolve(f.workingDirectory.get(f.session), '.git')).toBe(`${HOST}\\.git`)
  })

  it('records a subdirectory in the host namespace', async () => {
    const f = await setup()
    const below = `${HOST}\\src`
    await expect(f.workingDirectory.set(f.agent, below)).resolves.toBe(below)
    expect(f.session.events).toEqual([{ type: 'working-directory/change', data: { cwd: below } }])
    expect(f.injected).toHaveLength(1)
  })

  it('still sends the sandbox spelling to the runtime', async () => {
    const f = await setup()
    const target = await f.fs.resolve(HOST)
    expect(f.requests[0]).toEqual({ method: 'fs.resolve', params: { path: MOUNT } })
    expect(f.fs.processPath(target)).toBe(HOST)
  })
})
