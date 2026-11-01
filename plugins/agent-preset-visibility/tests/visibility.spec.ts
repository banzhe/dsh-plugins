import type { AgentPresetRoster } from '@deepseek-ai/dsh-agent-preset-registry/types'
import { describe, expect, it } from 'vitest'
import { hiddenIds, nextHidden, visibleRoster } from '../src/client/visibility.ts'

const ROSTER: AgentPresetRoster = {
  presets: [
    { id: 'standard', isDefault: true },
    { id: 'minimal', isDefault: false },
    { id: 'subagent-coder', isDefault: false, name: 'Coder' },
    { id: 'delegate-only', isDefault: false },
  ],
}

describe('hiddenIds', () => {
  it('reads the ids a settings section lists', () => {
    expect([...hiddenIds({ hidden: ['minimal', 'delegate-only'] })])
      .toEqual(['minimal', 'delegate-only'])
  })

  it('treats an absent, empty, or malformed list as "nothing hidden"', () => {
    expect(hiddenIds(undefined).size).toBe(0)
    expect(hiddenIds({}).size).toBe(0)
    expect(hiddenIds({ hidden: [] }).size).toBe(0)
    expect(hiddenIds({ hidden: 'minimal' }).size).toBe(0)
    expect(hiddenIds(null).size).toBe(0)
  })

  it('drops entries that cannot name a preset', () => {
    expect([...hiddenIds({ hidden: ['minimal', '', 7, null] })]).toEqual(['minimal'])
  })
})

describe('visibleRoster', () => {
  it('returns the Host answer itself while nothing is hidden', () => {
    expect(visibleRoster(ROSTER, new Set())).toBe(ROSTER)
  })

  it('returns the Host answer itself when the hidden ids name no current preset', () => {
    expect(visibleRoster(ROSTER, new Set(['gone']))).toBe(ROSTER)
  })

  it('leaves out exactly the hidden rows and keeps roster order', () => {
    expect(visibleRoster(ROSTER, new Set(['minimal'])).presets.map(row => row.id))
      .toEqual(['standard', 'subagent-coder', 'delegate-only'])
  })

  it('keeps every published field of the rows it keeps', () => {
    const kept = visibleRoster(ROSTER, new Set(['standard'])).presets
    expect(kept).toContainEqual({ id: 'subagent-coder', isDefault: false, name: 'Coder' })
  })

  it('can empty the roster without losing the payload shape', () => {
    const hidden = new Set(ROSTER.presets.map(row => row.id))
    expect(visibleRoster(ROSTER, hidden).presets).toEqual([])
  })
})

describe('nextHidden', () => {
  it('appends a newly hidden id', () => {
    expect(nextHidden([], 'minimal', true)).toEqual(['minimal'])
    expect(nextHidden(['minimal'], 'delegate-only', true)).toEqual(['minimal', 'delegate-only'])
  })

  it('removes an id that becomes visible again', () => {
    expect(nextHidden(['minimal', 'delegate-only'], 'minimal', false)).toEqual(['delegate-only'])
  })

  it('never writes a duplicate, so a repeated toggle stays idempotent', () => {
    expect(nextHidden(['minimal', 'minimal'], 'minimal', true)).toEqual(['minimal'])
    expect(nextHidden(['minimal'], 'minimal', false)).toEqual([])
  })
})
