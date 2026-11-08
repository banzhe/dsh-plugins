import { describe, expect, it } from 'vitest'
import type { PresetDefinition } from '@deepseek-ai/dsh-agent-preset-registry'
import { planVariants } from '../src/presets.ts'
import type { PresetDeclaration } from '../src/presets.ts'
import { VariantSync } from '../src/variants.ts'

const BASH = '@deepseek-ai/dsh-tool-bash'
const PWSH = '@deepseek-ai/dsh-tool-pwsh'
const WINDOWS = { __jsExpr: "process.platform === 'win32'" }

const STANDARD: PresetDeclaration = {
  id: 'standard',
  name: '标准模式',
  order: 1,
  plugins: [
    { id: 'tool-bash', name: BASH, disabled: WINDOWS },
    { id: 'tool-pwsh', name: PWSH, disabled: { __jsExpr: "process.platform !== 'win32'" } },
  ],
}

const DELEGATE: PresetDeclaration = {
  id: 'delegate-only',
  name: '委派模式',
  order: 10,
  plugins: [
    { id: 'persona', name: '@deepseek-ai/dsh-persona' },
    { id: 'tool-subagent-coder', name: '@deepseek-ai/dsh-tool-subagent', config: { toolName: 'coder', agentPreset: 'subagent-coder' } },
  ],
}

const CODER: PresetDeclaration = {
  id: 'subagent-coder',
  name: 'coder',
  plugins: [{ id: 'tool-bash', name: BASH, disabled: WINDOWS }],
}

const DECLARATIONS = new Map<string, PresetDeclaration>([
  ['standard', STANDARD],
  ['delegate-only', DELEGATE],
  ['subagent-coder', CODER],
])

/** A registry that records what it was given and when it was told to stop. */
function fakeRegistry(): {
  register: (definition: PresetDefinition) => Promise<() => Promise<void>>
  readonly ids: string[]
  readonly disposed: string[]
  failNext: (id: string) => void
} {
  const ids: string[] = []
  const disposed: string[] = []
  const failing = new Set<string>()
  return {
    ids,
    disposed,
    failNext: (id: string) => { failing.add(id) },
    register: async (definition: PresetDefinition) => {
      if (failing.has(definition.id)) throw new Error('refused')
      ids.push(definition.id)
      return async () => { ids.splice(ids.indexOf(definition.id), 1); disposed.push(definition.id) }
    },
  }
}

function sync(registry: ReturnType<typeof fakeRegistry>, warnings: string[] = []): VariantSync {
  return new VariantSync({
    registry,
    logger: { warn: (message: string) => { warnings.push(message) } },
    declarations: () => DECLARATIONS,
    orderOffset: 1,
  })
}

describe('VariantSync', () => {
  it('derives nothing until a source is asked for', async () => {
    const registry = fakeRegistry()
    const set = sync(registry)
    await set.sync([])
    expect(registry.ids).toEqual([])
    expect(set.ids()).toEqual([])
  })

  it('registers a checked source together with the subagent variants it routes to', async () => {
    const registry = fakeRegistry()
    const set = sync(registry)
    await set.sync(['delegate-only'])
    expect(registry.ids).toEqual(['subagent-coder-devcontainer', 'delegate-only-devcontainer'])
    expect(set.ids()).toEqual(registry.ids)
  })

  it('applies only the difference when the list changes', async () => {
    const registry = fakeRegistry()
    const set = sync(registry)
    await set.sync(['standard'])
    await set.sync(['standard', 'delegate-only'])
    expect(registry.ids).toEqual([
      'standard-devcontainer',
      'subagent-coder-devcontainer',
      'delegate-only-devcontainer',
    ])
    expect(registry.disposed).toEqual([])
    await set.sync(['delegate-only'])
    expect(registry.disposed).toEqual(['standard-devcontainer'])
    expect(set.ids()).toEqual(['subagent-coder-devcontainer', 'delegate-only-devcontainer'])
  })

  it('disposes everything when the list empties, dependants first', async () => {
    const registry = fakeRegistry()
    const set = sync(registry)
    await set.sync(['delegate-only'])
    await set.sync([])
    expect(registry.disposed).toEqual(['delegate-only-devcontainer', 'subagent-coder-devcontainer'])
    expect(registry.ids).toEqual([])
  })

  it('is idempotent for an unchanged list', async () => {
    const registry = fakeRegistry()
    const set = sync(registry)
    await set.sync(['standard'])
    const before = [...registry.ids]
    await set.sync(['standard'])
    expect(registry.ids).toEqual(before)
    expect(registry.disposed).toEqual([])
  })

  it('serializes overlapping syncs so the last list wins', async () => {
    const registry = fakeRegistry()
    const set = sync(registry)
    const first = set.sync(['standard'])
    const second = set.sync(['delegate-only'])
    await Promise.all([first, second])
    expect(set.ids()).toEqual(['subagent-coder-devcontainer', 'delegate-only-devcontainer'])
  })

  it('drops one refused variant and still applies the rest', async () => {
    const registry = fakeRegistry()
    registry.failNext('subagent-coder-devcontainer')
    const warnings: string[] = []
    const set = sync(registry, warnings)
    await set.sync(['delegate-only'])
    expect(set.ids()).toEqual(['delegate-only-devcontainer'])
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('subagent-coder-devcontainer')
  })

  it('skips sources the composition does not declare', async () => {
    const registry = fakeRegistry()
    const set = sync(registry)
    await set.sync(['nope'])
    expect(registry.ids).toEqual([])
  })

  it('stops for good once the row unloads', async () => {
    const registry = fakeRegistry()
    const set = sync(registry)
    await set.sync(['standard'])
    await set.stop()
    expect(registry.ids).toEqual([])
    await set.sync(['delegate-only'])
    expect(registry.ids).toEqual([])
  })

  it('matches the planner it delegates to', async () => {
    const registry = fakeRegistry()
    const set = sync(registry)
    await set.sync(['standard', 'delegate-only'])
    const planned = planVariants({
      declarations: DECLARATIONS,
      sources: ['standard', 'delegate-only'],
      orderOffset: 1,
    })
    expect(set.ids()).toEqual(planned.map(variant => variant.id))
  })

  it('registers both tracks and keeps them independent', async () => {
    const registry = fakeRegistry()
    const set = sync(registry)
    await set.sync(['standard'], ['delegate-only'])
    expect(registry.ids).toEqual([
      'standard-devcontainer',
      'subagent-coder-sbx',
      'delegate-only-sbx',
    ])
    await set.sync(['standard'], [])
    expect(registry.disposed).toEqual(['delegate-only-sbx', 'subagent-coder-sbx'])
    expect(set.ids()).toEqual(['standard-devcontainer'])
  })
})
