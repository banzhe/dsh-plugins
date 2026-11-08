import { describe, expect, it } from 'vitest'
import {
  asDeclaration,
  BASH_TOOL_MODULE,
  cloneRows,
  planVariants,
  PRESET_MODULE,
  PWSH_TOOL_MODULE,
  referencedPresets,
  rewriteAgentPresetRefs,
  rewriteShellTools,
  variantDescription,
  variantId,
} from '../src/presets.ts'
import { DEVCONTAINER_VARIANT_SUFFIX, SBX_VARIANT_SUFFIX } from '../src/ids.ts'
import type { PresetDeclaration, PresetRow } from '../src/presets.ts'

const WINDOWS_EXPRESSION = { __jsExpr: "process.platform === 'win32'" }

const DELEGATE: readonly PresetRow[] = [
  {
    id: 'persona',
    name: '@deepseek-ai/dsh-persona',
    config: { prefix: 'You are the delegate host.' },
  },
  { id: 'tool-bash', name: BASH_TOOL_MODULE, disabled: WINDOWS_EXPRESSION },
  { id: 'tool-pwsh', name: PWSH_TOOL_MODULE, disabled: { __jsExpr: "process.platform !== 'win32'" } },
  {
    id: 'delegation',
    name: 'cordis:group',
    group: true,
    config: [
      { id: 'tool-subagent-coder', name: '@deepseek-ai/dsh-tool-subagent', config: { toolName: 'coder', agentPreset: 'subagent-coder', maxDepth: 2 } },
      { id: 'tool-subagent-verifier', name: '@deepseek-ai/dsh-tool-subagent', config: { toolName: 'verifier', agentPreset: 'subagent-verifier' } },
      { id: 'tool-subagent-plain', name: '@deepseek-ai/dsh-tool-subagent', config: { toolName: 'subagent', provider: 'spawn' } },
    ],
  },
]

describe('variantId', () => {
  it('appends the suffix once', () => {
    expect(variantId('delegate-only')).toBe(`delegate-only${DEVCONTAINER_VARIANT_SUFFIX}`)
    expect(variantId(variantId('delegate-only'))).toBe(`delegate-only${DEVCONTAINER_VARIANT_SUFFIX}`)
  })
})

describe('rewriteShellTools', () => {
  it('enables bash and disables pwsh, at any nesting depth', () => {
    const rows: PresetRow[] = [
      ...DELEGATE,
      {
        id: 'readonly-tools',
        name: 'cordis:group',
        group: true,
        config: [
          { id: 'tool-bash', name: BASH_TOOL_MODULE, disabled: WINDOWS_EXPRESSION },
          { id: 'tool-pwsh', name: PWSH_TOOL_MODULE },
        ],
      },
    ]
    const rewritten = rewriteShellTools(rows)
    const flat = (list: readonly PresetRow[]): PresetRow[] =>
      list.flatMap(row => (Array.isArray(row.config) ? [row, ...flat(row.config as PresetRow[])] : [row]))
    for (const row of flat(rewritten)) {
      if (row.name === BASH_TOOL_MODULE) expect(row.disabled).toBe(false)
      if (row.name === PWSH_TOOL_MODULE) expect(row.disabled).toBe(true)
    }
  })

  it('leaves every other row untouched and never mutates the input', () => {
    const rewritten = rewriteShellTools(DELEGATE)
    expect(rewritten[0]).toEqual(DELEGATE[0])
    expect(DELEGATE[1]?.disabled).toEqual(WINDOWS_EXPRESSION)
    expect(rewritten[1]?.disabled).toBe(false)
  })
})

describe('referencedPresets', () => {
  it('collects routes through nested groups', () => {
    expect(referencedPresets(DELEGATE)).toEqual(['subagent-coder', 'subagent-verifier'])
  })

  it('returns nothing for a preset without delegation rows', () => {
    expect(referencedPresets([{ id: 'persona', name: '@deepseek-ai/dsh-persona' }])).toEqual([])
  })
})

describe('rewriteAgentPresetRefs', () => {
  it('points mapped routes at their derived preset and keeps unmapped ones', () => {
    const rewritten = rewriteAgentPresetRefs(DELEGATE, (id) => (id === 'subagent-coder' ? variantId(id) : undefined))
    const delegation = rewritten[3]!.config as PresetRow[]
    expect((delegation[0]!.config as { agentPreset: string }).agentPreset).toBe('subagent-coder-devcontainer')
    expect((delegation[1]!.config as { agentPreset: string }).agentPreset).toBe('subagent-verifier')
    expect((delegation[2]!.config as { toolName: string }).toolName).toBe('subagent')
  })

  it('does not rewrite when the map returns the same id', () => {
    const rewritten = rewriteAgentPresetRefs(DELEGATE, (id) => id)
    expect(rewritten).toEqual(DELEGATE)
  })
})

describe('cloneRows', () => {
  it('deep-clones data, including the !!js markers', () => {
    const cloned = cloneRows(DELEGATE)
    expect(cloned).toEqual(DELEGATE)
    expect(cloned[1]).not.toBe(DELEGATE[1])
    expect(cloned[1]?.disabled).not.toBe(DELEGATE[1]?.disabled)
    expect((cloned[3]!.config as PresetRow[])[0]).not.toBe((DELEGATE[3]!.config as PresetRow[])[0])
  })
})

describe('asDeclaration', () => {
  it('accepts a Loader row config that declares a preset', () => {
    expect(asDeclaration({ id: 'delegate-only', name: '委派模式', description: 'd', order: 10, plugins: DELEGATE }))
      .toEqual({ id: 'delegate-only', name: '委派模式', description: 'd', order: 10, plugins: DELEGATE })
  })

  it('omits absent display fields', () => {
    expect(asDeclaration({ id: 'minimal', plugins: [DELEGATE[0]] })).toEqual({ id: 'minimal', plugins: [DELEGATE[0]] })
  })

  it('rejects anything that is not a preset declaration', () => {
    expect(asDeclaration(undefined)).toBeUndefined()
    expect(asDeclaration('preset')).toBeUndefined()
    expect(asDeclaration({ id: '' , plugins: [] })).toBeUndefined()
    expect(asDeclaration({ id: 'empty', plugins: [] })).toBeUndefined()
    expect(asDeclaration({ id: 'no-plugins' })).toBeUndefined()
  })

  it('names the preset module row it is meant to read', () => {
    expect(PRESET_MODULE).toBe('@deepseek-ai/dsh-agent-preset')
  })
})
const STANDARD: PresetDeclaration = {
  id: 'standard',
  name: '标准模式',
  order: 1,
  description: 'works directly',
  plugins: [
    { id: 'persona', name: '@deepseek-ai/dsh-persona' },
    { id: 'tool-bash', name: BASH_TOOL_MODULE, disabled: WINDOWS_EXPRESSION },
    { id: 'tool-pwsh', name: PWSH_TOOL_MODULE, disabled: { __jsExpr: "process.platform !== 'win32'" } },
  ],
}

/** The delegate main agent: no shell tool at all, only delegation routes. */
const DELEGATE_ONLY: PresetDeclaration = {
  id: 'delegate-only',
  name: '委派模式',
  order: 10,
  plugins: [
    { id: 'persona', name: '@deepseek-ai/dsh-persona' },
    { id: 'tool-skill', name: '@deepseek-ai/dsh-tool-skill' },
    {
      id: 'delegation',
      name: 'cordis:group',
      group: true,
      config: [
        { id: 'tool-subagent-coder', name: '@deepseek-ai/dsh-tool-subagent', config: { toolName: 'coder', agentPreset: 'subagent-coder' } },
        { id: 'tool-subagent-verifier', name: '@deepseek-ai/dsh-tool-subagent', config: { toolName: 'verifier', agentPreset: 'subagent-verifier' } },
      ],
    },
  ],
}

const CODER: PresetDeclaration = {
  id: 'subagent-coder',
  name: 'coder',
  order: 20,
  plugins: [
    { id: 'persona', name: '@deepseek-ai/dsh-persona' },
    { id: 'tool-bash', name: BASH_TOOL_MODULE, disabled: WINDOWS_EXPRESSION },
    { id: 'tool-pwsh', name: PWSH_TOOL_MODULE, disabled: { __jsExpr: "process.platform !== 'win32'" } },
    { id: 'tool-subagent-workflow-runner', name: '@deepseek-ai/dsh-tool-subagent', config: { toolName: 'workflow_runner', agentPreset: 'subagent-workflow-runner' } },
  ],
}

const WORKFLOW_RUNNER: PresetDeclaration = {
  id: 'subagent-workflow-runner',
  name: 'workflow_runner',
  order: 21,
  plugins: [
    { id: 'tool-bash', name: BASH_TOOL_MODULE, disabled: WINDOWS_EXPRESSION },
    { id: 'tool-pwsh', name: PWSH_TOOL_MODULE, disabled: { __jsExpr: "process.platform !== 'win32'" } },
  ],
}

const DECLARATIONS = new Map<string, PresetDeclaration>([
  ['standard', STANDARD],
  ['delegate-only', DELEGATE_ONLY],
  ['subagent-coder', CODER],
  ['subagent-verifier', { id: 'subagent-verifier', name: 'verifier', plugins: [{ id: 'tool-bash', name: BASH_TOOL_MODULE, disabled: WINDOWS_EXPRESSION }] }],
  ['subagent-workflow-runner', WORKFLOW_RUNNER],
])

const PLAN = { declarations: DECLARATIONS, sources: ['delegate-only', 'standard'], orderOffset: 1 }

/** Every shell tool row inside one variant, at any nesting depth. */
function shellRows(plugins: readonly PresetRow[]): PresetRow[] {
  const walked = plugins.flatMap(row => (Array.isArray(row.config) ? [row, ...shellRows(row.config as PresetRow[])] : [row]))
  return walked.filter(row => row.name === BASH_TOOL_MODULE || row.name === PWSH_TOOL_MODULE)
}

describe('planVariants', () => {
  it('derives one variant per reachable source, routed variants first', () => {
    const planned = planVariants(PLAN)
    expect(planned.map(variant => variant.id)).toEqual([
      'subagent-workflow-runner-devcontainer',
      'subagent-coder-devcontainer',
      'subagent-verifier-devcontainer',
      'delegate-only-devcontainer',
      'standard-devcontainer',
    ])
  })

  it('keeps the delegate main agent shell-tool free', () => {
    const delegate = planVariants(PLAN).find(variant => variant.id === 'delegate-only-devcontainer')
    expect(delegate).toBeDefined()
    expect(shellRows(delegate?.plugins ?? [])).toEqual([])
  })

  it('gives the derived subagents bash and no PowerShell', () => {
    for (const id of ['subagent-coder-devcontainer', 'subagent-verifier-devcontainer', 'subagent-workflow-runner-devcontainer']) {
      const variant = planVariants(PLAN).find(entry => entry.id === id)
      const rows = shellRows(variant?.plugins ?? [])
      expect(rows.length).toBeGreaterThan(0)
      expect(rows.filter(row => row.name === BASH_TOOL_MODULE).every(row => row.disabled === false)).toBe(true)
      expect(rows.filter(row => row.name === PWSH_TOOL_MODULE).every(row => row.disabled === true)).toBe(true)
    }
  })

  it('flips the shell pair of a preset that mounts one', () => {
    const standard = planVariants(PLAN).find(variant => variant.id === 'standard-devcontainer')
    expect(shellRows(standard?.plugins ?? []).map(row => [row.name, row.disabled])).toEqual([
      [BASH_TOOL_MODULE, false],
      [PWSH_TOOL_MODULE, true],
    ])
  })

  it('repoints every subagent route at its derived preset', () => {
    const variants = planVariants(PLAN)
    const delegate = variants.find(variant => variant.id === 'delegate-only-devcontainer')
    const delegation = (delegate?.plugins ?? []).find(row => row.id === 'delegation')?.config as PresetRow[]
    expect(delegation.map(row => (row.config as { agentPreset: string }).agentPreset)).toEqual([
      'subagent-coder-devcontainer',
      'subagent-verifier-devcontainer',
    ])
    const coder = variants.find(variant => variant.id === 'subagent-coder-devcontainer')
    const nested = (coder?.plugins ?? []).find(row => row.id === 'tool-subagent-workflow-runner')
    expect((nested?.config ?? {}) as { agentPreset?: string }).toMatchObject({ agentPreset: 'subagent-workflow-runner-devcontainer' })
  })

  it('labels the derived preset after its source', () => {
    const delegate = planVariants(PLAN).find(variant => variant.id === 'delegate-only-devcontainer')
    expect(delegate?.name).toBe('委派模式 (devContainer)')
    expect(delegate?.order).toBe(11)
    expect(delegate?.description).toContain('Linux Dev Container')
    expect(variantDescription(DELEGATE_ONLY)).toContain('Linux Dev Container')
  })

  it('skips a source that is not registered and keeps unknown routes untouched', () => {
    const planned = planVariants({ ...PLAN, sources: ['missing-preset'] })
    expect(planned).toEqual([])
    const withUnknownRoute = planVariants({
      declarations: new Map<string, PresetDeclaration>([
        ['lonely', { id: 'lonely', plugins: [{ id: 'tool-subagent-x', name: '@deepseek-ai/dsh-tool-subagent', config: { agentPreset: 'nowhere' } }] }],
      ]),
      sources: ['lonely'],
      orderOffset: 1,
    })
    expect((withUnknownRoute[0]?.plugins[0]?.config ?? {}) as { agentPreset?: string }).toMatchObject({ agentPreset: 'nowhere' })
  })

  it('cuts the route the depth cap stops, instead of leaving the host preset in place', () => {
    const planned = planVariants({ ...PLAN, sources: ['subagent-coder'], maxDepth: 0 })
    expect(planned.map(variant => variant.id)).toEqual(['subagent-coder-devcontainer'])
    const nested = (planned[0]?.plugins ?? []).find(row => row.id === 'tool-subagent-workflow-runner')
    // The id stays visible on the row that was cut, but the row is not mounted:
    // no agent can be started from the ordinary preset behind it.
    expect(nested?.disabled).toBe(true)
    expect((nested?.config ?? {}) as { agentPreset?: string }).toMatchObject({ agentPreset: 'subagent-workflow-runner' })
    expect(planned[0]?.description).toContain('deeper than 0 nested levels are disabled')
  })

  it('keeps a capped route when that preset was derived anyway', () => {
    const planned = planVariants({ ...PLAN, sources: ['subagent-workflow-runner', 'subagent-coder'], maxDepth: 0 })
    const coder = planned.find(variant => variant.id === 'subagent-coder-devcontainer')
    const nested = (coder?.plugins ?? []).find(row => row.id === 'tool-subagent-workflow-runner')
    expect(nested?.disabled).toBeUndefined()
    expect((nested?.config ?? {}) as { agentPreset?: string })
      .toMatchObject({ agentPreset: `subagent-workflow-runner${DEVCONTAINER_VARIANT_SUFFIX}` })
  })

  it('drops the allowed choices the cap cannot derive, leaving only the ones that exist', () => {
    const rows: readonly PresetRow[] = [{
      id: 'tool-subagent',
      name: '@deepseek-ai/dsh-tool-subagent',
      config: { allowedAgentPresets: ['subagent-a', 'registered-elsewhere'] },
    }]
    const declarations = new Map<string, PresetDeclaration>([
      ['main', { id: 'main', plugins: rows }],
      ['subagent-a', { id: 'subagent-a', plugins: [{ id: 'tool-bash', name: BASH_TOOL_MODULE }] }],
    ])
    const planned = planVariants({ declarations, sources: ['main'], orderOffset: 1, maxDepth: 0 })
    const tool = planned[0]?.plugins[0]
    // A preset this composition never declares keeps its route: the plan cannot
    // register a variant for a preset it cannot read.
    expect((tool?.config ?? {}) as { allowedAgentPresets?: string[] })
      .toMatchObject({ allowedAgentPresets: ['registered-elsewhere'] })
    expect(tool?.disabled).toBeUndefined()
  })

  it('disables the subagent tool when the cap empties its allowed choices', () => {
    const rows: readonly PresetRow[] = [{
      id: 'tool-subagent',
      name: '@deepseek-ai/dsh-tool-subagent',
      config: { allowedAgentPresets: ['subagent-a', 'subagent-b'] },
    }]
    const declarations = new Map<string, PresetDeclaration>([
      ['main', { id: 'main', plugins: rows }],
      ['subagent-a', { id: 'subagent-a', plugins: [{ id: 'tool-bash', name: BASH_TOOL_MODULE }] }],
      ['subagent-b', { id: 'subagent-b', plugins: [{ id: 'tool-bash', name: BASH_TOOL_MODULE }] }],
    ])
    const planned = planVariants({ declarations, sources: ['main'], orderOffset: 1, maxDepth: 0 })
    const tool = planned[0]?.plugins[0]
    expect((tool?.config ?? {}) as { allowedAgentPresets?: string[] }).toMatchObject({ allowedAgentPresets: [] })
    expect(tool?.disabled).toBe(true)
  })

  it('routes a preset that delegates to itself at its own derived preset', () => {
    const declarations = new Map<string, PresetDeclaration>([
      ['loop', {
        id: 'loop',
        plugins: [{ id: 'tool-subagent-self', name: '@deepseek-ai/dsh-tool-subagent', config: { agentPreset: 'loop' } }],
      }],
    ])
    const planned = planVariants({ declarations, sources: ['loop'], orderOffset: 1 })
    expect(planned).toHaveLength(1)
    expect((planned[0]?.plugins[0]?.config ?? {}) as { agentPreset?: string })
      .toMatchObject({ agentPreset: `loop${DEVCONTAINER_VARIANT_SUFFIX}` })
  })

  it('terminates on a cyclic route graph with no host preset left on a route', () => {
    const declarations = new Map<string, PresetDeclaration>([
      ['a', { id: 'a', plugins: [{ id: 'to-b', name: '@deepseek-ai/dsh-tool-subagent', config: { agentPreset: 'b' } }] }],
      ['b', { id: 'b', plugins: [{ id: 'to-a', name: '@deepseek-ai/dsh-tool-subagent', config: { agentPreset: 'a' } }] }],
    ])
    const planned = planVariants({ declarations, sources: ['a'], orderOffset: 1 })
    expect(planned.length).toBeGreaterThan(0)
    for (const variant of planned) {
      const row = variant.plugins[0]
      const route = (row?.config ?? {}) as { agentPreset?: string }
      if (row?.disabled === true) continue
      expect(route.agentPreset).toContain(DEVCONTAINER_VARIANT_SUFFIX)
    }
  })

  it('never mutates the declarations it reads', () => {
    const before = JSON.stringify([...DECLARATIONS.values()])
    planVariants(PLAN)
    expect(JSON.stringify([...DECLARATIONS.values()])).toBe(before)
  })
})
describe('the persistent and terminal shell rows', () => {
  /** The four shell rows the shipped `minimal` preset mounts, as it declares them. */
  const MINIMAL: readonly PresetRow[] = [
    { id: 'pty', name: '@deepseek-ai/dsh-terminal' },
    { id: 'terminal-bash', name: '@deepseek-ai/dsh-terminal-bash', disabled: WINDOWS_EXPRESSION, config: { timeoutMs: 300000 } },
    { id: 'tool-bash-persistent', name: '@deepseek-ai/dsh-tool-bash-persistent', disabled: WINDOWS_EXPRESSION },
    { id: 'terminal-pwsh', name: '@deepseek-ai/dsh-terminal-bash', disabled: { __jsExpr: "process.platform !== 'win32'" }, config: { shellDialect: 'pwsh', timeoutMs: 300000 } },
    { id: 'tool-pwsh-persistent', name: '@deepseek-ai/dsh-tool-pwsh-persistent', disabled: { __jsExpr: "process.platform !== 'win32'" } },
  ]

  it('keeps exactly one bash tool and disables every other shell row', () => {
    const rows = rewriteShellTools(MINIMAL)
    expect(rows.map(row => [row.id, row.name, row.disabled])).toEqual([
      ['pty', '@deepseek-ai/dsh-terminal', undefined],
      // The row is reused for the plain tool: a PTY or persistent shell owns a
      // HOST process, and the container cannot have one.
      ['terminal-bash', '@deepseek-ai/dsh-tool-bash', false],
      ['tool-bash-persistent', '@deepseek-ai/dsh-tool-bash-persistent', true],
      ['terminal-pwsh', '@deepseek-ai/dsh-terminal-bash', true],
      ['tool-pwsh-persistent', '@deepseek-ai/dsh-tool-pwsh-persistent', true],
    ])
    expect(rows[1]?.config).toBeUndefined()
  })

  it('does not add a second bash row when the preset already mounts one', () => {
    const rows: PresetRow[] = [
      { id: 'tool-bash', name: '@deepseek-ai/dsh-tool-bash', disabled: { __jsExpr: "process.platform === 'win32'" } },
      { id: 'tool-bash-persistent', name: '@deepseek-ai/dsh-tool-bash-persistent' },
    ]
    expect(rewriteShellTools(rows).map(row => [row.id, row.disabled])).toEqual([
      ['tool-bash', false],
      ['tool-bash-persistent', true],
    ])
  })

  it('leaves every untouched row exactly as it was', () => {
    const rows: PresetRow[] = [{ id: 'persona', name: '@deepseek-ai/dsh-persona', disabled: WINDOWS_EXPRESSION }]
    expect(rewriteShellTools(rows)).toEqual(rows)
    expect(rewriteShellTools(rows)).not.toBe(rows)
  })
})

describe('allowedAgentPresets', () => {
  const SUBAGENTS: readonly PresetRow[] = [
    {
      id: 'tool-subagent',
      name: '@deepseek-ai/dsh-tool-subagent',
      config: { allowedAgentPresets: ['subagent-coder', 'subagent-verifier'] },
    },
  ]

  it('counts the presets an array of choices names', () => {
    expect(referencedPresets(SUBAGENTS)).toEqual(['subagent-coder', 'subagent-verifier'])
  })

  it('collects both the fixed preset and the allowed choices, without duplicates', () => {
    const rows: PresetRow[] = [{
      id: 'tool-subagent',
      name: '@deepseek-ai/dsh-tool-subagent',
      config: { agentPreset: 'subagent-coder', allowedAgentPresets: ['subagent-coder', 'subagent-verifier'] },
    }]
    expect(referencedPresets(rows)).toEqual(['subagent-coder', 'subagent-verifier'])
  })

  it('rewrites every allowed choice to its variant', () => {
    const rewritten = rewriteAgentPresetRefs(SUBAGENTS, id => variantId(id))
    expect(rewritten[0]?.config).toEqual({
      allowedAgentPresets: [`subagent-coder${DEVCONTAINER_VARIANT_SUFFIX}`, `subagent-verifier${DEVCONTAINER_VARIANT_SUFFIX}`],
    })
  })

  it('leaves the array alone when no route maps', () => {
    const rewritten = rewriteAgentPresetRefs(SUBAGENTS, () => undefined)
    expect(rewritten[0]?.config).toEqual(SUBAGENTS[0]?.config)
  })

  it('derives variants for every allowed choice, dependencies first', () => {
    const declarations = new Map<string, PresetDeclaration>([
      ['main', { id: 'main', plugins: SUBAGENTS }],
      ['subagent-coder', { id: 'subagent-coder', plugins: DELEGATE }],
      ['subagent-verifier', { id: 'subagent-verifier', plugins: DELEGATE }],
    ])
    const planned = planVariants({ declarations, sources: ['main'], orderOffset: 1 })
    expect(planned.map(variant => variant.id)).toEqual([
      `subagent-verifier${DEVCONTAINER_VARIANT_SUFFIX}`,
      `subagent-coder${DEVCONTAINER_VARIANT_SUFFIX}`,
      `main${DEVCONTAINER_VARIANT_SUFFIX}`,
    ])
    // One entry per preset, however many routes reach it.
    expect(new Set(planned.map(variant => variant.id)).size).toBe(planned.length)
    const config = planned[2]?.plugins[0]?.config as { allowedAgentPresets?: string[] }
    expect(config.allowedAgentPresets).toEqual([
      `subagent-coder${DEVCONTAINER_VARIANT_SUFFIX}`,
      `subagent-verifier${DEVCONTAINER_VARIANT_SUFFIX}`,
    ])
  })
})

describe('planVariants over two tracks', () => {
  const BOTH = { declarations: DECLARATIONS, sources: ['delegate-only'], sbxSources: ['delegate-only'], orderOffset: 1 }

  it('derives one tree per track, Dev Container first', () => {
    expect(planVariants(BOTH).map(variant => [variant.id, variant.kind])).toEqual([
      [`subagent-workflow-runner${DEVCONTAINER_VARIANT_SUFFIX}`, 'devcontainer'],
      [`subagent-coder${DEVCONTAINER_VARIANT_SUFFIX}`, 'devcontainer'],
      [`subagent-verifier${DEVCONTAINER_VARIANT_SUFFIX}`, 'devcontainer'],
      [`delegate-only${DEVCONTAINER_VARIANT_SUFFIX}`, 'devcontainer'],
      [`subagent-workflow-runner${SBX_VARIANT_SUFFIX}`, 'sbx'],
      [`subagent-coder${SBX_VARIANT_SUFFIX}`, 'sbx'],
      [`subagent-verifier${SBX_VARIANT_SUFFIX}`, 'sbx'],
      [`delegate-only${SBX_VARIANT_SUFFIX}`, 'sbx'],
    ])
  })

  it('routes each track only into its own variants', () => {
    const variants = planVariants(BOTH)
    const routes = (id: string): string[] => {
      const variant = variants.find(entry => entry.id === id)
      const delegation = (variant?.plugins ?? []).find(row => row.id === 'delegation')?.config as PresetRow[]
      return delegation.map(row => (row.config as { agentPreset: string }).agentPreset)
    }
    expect(routes(`delegate-only${DEVCONTAINER_VARIANT_SUFFIX}`)).toEqual([
      `subagent-coder${DEVCONTAINER_VARIANT_SUFFIX}`,
      `subagent-verifier${DEVCONTAINER_VARIANT_SUFFIX}`,
    ])
    expect(routes(`delegate-only${SBX_VARIANT_SUFFIX}`)).toEqual([
      `subagent-coder${SBX_VARIANT_SUFFIX}`,
      `subagent-verifier${SBX_VARIANT_SUFFIX}`,
    ])
  })

  it('labels and describes the sandbox track as what it is', () => {
    const variants = planVariants(BOTH)
    const sandbox = variants.find(variant => variant.id === `delegate-only${SBX_VARIANT_SUFFIX}`)
    expect(sandbox?.name).toBe('委派模式 (sbx)')
    expect(sandbox?.description).toContain('Docker Sandbox')
    expect(sandbox?.order).toBe(11)
    expect(variantDescription(DELEGATE_ONLY, 'sbx')).toContain('Docker Sandbox')
  })

  it('derives one track when only that list names the source', () => {
    expect(planVariants({ ...BOTH, sbxSources: [] }).every(variant => variant.kind === 'devcontainer')).toBe(true)
    const sandboxOnly = planVariants({ ...BOTH, sources: [] })
    expect(sandboxOnly.every(variant => variant.kind === 'sbx')).toBe(true)
    expect(sandboxOnly.map(variant => variant.id)).toContain(`delegate-only${SBX_VARIANT_SUFFIX}`)
  })

  it('keeps the shell tools flipped on both tracks', () => {
    const variants = planVariants(BOTH)
    for (const id of [`subagent-coder${SBX_VARIANT_SUFFIX}`, `subagent-coder${DEVCONTAINER_VARIANT_SUFFIX}`]) {
      const rows = shellRows(variants.find(variant => variant.id === id)?.plugins ?? [])
      expect(rows.length).toBeGreaterThan(0)
      expect(rows.filter(row => row.name === PWSH_TOOL_MODULE).every(row => row.disabled === true)).toBe(true)
    }
  })
})
