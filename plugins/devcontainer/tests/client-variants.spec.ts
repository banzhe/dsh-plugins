import { describe, expect, it } from 'vitest'
import type { AgentPresetRoster } from '@deepseek-ai/dsh-agent-preset-registry/types'
import { nextSources, sbxSourcesOf, selectable, selectablePresets, sourcesOf } from '../src/client/variants.ts'

const ROSTER: AgentPresetRoster = {
  presets: [
    { id: 'standard', name: '标准模式', description: 'works directly', isDefault: true },
    { id: 'standard-devcontainer', name: '标准模式 (devContainer)', isDefault: false },
    { id: 'delegate-only', name: '委派模式', description: 'delegates', isDefault: false },
    { id: 'subagent-coder', isDefault: false },
    { id: 'delegate-only-devcontainer', name: '委派模式 (devContainer)', isDefault: false },
  ],
}

describe('sourcesOf', () => {
  it('reads the stored list and ignores anything that is not one', () => {
    expect(sourcesOf({ sources: ['a', '', 'b', 7] })).toEqual(['a', 'b'])
    expect(sourcesOf({ sources: 'a' })).toEqual([])
    expect(sourcesOf({})).toEqual([])
    expect(sourcesOf(undefined)).toEqual([])
    expect(sourcesOf(null)).toEqual([])
  })

  it('reads each track from its own field, ignoring the other one', () => {
    const section = { sources: ['a'], sbxSources: ['b', ''] }
    expect(sourcesOf(section)).toEqual(['a'])
    expect(sbxSourcesOf(section)).toEqual(['b'])
    expect(sbxSourcesOf({ sources: ['a'] })).toEqual([])
    expect(sbxSourcesOf(undefined)).toEqual([])
  })
})

describe('the derived set', () => {
  it('marks a source as derived only when its variant row is there', () => {
    const rows = selectablePresets(ROSTER, [])
    expect(rows.filter(row => row.derived).map(row => row.id)).toEqual(['standard', 'delegate-only'])
  })
})

describe('selectablePresets', () => {
  it('offers only source presets, never a variant', () => {
    const rows = selectablePresets(ROSTER, [])
    expect(rows.map(row => row.id)).toEqual(['standard', 'delegate-only', 'subagent-coder'])
  })

  it('reports the stored list and the registered state separately', () => {
    const rows = selectablePresets(ROSTER, ['standard', 'delegate-only'])
    expect(rows.map(row => [row.id, row.checked, row.derived])).toEqual([
      ['standard', true, true],
      ['delegate-only', true, true],
      ['subagent-coder', false, false],
    ])
  })

  it('keeps a checked row that failed to register', () => {
    const rows = selectablePresets({ presets: [{ id: 'standard', isDefault: true }] }, ['standard'])
    expect(rows).toEqual([{
      id: 'standard',
      name: 'standard',
      description: '',
      checked: true,
      derived: false,
    }])
  })

  it('never offers a sandbox variant as a source either', () => {
    const rows = selectablePresets({
      presets: [
        { id: 'standard', name: 'standard', isDefault: false },
        { id: 'standard-sbx', name: 'standard (sbx)', isDefault: false },
      ],
    }, [])
    expect(rows.map(row => row.id)).toEqual(['standard'])
    // The page manages the Dev Container track, so a sandbox variant is neither a
    // source nor the derived state this page reports.
    expect(rows[0]?.derived).toBe(false)
  })

  it('falls back to the id for a name', () => {
    const rows = selectablePresets(ROSTER, [])
    expect(rows.find(row => row.id === 'subagent-coder')?.name).toBe('subagent-coder')
  })
})

describe('nextSources', () => {
  it('appends a new id and keeps the existing order', () => {
    expect(nextSources(['a', 'b'], 'c', true)).toEqual(['a', 'b', 'c'])
  })

  it('moves nothing when the id is already stored', () => {
    expect(nextSources(['a', 'b'], 'a', true)).toEqual(['a', 'b'])
  })

  it('drops an unchecked id', () => {
    expect(nextSources(['a', 'b', 'c'], 'b', false)).toEqual(['a', 'c'])
    expect(nextSources(['a'], 'a', false)).toEqual([])
  })
})
describe('a variant the registry registered but could not mount', () => {
  const BROKEN_VARIANT: AgentPresetRoster = {
    presets: [
      { id: 'minimal', name: '极简', isDefault: false },
      {
        id: 'minimal-devcontainer',
        name: '极简 (devContainer)',
        isDefault: false,
        broken: 'terminal-pwsh (@deepseek-ai/dsh-terminal-bash): a PTY backend named "shell" is already registered',
      },
    ],
  }

  it('reports the variant diagnostic instead of a usable state', () => {
    const [row] = selectablePresets(BROKEN_VARIANT, ['minimal'])
    expect(row?.derived).toBe(true)
    expect(row?.variantBroken).toContain('a PTY backend named "shell" is already registered')
  })

  it('leaves a healthy variant without a diagnostic', () => {
    const [row] = selectablePresets(ROSTER, ['standard'])
    expect(row?.variantBroken).toBeUndefined()
  })
})

describe('a preset the registry could not mount', () => {
  const BROKEN: AgentPresetRoster = {
    presets: [
      { id: 'standard', name: '标准模式', isDefault: true },
      { id: 'broken-one', name: '坏掉的', isDefault: false, broken: 'row tool-bash is unavailable' },
    ],
  }

  it('carries the diagnostic to the row', () => {
    const rows = selectablePresets(BROKEN, [])
    expect(rows.map(row => [row.id, row.broken])).toEqual([
      ['standard', undefined],
      ['broken-one', 'row tool-bash is unavailable'],
    ])
  })

  it('refuses to offer it, but still lets a stored one be cleared', () => {
    const [healthy, broken] = selectablePresets(BROKEN, ['broken-one'])
    expect(selectable(healthy!)).toBe(true)
    expect(selectable(broken!)).toBe(true)
    expect(selectable({ ...broken!, checked: false })).toBe(false)
  })
})
describe('the Docker Sandbox track', () => {
  const ROSTER_WITH_SBX: AgentPresetRoster = {
    presets: [
      { id: 'standard', name: '标准模式', isDefault: true },
      { id: 'standard-devcontainer', name: '标准模式 (devContainer)', isDefault: false },
      { id: 'standard-sbx', name: '标准模式 (sbx)', isDefault: false },
      { id: 'delegate-only', name: '委派模式', isDefault: false },
    ],
  }

  it('reports the sbx variant, not the devContainer one', () => {
    const rows = selectablePresets(ROSTER_WITH_SBX, [], 'sbx')
    expect(rows.map(row => [row.id, row.derived])).toEqual([
      ['standard', true],
      ['delegate-only', false],
    ])
  })

  it('offers the same sources on both tracks', () => {
    expect(selectablePresets(ROSTER_WITH_SBX, [], 'sbx').map(row => row.id))
      .toEqual(selectablePresets(ROSTER_WITH_SBX, [], 'devcontainer').map(row => row.id))
  })

  it('reads the sbx stored list, not the devContainer one', () => {
    expect(selectablePresets(ROSTER_WITH_SBX, ['delegate-only'], 'sbx').map(row => [row.id, row.checked]))
      .toEqual([['standard', false], ['delegate-only', true]])
  })

  it('carries an sbx variant diagnostic to the row', () => {
    const [row] = selectablePresets({
      presets: [
        { id: 'minimal', name: '极简', isDefault: false },
        { id: 'minimal-sbx', name: '极简 (sbx)', isDefault: false, broken: 'sandbox driver unavailable' },
      ],
    }, ['minimal'], 'sbx')
    expect(row?.derived).toBe(true)
    expect(row?.variantBroken).toBe('sandbox driver unavailable')
  })
})

describe('a roster without rows', () => {
  it('treats an absent preset list as an empty roster', () => {
    expect(selectablePresets({} as AgentPresetRoster, ['a'])).toEqual([])
    expect(selectablePresets(undefined as unknown as AgentPresetRoster, [])).toEqual([])
  })
})
