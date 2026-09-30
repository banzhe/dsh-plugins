/**
 * Asserted against the INSTALLED `@deepseek-ai/dsh-agent-preset-registry`, not a
 * double. Applying a preset on `agent/created` needs no client change only
 * because the chip and resume both read the `agentPreset` session projection,
 * which starts from the creation header and is advanced by the
 * `agent-preset/selected` event a `select` appends. A release that re-derived
 * it from the header alone would make every applied switch vanish from the GUI
 * and from resume; that is what this spec turns into a failure.
 */
import { agentPresetProjectionDefinition } from '@deepseek-ai/dsh-agent-preset-registry'
import { describe, expect, it } from 'vitest'

/** Named structurally, so this suite owns no official event types. */
function event(type: string, data: unknown): never {
  return { type, data, seq: 0, time: 0 } as never
}

describe('the agentPreset session projection', () => {
  it('starts from the creation header, so an unselected session shows what it was composed with', () => {
    expect(agentPresetProjectionDefinition.init({ agentPreset: 'standard' } as never)).toBe('standard')
    expect(agentPresetProjectionDefinition.init({} as never)).toBeNull()
  })

  it('advances on agent-preset/selected, which is what makes an applied switch visible', () => {
    const selected = event('agent-preset/selected', { agentPreset: 'code' })

    expect(agentPresetProjectionDefinition.apply('standard', selected)).toBe('code')
  })

  it('is unaffected by unrelated session events', () => {
    expect(agentPresetProjectionDefinition.apply('code', event('user/message', { content: [] }))).toBe('code')
  })
})
