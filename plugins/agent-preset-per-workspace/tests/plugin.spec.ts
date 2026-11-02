/**
 * The plugin's listeners and the session-creation factory it wraps, driven
 * through its real `apply` over a real Cordis context and the REAL domain
 * facility, with an in-memory KV backend standing in for the json medium. The
 * Host services the plugin reads are doubles, because a real preset registry
 * needs a Loader tree and a real workspace registry needs session persistence.
 *
 * The `agentPresets` double mirrors the one behaviour this plugin depends on
 * (`packages/preset/agent-preset-registry/src/index.ts:319-334`): `select`
 * appends `agent-preset/selected` to the target session's log and the registry
 * re-emits it with `(sessionId, presetId)`. The composition a fresh creation
 * gets in its setup callback appends nothing, so it stays invisible here —
 * which is exactly the seam the recorder leans on.
 *
 * The `sessionController` double is the Host's session factory. The plugin wraps
 * its `create`, so the request that arrives there is exactly what the wrapper
 * composed or chose to leave alone, and the reference left behind after unload is
 * the one it restored.
 */
import { Context } from '@deepseek-ai/cordis'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WORKSPACE_PRESET_DOMAIN, WORKSPACE_PRESET_TABLE, workspacePresetDomainSpec } from '../src/domain.ts'
import type { SessionControllerLike, SessionCreateRequestLike } from '../src/index.ts'
import { apply, inject } from '../src/index.ts'

const CWD = 'D:/work/demo'
const WORKSPACE = 'workspace-1'

const ORPHAN_CWD = 'D:/work/elsewhere'

interface SessionDouble {
  header: {
    cwd?: string
    origin?: 'subagent'
    parentSession?: string
    agentPreset?: string
  }
  append(type: string, data: unknown): void
}

interface AgentDouble {
  id: string
  session: SessionDouble
}

/** Calls that reached the session factory, i.e. the requests the wrapper let through. */
type CreateMock = ReturnType<typeof vi.fn<(request?: SessionCreateRequestLike) => Promise<unknown>>>

/**
 * The Host factory the plugin patches. `create` is declared as a property holding
 * a function rather than as a method, so reading the reference back (to prove the
 * plugin restored it) never implies a `this` the service would need.
 */
interface SessionControllerDouble {
  create: (request?: SessionCreateRequestLike) => Promise<unknown>
}

interface Bench {
  ctx: Context
  facility: DomainFacility
  /** The medium: table name → key → stored record. */
  tables: Map<string, Map<string, unknown>>
  live: Map<string, SessionDouble>
  resolveByPath: ReturnType<typeof vi.fn>
  select: ReturnType<typeof vi.fn>
  /** The Host service object itself, the very reference the plugin patches. */
  controller: SessionControllerDouble
  /** The factory as it stood before the plugin wrapped it. */
  originalCreate: SessionControllerLike['create']
  factory: CreateMock
}

/** Either mark alone disqualifies a session; a shape in this table must never take or bank a default. */
const NON_TOP_LEVEL_HEADERS: ReadonlyArray<readonly [string, SessionDouble['header']]> = [
  ['a subagent child', { cwd: CWD, origin: 'subagent' }],
  ['a forked session', { cwd: CWD, parentSession: 'session-parent' }],
]

/** Read the stored record from the medium, not from the domain's own memory. */
function stored(bench: Bench, workspaceId = WORKSPACE): { agentPreset?: string, updatedAt?: string } | undefined {
  return bench.tables.get(WORKSPACE_PRESET_TABLE)?.get(workspaceId) as
    | { agentPreset?: string, updatedAt?: string }
    | undefined
}

function sessionOf(bench: Bench, id: string, header: SessionDouble['header']): AgentDouble {
  const session: SessionDouble = { header, append: () => {} }
  bench.live.set(id, session)
  return { id, session }
}

/** The event half of `select`; the append half is modelled by the `select` double in `bench()`. */
function commitPick(bench: Bench, sessionId: string, agentPreset: string): void {
  bench.ctx.emit('agent-preset/selected', sessionId as never, agentPreset)
}

function bench(options: {
  select?: (agent: AgentDouble, agentPreset: string) => Promise<string>
  resolveByPath?: (path: string) => Promise<{ id: string } | undefined>
  putFails?: boolean
  create?: (request?: SessionCreateRequestLike) => Promise<unknown>
} = {}): Bench {
  const tables = new Map<string, Map<string, unknown>>()
  const unit = {
    loadAll: async () => ({
      tables: Object.fromEntries([...tables].map(([table, records]) => [table, Object.fromEntries(records)])),
      global: null as unknown,
    }),
    putRecord: async (table: string, key: string, value: unknown) => {
      if (options.putFails === true) throw new Error('medium unavailable')
      const records = tables.get(table) ?? new Map<string, unknown>()
      tables.set(table, records)
      records.set(key, value)
    },
    deleteRecord: async (table: string, key: string) => { tables.get(table)?.delete(key) },
    setGlobal: async () => {},
    close: async () => {},
  }

  const ctx = new Context()
  ctx.provide('storage', { backend: { get: () => ({ kv: { open: async () => unit }, close: async () => {} }) } } as never)
  const facility = new DomainFacility(ctx, { backend: 'test' })
  ctx.provide('storageDomain', facility)

  const live = new Map<string, SessionDouble>()
  ctx.provide('sessions', { get: (id: string) => live.get(id) } as never)

  const resolveByPath = vi.fn(
    options.resolveByPath ?? (async (path: string) => (path === CWD ? { id: WORKSPACE } : undefined)),
  )
  ctx.provide('workspaceRegistry', { resolveByPath } as never)

  const select = vi.fn(options.select ?? (async (agent: AgentDouble, agentPreset: string) => {
    agent.session.append('agent-preset/selected', { agentPreset })
    ctx.emit('agent-preset/selected', agent.id as never, agentPreset)
    return agentPreset
  }))
  ctx.provide('agentPresets', { select } as never)

  const factory = vi.fn<(request?: SessionCreateRequestLike) => Promise<unknown>>(
    options.create ?? (async () => undefined),
  )
  const controller: SessionControllerDouble = { create: factory }
  ctx.provide('sessionController', controller as never)

  return { ctx, facility, tables, live, resolveByPath, select, controller, originalCreate: factory, factory }
}

/** Boots through the real `inject` list, so a missing service fails here as it would in the Loader. */
async function boot(bench: Bench): Promise<{ dispose(): Promise<void> }> {
  const fiber = bench.ctx.plugin({ inject: [...inject], apply })
  await (fiber as unknown as { await(): Promise<void> }).await()
  return fiber
}

/** Seeding through the facility means every seeded case also proves the record round-trips its schema. */
async function seed(bench: Bench, agentPreset: string, workspaceId = WORKSPACE): Promise<void> {
  const domain = await bench.facility.open(workspacePresetDomainSpec)
  await domain.table(WORKSPACE_PRESET_TABLE).put(workspaceId as never, { agentPreset, updatedAt: 'seed' })
  await domain.close()
}

function create(bench: Bench, agent: AgentDouble, source: string): Promise<void> {
  return bench.ctx.serial('agent/created', { agent, source } as never)
}

/** Flush the recorder's detached write. */
const settle = (): Promise<void> => new Promise(resolve => { setTimeout(resolve, 0) })

/** The request the session factory actually received. */
function lastRequest(b: Bench): SessionCreateRequestLike | undefined {
  return b.factory.mock.calls.at(-1)?.[0]
}

/** Boots and waits for the optional `sessionController` inject to attach to the factory. */
async function bootWrappingSessions(b: Bench): Promise<{ dispose(): Promise<void> }> {
  const fiber = await boot(b)
  await vi.waitFor(() => { expect(b.controller.create).not.toBe(b.originalCreate) })
  return fiber
}

const disposers: Array<{ dispose(): Promise<void> }> = []

afterEach(async () => {
  while (disposers.length > 0) await disposers.pop()?.dispose()
})

describe('recording a manual pick', () => {
  it('binds the picking session\'s workspace id to the committed preset', async () => {
    const b = bench()
    disposers.push(await boot(b))
    sessionOf(b, 'session-1', { cwd: CWD, agentPreset: 'standard' })

    commitPick(b, 'session-1', 'code')

    await vi.waitFor(() => { expect(stored(b)?.agentPreset).toBe('code') })
    expect(b.resolveByPath).toHaveBeenCalledWith(CWD)
    expect(stored(b)?.updatedAt).toEqual(expect.any(String))
  })

  it('overwrites a previous binding with the newest pick', async () => {
    const b = bench()
    await seed(b, 'standard')
    disposers.push(await boot(b))
    sessionOf(b, 'session-1', { cwd: CWD })

    commitPick(b, 'session-1', 'code')

    await vi.waitFor(() => { expect(stored(b)?.agentPreset).toBe('code') })
  })

  it('writes nothing when a person re-picks what the workspace already remembers', async () => {
    const b = bench()
    disposers.push(await boot(b))
    sessionOf(b, 'session-1', { cwd: CWD })

    commitPick(b, 'session-1', 'code')
    await vi.waitFor(() => { expect(stored(b)?.agentPreset).toBe('code') })
    const written = stored(b)

    commitPick(b, 'session-1', 'code')
    await settle()

    // Identity, not the timestamp: a second `put` would store a fresh record
    // object, so holding the same reference is proof that none happened.
    expect(stored(b)).toBe(written)
  })

  it.each(NON_TOP_LEVEL_HEADERS)('ignores a pick made in %s', async (_label, header) => {
    const b = bench()
    disposers.push(await boot(b))
    sessionOf(b, 'session-1', header)

    commitPick(b, 'session-1', 'code')
    await settle()

    expect(stored(b)).toBeUndefined()
  })

  it('ignores a pick whose directory is no workspace', async () => {
    const b = bench()
    disposers.push(await boot(b))
    sessionOf(b, 'session-1', { cwd: ORPHAN_CWD })

    commitPick(b, 'session-1', 'code')
    await settle()

    expect(stored(b)).toBeUndefined()
  })

  it('ignores a pick for a session that is no longer live', async () => {
    const b = bench()
    disposers.push(await boot(b))

    commitPick(b, 'session-gone', 'code')
    await settle()

    expect(stored(b)).toBeUndefined()
  })

  it('contains a failing write instead of rejecting the pick', async () => {
    const b = bench({ putFails: true })
    disposers.push(await boot(b))
    sessionOf(b, 'session-1', { cwd: CWD })
    const warn = vi.spyOn(b.ctx.logger, 'warn').mockImplementation(() => {})

    expect(() => { commitPick(b, 'session-1', 'code') }).not.toThrow()

    await vi.waitFor(() => { expect(warn).toHaveBeenCalledTimes(1) })
    expect(stored(b)).toBeUndefined()
  })
})

describe('applying a remembered preset', () => {
  it('switches a fresh startup session to the workspace preset', async () => {
    const b = bench()
    await seed(b, 'code')
    disposers.push(await boot(b))
    const agent = sessionOf(b, 'session-2', { cwd: CWD, agentPreset: 'standard' })

    await create(b, agent, 'startup')

    expect(b.select).toHaveBeenCalledTimes(1)
    expect(b.select).toHaveBeenCalledWith(agent, 'code')
  })

  it('writes nothing when its own apply commits the preset already remembered', async () => {
    const b = bench()
    await seed(b, 'code')
    disposers.push(await boot(b))
    const agent = sessionOf(b, 'session-2', { cwd: CWD, agentPreset: 'standard' })

    await create(b, agent, 'startup')
    await settle()

    // The apply echoes a selection event carrying the preset already stored;
    // the seeded record must survive it untouched.
    expect(stored(b)?.updatedAt).toBe('seed')
  })

  it('leaves the newest manual pick standing when one lands during its own apply', async () => {
    // Closed over by `select` below: the pick fires only after this assignment,
    // so the binding is never read before it holds the bench.
    const b: Bench = bench({
      select: async (agent, agentPreset) => {
        // The real `select` awaits its remount before appending, so the pick
        // below is committed before this apply's own event arrives.
        commitPick(b, 'session-1', 'code')
        await settle()
        agent.session.append('agent-preset/selected', { agentPreset })
        b.ctx.emit('agent-preset/selected', agent.id as never, agentPreset)
        return agentPreset
      },
    })
    await seed(b, 'standard')
    disposers.push(await boot(b))
    sessionOf(b, 'session-1', { cwd: CWD })
    // Composed with neither id, so the applier has something to switch away from.
    const agent = sessionOf(b, 'session-2', { cwd: CWD, agentPreset: 'minimal' })

    await create(b, agent, 'startup')

    // Without the in-flight marker this apply's event would arrive after 'code'
    // landed and write 'standard' back over it.
    expect(stored(b)?.agentPreset).toBe('code')
  })

  it.each(['resume', 'clear', 'compact'] as const)('leaves a %s creation on its recorded composition', async (source) => {
    const b = bench()
    await seed(b, 'code')
    disposers.push(await boot(b))
    const agent = sessionOf(b, 'session-2', { cwd: CWD, agentPreset: 'standard' })

    await create(b, agent, source)

    expect(b.select).not.toHaveBeenCalled()
  })

  it.each(NON_TOP_LEVEL_HEADERS)('leaves %s on the composition its parent handed it', async (_label, header) => {
    const b = bench()
    await seed(b, 'code')
    disposers.push(await boot(b))
    const agent = sessionOf(b, 'session-2', header)

    await create(b, agent, 'startup')

    expect(b.select).not.toHaveBeenCalled()
  })

  it('does nothing for a workspace with no remembered preset', async () => {
    const b = bench()
    disposers.push(await boot(b))
    const agent = sessionOf(b, 'session-2', { cwd: CWD, agentPreset: 'standard' })

    await create(b, agent, 'startup')

    expect(b.select).not.toHaveBeenCalled()
  })

  it.each([
    ['a session outside every workspace', ORPHAN_CWD],
    ['a session with no directory at all', undefined],
  ])('does nothing for %s', async (_label, cwd) => {
    const b = bench()
    await seed(b, 'code')
    disposers.push(await boot(b))
    const agent = sessionOf(b, 'session-2', cwd === undefined ? {} : { cwd })

    await create(b, agent, 'startup')

    expect(b.select).not.toHaveBeenCalled()
  })

  it('skips the switch when the session already carries the remembered preset', async () => {
    const b = bench()
    await seed(b, 'code')
    disposers.push(await boot(b))
    const agent = sessionOf(b, 'session-2', { cwd: CWD, agentPreset: 'code' })

    await create(b, agent, 'startup')

    expect(b.select).not.toHaveBeenCalled()
  })

  it('falls back to the global default when the remembered preset no longer resolves', async () => {
    const b = bench({ select: async () => { throw new Error('Unknown agent preset: gone') } })
    await seed(b, 'gone')
    disposers.push(await boot(b))
    sessionOf(b, 'session-1', { cwd: CWD })
    const agent = sessionOf(b, 'session-2', { cwd: CWD, agentPreset: 'standard' })
    const warn = vi.spyOn(b.ctx.logger, 'warn').mockImplementation(() => {})

    // A serial listener's rejection fails agent creation, so this must resolve.
    await expect(create(b, agent, 'startup')).resolves.toBeUndefined()

    expect(b.select).toHaveBeenCalledWith(agent, 'gone')
    expect(warn).toHaveBeenCalledTimes(1)
    // The stale memory survives, so a preset that comes back is honoured again.
    expect(stored(b)?.agentPreset).toBe('gone')
  })

  it('survives a workspace lookup that rejects, in both listeners', async () => {
    const b = bench({ resolveByPath: async () => { throw new Error('ENOENT') } })
    await seed(b, 'code')
    disposers.push(await boot(b))
    const debug = vi.spyOn(b.ctx.logger, 'debug').mockImplementation(() => {})
    sessionOf(b, 'session-1', { cwd: CWD })
    const agent = sessionOf(b, 'session-2', { cwd: CWD, agentPreset: 'standard' })

    commitPick(b, 'session-1', 'code')
    await expect(create(b, agent, 'startup')).resolves.toBeUndefined()

    expect(b.select).not.toHaveBeenCalled()
    await vi.waitFor(() => { expect(debug).toHaveBeenCalledTimes(2) })
  })
})

describe('composing a session creation', () => {
  it('injects the remembered preset for the workspace id on the request', async () => {
    const b = bench()
    await seed(b, 'code')
    disposers.push(await bootWrappingSessions(b))

    await b.controller.create({ workspaceId: WORKSPACE as never, sessionId: 'session-1' })

    expect(b.factory).toHaveBeenCalledTimes(1)
    expect(lastRequest(b)).toEqual({ workspaceId: WORKSPACE, sessionId: 'session-1', agentPreset: 'code' })
    // The id was handed over, so no directory has to be resolved.
    expect(b.resolveByPath).not.toHaveBeenCalled()
  })

  it('injects the remembered preset for a workspace id given without a session', async () => {
    const b = bench()
    await seed(b, 'code')
    disposers.push(await bootWrappingSessions(b))

    await b.controller.create({ workspaceId: WORKSPACE as never })

    expect(lastRequest(b)).toEqual({ workspaceId: WORKSPACE, agentPreset: 'code' })
  })

  it('resolves the workspace from the directory on the request', async () => {
    const b = bench()
    await seed(b, 'code')
    disposers.push(await bootWrappingSessions(b))

    await b.controller.create({ cwd: CWD })

    expect(b.resolveByPath).toHaveBeenCalledWith(CWD)
    expect(lastRequest(b)).toEqual({ cwd: CWD, agentPreset: 'code' })
  })

  it('resolves the workspace from the directory of the live session being reused', async () => {
    const b = bench()
    await seed(b, 'code')
    disposers.push(await bootWrappingSessions(b))
    sessionOf(b, 'session-1', { cwd: CWD })

    await b.controller.create({ sessionId: 'session-1' })

    expect(lastRequest(b)).toEqual({ sessionId: 'session-1', agentPreset: 'code' })
  })

  it('keeps a pick made while its own injection is in flight', async () => {
    // The pick below lands while the factory is still composing this session;
    // the echo that follows carries the preset this injection chose, and it must
    // not write that choice back over the person's newer pick.
    const b: Bench = bench({
      create: async () => {
        commitPick(b, 'session-1', 'code')
        await settle()
        b.ctx.emit('agent-preset/selected', 'session-2' as never, 'standard')
        await settle()
        return undefined
      },
    })
    await seed(b, 'standard')
    disposers.push(await bootWrappingSessions(b))
    sessionOf(b, 'session-1', { cwd: CWD })
    sessionOf(b, 'session-2', { cwd: CWD, agentPreset: 'standard' })

    await b.controller.create({ workspaceId: WORKSPACE as never, sessionId: 'session-2' })

    expect(lastRequest(b)?.agentPreset).toBe('standard')
    expect(stored(b)?.agentPreset).toBe('code')
  })

  it('leaves a composition the caller asked for alone', async () => {
    const b = bench()
    await seed(b, 'code')
    disposers.push(await bootWrappingSessions(b))

    await b.controller.create({ workspaceId: WORKSPACE as never, agentPreset: 'minimal' })

    expect(lastRequest(b)).toEqual({ workspaceId: WORKSPACE, agentPreset: 'minimal' })
    expect(b.resolveByPath).not.toHaveBeenCalled()
  })

  it.each(NON_TOP_LEVEL_HEADERS)('leaves a reuse of %s alone', async (_label, header) => {
    const b = bench()
    await seed(b, 'code')
    disposers.push(await bootWrappingSessions(b))
    sessionOf(b, 'session-2', header)
    const request = { sessionId: 'session-2' }

    await b.controller.create(request)

    expect(lastRequest(b)).toEqual(request)
  })

  it.each(NON_TOP_LEVEL_HEADERS)('leaves a workspace-keyed reuse of %s alone', async (_label, header) => {
    const b = bench()
    await seed(b, 'code')
    disposers.push(await bootWrappingSessions(b))
    sessionOf(b, 'session-2', header)
    const request = { workspaceId: WORKSPACE as never, sessionId: 'session-2' }

    await b.controller.create(request)

    expect(lastRequest(b)).toEqual(request)
  })

  it('leaves a creation for a session that is no longer live alone', async () => {
    const b = bench()
    await seed(b, 'code')
    disposers.push(await bootWrappingSessions(b))
    const request = { sessionId: 'session-gone' }

    await b.controller.create(request)

    expect(lastRequest(b)).toEqual(request)
  })

  it('leaves a creation for a live session without a directory alone', async () => {
    const b = bench()
    await seed(b, 'code')
    disposers.push(await bootWrappingSessions(b))
    sessionOf(b, 'session-blank', {})
    const request = { sessionId: 'session-blank' }

    await b.controller.create(request)

    expect(lastRequest(b)).toEqual(request)
  })

  it('leaves a creation outside every workspace alone', async () => {
    const b = bench()
    await seed(b, 'code')
    disposers.push(await bootWrappingSessions(b))
    const request = { cwd: ORPHAN_CWD }

    await b.controller.create(request)

    expect(lastRequest(b)).toEqual(request)
  })

  it('leaves a creation in a workspace that remembers nothing alone', async () => {
    const b = bench()
    disposers.push(await bootWrappingSessions(b))
    sessionOf(b, 'session-1', { cwd: CWD })
    const request = { workspaceId: WORKSPACE as never, sessionId: 'session-1' }

    await b.controller.create(request)

    expect(lastRequest(b)).toEqual(request)
  })

  it('leaves a creation with no request at all alone', async () => {
    const b = bench()
    await seed(b, 'code')
    disposers.push(await bootWrappingSessions(b))

    await b.controller.create()

    expect(b.factory).toHaveBeenCalledTimes(1)
    expect(lastRequest(b)?.agentPreset).toBeUndefined()
  })

  it.each([
    ['unknown', 'agent-preset/not-found'],
    ['invalid', 'agent-preset/invalid'],
  ])('recreates without the preset when the remembered one is %s', async (_label, code) => {
    const b: Bench = bench({
      create: async () => {
        // Only the composed attempt fails; the retry is expected to succeed.
        if (b.factory.mock.calls.length === 1) {
          throw Object.assign(new Error('Unknown agent preset: gone'), { code })
        }
        return { created: true }
      },
    })
    await seed(b, 'gone')
    disposers.push(await bootWrappingSessions(b))
    sessionOf(b, 'session-1', { cwd: CWD })
    const warn = vi.spyOn(b.ctx.logger, 'warn').mockImplementation(() => {})
    const request = { workspaceId: WORKSPACE as never, sessionId: 'session-1' }

    await expect(b.controller.create(request)).resolves.toEqual({ created: true })

    expect(b.factory).toHaveBeenCalledTimes(2)
    expect(lastRequest(b)).toEqual(request)
    expect(warn).toHaveBeenCalledTimes(1)
    // The stale memory survives, so a preset that comes back is honoured again.
    expect(stored(b)?.agentPreset).toBe('gone')
    expect(stored(b)?.updatedAt).toBe('seed')
  })

  it('propagates a creation failure that is not about the preset', async () => {
    const b = bench({ create: async () => { throw new Error('workspace/not-found') } })
    await seed(b, 'code')
    disposers.push(await bootWrappingSessions(b))
    sessionOf(b, 'session-1', { cwd: CWD })
    const warn = vi.spyOn(b.ctx.logger, 'warn').mockImplementation(() => {})

    await expect(b.controller.create({ workspaceId: WORKSPACE as never, sessionId: 'session-1' }))
      .rejects.toThrow('workspace/not-found')

    expect(b.factory).toHaveBeenCalledTimes(1)
    expect(warn).not.toHaveBeenCalled()
  })

  it('restores the factory when the plugin unloads', async () => {
    const b = bench()
    await seed(b, 'code')
    const fiber = await bootWrappingSessions(b)
    expect(b.controller.create).not.toBe(b.originalCreate)

    await fiber.dispose()

    expect(b.controller.create).toBe(b.originalCreate)
    const request = { workspaceId: WORKSPACE as never }
    await b.controller.create(request)
    expect(b.factory).toHaveBeenCalledTimes(1)
    expect(lastRequest(b)).toEqual(request)
  })
})

describe('lifecycle', () => {
  it('closes its domain when the plugin unloads, freeing the name', async () => {
    const b = bench()
    const fiber = await boot(b)
    expect(b.facility.get(WORKSPACE_PRESET_DOMAIN)).toBeDefined()

    await fiber.dispose()

    expect(b.facility.get(WORKSPACE_PRESET_DOMAIN)).toBeUndefined()
    await expect(b.facility.open(workspacePresetDomainSpec)).resolves.toBeDefined()
  })
})
