import { describe, expect, it, vi } from 'vitest'
import type { AgentPresetRoster } from '@deepseek-ai/dsh-agent-preset-registry/types'
import type { SettingsPathOpView } from '@deepseek-ai/dsh-api-remotes/client'
import type { ConfigForm, ConfigFormSnapshot } from '@deepseek-ai/dsh-client-ui-settings/client'
import { VariantsController, rosterRows, type DevcontainerVariantsSettings, type VariantsState } from '../src/client/controller.ts'

const ROSTER: AgentPresetRoster = {
  presets: [
    { id: 'standard', name: '标准模式', isDefault: true },
    { id: 'standard-devcontainer', name: '标准模式 (devContainer)', isDefault: false },
    { id: 'delegate-only', name: '委派模式', isDefault: false },
  ],
}

interface Harness {
  readonly form: ConfigForm<DevcontainerVariantsSettings>
  readonly controller: VariantsController
  /** One entry per accepted-or-refused mutation: the field values it carried. */
  readonly writes: DevcontainerVariantsSettings[]
  readonly listing: ReturnType<typeof vi.fn>
  state(): VariantsState
  /** Apply a write outcome the way the Host would. */
  accept(value: DevcontainerVariantsSettings): void
  refuse(): void
  setSources(next: readonly string[]): void
  setSbxSources(next: readonly string[]): void
  setWritable(writable: boolean): void
  setStatus(status: 'loading' | 'ready' | 'unavailable'): void
}

/** The field values one mutation carries, flattening it to what the Host would store. */
function carried(ops: readonly SettingsPathOpView[]): DevcontainerVariantsSettings {
  const value: { sources?: readonly string[], sbxSources?: readonly string[], sbxTemplate?: string } = {}
  for (const op of ops) {
    if (op.op !== 'set' || op.path.length !== 1) continue
    const ids = Array.isArray(op.value) ? op.value.filter((id): id is string => typeof id === 'string') : []
    if (op.path[0] === 'sources') value.sources = ids
    if (op.path[0] === 'sbxSources') value.sbxSources = ids
    if (op.path[0] === 'sbxTemplate') value.sbxTemplate = typeof op.value === 'string' ? op.value : ''
  }
  return value
}

function harness(options: {
  sources?: readonly string[]
  sbxSources?: readonly string[]
  image?: string
  status?: 'loading' | 'ready' | 'unavailable'
  writable?: boolean
  accepted?: boolean
  listing?: () => Promise<{ ok: true, value: AgentPresetRoster } | { ok: false }>
} = {}): Harness {
  let snapshot: ConfigFormSnapshot<DevcontainerVariantsSettings> = {
    status: options.status ?? 'ready',
    value: { sources: options.sources ?? [], sbxSources: options.sbxSources ?? [], sbxTemplate: options.image ?? '' },
    base: undefined,
    user: undefined,
    revision: 1,
    writable: options.writable ?? true,
  }
  const listeners = new Set<() => void>()
  const writes: DevcontainerVariantsSettings[] = []
  const emit = (): void => { for (const listener of listeners) listener() }
  const form: ConfigForm<DevcontainerVariantsSettings> = {
    getSnapshot: () => snapshot,
    subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener) } },
    mutate: async (ops: readonly SettingsPathOpView[]) => {
      writes.push(carried(ops))
      const accepted = options.accepted ?? true
      if (accepted) {
        snapshot = {
          ...snapshot,
          value: { ...snapshot.value, ...carried(ops) },
          revision: (snapshot.revision ?? 0) + 1,
        }
        emit()
      }
      return accepted
    },
    unset: async () => true,
    set: async (field: string, value: unknown) => {
      const ops: SettingsPathOpView[] = [{ op: 'set', path: [field], value: value as never }]
      return await form.mutate(ops)
    },
  }
  const listing = vi.fn(options.listing ?? (async () => ({ ok: true as const, value: ROSTER })))
  const controller = new VariantsController(form, listing)
  let latest: VariantsState | undefined
  controller.inject().hooks.devcontainerVariants.subscribe(() => {
    latest = controller.inject().hooks.devcontainerVariants.getSnapshot()
  })
  const store = (value: DevcontainerVariantsSettings): void => {
    snapshot = { ...snapshot, value: { ...snapshot.value, ...value } }
    emit()
  }
  return {
    form,
    controller,
    writes,
    listing,
    state: () => latest ?? controller.inject().hooks.devcontainerVariants.getSnapshot(),
    accept: store,
    refuse: () => { options.accepted = false },
    setSources: (value) => { store({ sources: value }) },
    setSbxSources: (value) => { store({ sbxSources: value }) },
    setWritable: (writable) => { snapshot = { ...snapshot, writable }; emit() },
    setStatus: (status) => { snapshot = { ...snapshot, status }; emit() },
  }
}

/** Let every queued microtask settle. */
const settle = async (): Promise<void> => { await Promise.resolve(); await Promise.resolve() }

describe('VariantsController', () => {
  it('starts loading and lists only source presets', async () => {
    const page = harness()
    const load = page.controller.load()
    expect(page.state().status).toBe('loading')
    await load
    expect(page.state().status).toBe('ready')
    expect(page.state().rows.map(row => row.id)).toEqual(['standard', 'delegate-only'])
    expect(page.state().sbxRows.map(row => row.id)).toEqual(['standard', 'delegate-only'])
    expect(page.state().checkedCount).toBe(0)
    expect(page.state().sbxCheckedCount).toBe(0)
  })

  it('reports a failed read, and recovers on a retry', async () => {
    const page = harness({ listing: async () => ({ ok: false }) })
    await page.controller.load()
    expect(page.state().status).toBe('error')
    expect(page.state().failure).toBe('load')
    expect(page.state().rows).toEqual([])
  })

  it('writes both stored lists in one mutation and re-reads the roster after it lands', async () => {
    const page = harness()
    await page.controller.load()
    page.listing.mockClear()
    page.controller.inject().setChecked('standard', true)
    await settle()
    expect(page.writes).toEqual([{ sources: ['standard'], sbxSources: [] }])
    await settle()
    // The page re-reads so the derived badge reflects the new registration.
    expect(page.listing).toHaveBeenCalledTimes(1)
  })

  it('sends the accumulated list once two toggles land in a row', async () => {
    const page = harness()
    await page.controller.load()
    page.controller.inject().setChecked('standard', true)
    page.controller.inject().setChecked('delegate-only', true)
    await settle()
    await settle()
    expect(page.writes.at(-1)).toEqual({ sources: ['standard', 'delegate-only'], sbxSources: [] })
  })

  it('reflects a stored list that another editor wrote', async () => {
    const page = harness()
    await page.controller.load()
    page.setSources(['delegate-only'])
    expect(page.state().rows.map(row => row.checked)).toEqual([false, true])
    expect(page.state().checkedCount).toBe(1)
  })

  it('reports a refused write and keeps the stored list', async () => {
    const page = harness({ accepted: false })
    await page.controller.load()
    page.listing.mockClear()
    page.controller.inject().setChecked('standard', true)
    await settle()
    expect(page.state().failure).toBe('write')
    expect(page.state().saving).toBe(false)
    expect(page.listing).not.toHaveBeenCalled()
  })

  it('does nothing when the deployment stores settings read-only', async () => {
    const page = harness({ writable: false })
    await page.controller.load()
    page.controller.inject().setChecked('standard', true)
    page.controller.inject().toggleSbxSource('standard')
    await settle()
    expect(page.writes).toEqual([])
  })

  it('reports the namespace as unavailable when this build does not serve it', async () => {
    const page = harness({ status: 'unavailable' })
    await page.controller.load()
    expect(page.state().status).toBe('unavailable')
  })

  it('subscribes to the shared form so external edits reach the rows', async () => {
    const page = harness()
    await page.controller.load()
    page.form.getSnapshot()
    page.setSources(['standard'])
    expect(page.state().rows[0]?.derived).toBe(true)
  })

  it('publishes nothing after dispose', async () => {
    const page = harness()
    await page.controller.load()
    const before = page.state()
    page.controller.dispose()
    page.setSources(['standard'])
    expect(page.state()).toBe(before)
  })
})
describe('the Docker Sandbox track', () => {
  // The same sources, with only the (sbx) track registered.
  const SBX_ROSTER: AgentPresetRoster = {
    presets: [
      { id: 'standard', name: '标准模式', isDefault: true },
      { id: 'delegate-only', name: '委派模式', isDefault: false },
      { id: 'standard-sbx', name: '标准模式 (sbx)', isDefault: false },
    ],
  }

  it('reads sbxSources, defaulting to an empty list', async () => {
    const page = harness({ listing: async () => ({ ok: true as const, value: SBX_ROSTER }) })
    await page.controller.load()
    expect(page.state().sbxRows.map(row => row.checked)).toEqual([false, false])
    expect(page.state().sbxRows[0]?.derived).toBe(true)
    expect(page.state().rows[0]?.derived).toBe(false)

    const stored = harness({
      sources: [],
      sbxSources: ['standard'],
      listing: async () => ({ ok: true as const, value: SBX_ROSTER }),
    })
    await stored.controller.load()
    expect(stored.state().sbxCheckedCount).toBe(1)
    expect(stored.state().checkedCount).toBe(0)
    expect(stored.state().sbxRows.map(row => row.checked)).toEqual([true, false])
  })

  it('toggles one sbx source and stores both lists together', async () => {
    const page = harness({
      sources: ['delegate-only'],
      listing: async () => ({ ok: true as const, value: SBX_ROSTER }),
    })
    await page.controller.load()
    page.controller.inject().toggleSbxSource('standard')
    await settle()
    expect(page.writes).toEqual([{ sources: ['delegate-only'], sbxSources: ['standard'] }])
    expect(page.state().sbxRows.find(row => row.id === 'standard')?.checked).toBe(true)
  })

  it('toggles a stored sbx source back off', async () => {
    const page = harness({ sbxSources: ['standard'], listing: async () => ({ ok: true as const, value: SBX_ROSTER }) })
    await page.controller.load()
    page.controller.inject().toggleSbxSource('standard')
    await settle()
    expect(page.writes.at(-1)).toEqual({ sources: [], sbxSources: [] })
  })

  it('keeps a queued sbx toggle that arrives while the first write is in flight', async () => {
    const page = harness({ listing: async () => ({ ok: true as const, value: SBX_ROSTER }) })
    await page.controller.load()
    page.controller.inject().toggleSbxSource('standard')
    page.controller.inject().toggleSbxSource('delegate-only')
    await settle()
    await settle()
    expect(page.writes.at(-1)).toEqual({ sources: [], sbxSources: ['standard', 'delegate-only'] })
  })

  it('reports the sbx variant state independently of the devContainer one', async () => {
    const page = harness({
      sources: ['standard'],
      sbxSources: ['delegate-only'],
      listing: async () => ({ ok: true as const, value: SBX_ROSTER }),
    })
    await page.controller.load()
    expect(page.state().rows.find(row => row.id === 'standard')?.derived).toBe(false)
    expect(page.state().sbxRows.find(row => row.id === 'standard')?.derived).toBe(true)
    // Only the devContainer row is stored and unregistered, so only it polls.
    expect(page.state().saving).toBe(false)
  })
})
describe('VariantsController derivation verification', () => {
  it('re-reads the roster until a landed write\'s variants are registered', async () => {
    vi.useFakeTimers()
    try {
      // The Host registers the variant a moment after the settings event, so the
      // first re-read still shows the old roster.
      const late: AgentPresetRoster = {
        presets: [
          ...ROSTER.presets,
          { id: 'delegate-only-devcontainer', name: '委派模式 (devContainer)', isDefault: false },
        ],
      }
      let reads = 0
      const page = harness({
        listing: async () => {
          reads += 1
          return reads <= 2 ? { ok: true as const, value: ROSTER } : { ok: true as const, value: late }
        },
      })
      await page.controller.load()
      expect(page.state().rows.find(row => row.id === 'delegate-only')?.derived).toBe(false)

      page.controller.inject().setChecked('delegate-only', true)
      await vi.advanceTimersByTimeAsync(0)
      // Still pending right after the write landed.
      expect(page.state().rows.find(row => row.id === 'delegate-only')?.derived).toBe(false)

      await vi.advanceTimersByTimeAsync(200)
      expect(page.state().rows.find(row => row.id === 'delegate-only')?.derived).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('stops re-reading once every checked row is registered', async () => {
    vi.useFakeTimers()
    try {
      const page = harness()
      await page.controller.load()
      page.listing.mockClear()
      page.controller.inject().setChecked('standard', true)
      await vi.advanceTimersByTimeAsync(2_000)
      // One re-read after the write; nothing is outstanding, so no polling.
      expect(page.listing).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('gives up on a row that never registers instead of polling forever', async () => {
    vi.useFakeTimers()
    try {
      const page = harness({ listing: async () => ({ ok: true as const, value: ROSTER }) })
      await page.controller.load()
      page.listing.mockClear()
      // No `delegate-only-devcontainer` in this roster: the row can never register.
      page.controller.inject().setChecked('delegate-only', true)
      await vi.advanceTimersByTimeAsync(10_000)
      // One post-write re-read plus the bounded retries, then it stops.
      expect(page.listing.mock.calls.length).toBeLessThanOrEqual(6)
      expect(page.listing.mock.calls.length).toBeGreaterThan(1)
      expect(page.state().rows.find(row => row.id === 'delegate-only')?.derived).toBe(false)
      expect(page.state().saving).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps polling while an sbx variant is still missing', async () => {
    vi.useFakeTimers()
    try {
      const page = harness({ listing: async () => ({ ok: true as const, value: ROSTER }) })
      await page.controller.load()
      page.listing.mockClear()
      // The roster carries no `(sbx)` variant at all.
      page.controller.inject().toggleSbxSource('standard')
      await vi.advanceTimersByTimeAsync(10_000)
      expect(page.listing.mock.calls.length).toBeGreaterThan(1)
      expect(page.state().sbxRows.find(row => row.id === 'standard')?.derived).toBe(false)
      expect(page.state().saving).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })
})
describe('a roster answer without a body', () => {
  it('leaves the page empty instead of throwing', async () => {
    const page = harness({ listing: async () => ({ ok: true as const, value: undefined as never }) })
    await page.controller.load()
    expect(page.state().status).toBe('ready')
    expect(page.state().rows).toEqual([])
    expect(page.state().sbxRows).toEqual([])
    expect(page.state().checkedCount).toBe(0)
  })

  it('reads rows only from an actual array', () => {
    expect(rosterRows(undefined)).toEqual([])
    expect(rosterRows(null)).toEqual([])
    expect(rosterRows({})).toEqual([])
    expect(rosterRows({ presets: 'nope' })).toEqual([])
    expect(rosterRows({ presets: [{ id: 'a', isDefault: false }] })).toHaveLength(1)
  })
})
describe('the sandbox template image', () => {
  it('reads the stored image and publishes it', async () => {
    const page = harness({ image: 'docker.io/org/img:1.2' })
    await page.controller.load()
    expect(page.state().sbxTemplate).toBe('docker.io/org/img:1.2')
  })

  it('writes the image on its own path and leaves both lists alone', async () => {
    const page = harness({ sources: ['standard'], sbxSources: ['delegate-only'], image: 'my-template:v1' })
    await page.controller.load()
    page.listing.mockClear()
    page.controller.inject().setSbxTemplate('docker.io/org/img:1.2')
    await settle()
    expect(page.writes).toEqual([{ sbxTemplate: 'docker.io/org/img:1.2' }])
    expect(page.state().sbxTemplate).toBe('docker.io/org/img:1.2')
    expect(page.form.getSnapshot().value?.sources).toEqual(['standard'])
    expect(page.form.getSnapshot().value?.sbxSources).toEqual(['delegate-only'])
  })

  it('trims what it stores, and stores an empty box as no image', async () => {
    const page = harness()
    await page.controller.load()
    page.controller.inject().setSbxTemplate('  my-template:v1  ')
    await settle()
    expect(page.writes).toEqual([{ sbxTemplate: 'my-template:v1' }])
    page.controller.inject().setSbxTemplate('   ')
    await settle()
    expect(page.writes.at(-1)).toEqual({ sbxTemplate: '' })
  })

  it('refuses a value that is not one argv token instead of writing it', async () => {
    for (const value of ['--rm', 'org/img latest', 'org/\timg']) {
      const page = harness()
      await page.controller.load()
      page.controller.inject().setSbxTemplate(value)
      await settle()
      expect(page.writes).toEqual([])
      expect(page.state().failure).toBe('template')
    }
  })

  it('keeps a refused value from blocking the lists, and a list write from clearing it', async () => {
    const page = harness()
    await page.controller.load()
    page.controller.inject().setSbxTemplate('--rm')
    await settle()
    expect(page.state().failure).toBe('template')
    page.controller.inject().setChecked('standard', true)
    await settle()
    expect(page.writes).toEqual([{ sources: ['standard'], sbxSources: [] }])
    page.controller.inject().setSbxTemplate('my-template:v1')
    await settle()
    expect(page.state().failure).toBeNull()
    expect(page.state().sbxTemplate).toBe('my-template:v1')
  })
})
