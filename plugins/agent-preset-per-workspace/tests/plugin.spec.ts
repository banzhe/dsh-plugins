/**
 * The plugin's two listeners, driven through its real `apply` over a real
 * Cordis context and the REAL domain facility, with an in-memory KV backend
 * standing in for the json medium. The three Host services the plugin reads are
 * doubles, because a real preset registry needs a Loader tree and a real
 * workspace registry needs session persistence.
 *
 * The `agentPresets` double mirrors the one behaviour this plugin depends on
 * (`packages/preset/agent-preset-registry/src/index.ts:319-334`): `select`
 * appends `agent-preset/selected` to the target session's log and the registry
 * re-emits it with `(sessionId, presetId)`. The composition a fresh creation
 * gets in its setup callback appends nothing, so it stays invisible here —
 * which is exactly the seam the recorder leans on.
 */
import { Context } from '@deepseek-ai/cordis'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WORKSPACE_PRESET_DOMAIN, WORKSPACE_PRESET_TABLE, workspacePresetDomainSpec } from '../src/domain.ts'
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

interface Bench {
  ctx: Context
  facility: DomainFacility
  /** The medium: table name → key → stored record. */
  tables: Map<string, Map<string, unknown>>
  live: Map<string, SessionDouble>
  resolveByPath: ReturnType<typeof vi.fn>
  select: ReturnType<typeof vi.fn>
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

  return { ctx, facility, tables, live, resolveByPath, select }
}

/** Boots through the real `inject` list, so a missing service fails here as it would in the Loader. */
async function boot(bench: Bench): Promise<{ dispose(): Promise<void> }> {
  const fiber = bench.ctx.plugin({ inject: [...inject], apply })
  await (fiber as unknown as { await(): Promise<void> }).await()
  return fiber as unknown as { dispose(): Promise<void> }
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
    let b!: Bench
    b = bench({
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
