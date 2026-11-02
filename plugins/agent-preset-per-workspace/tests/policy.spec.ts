import { SessionId } from '@deepseek-ai/dsh-session'
import { describe, expect, it } from 'vitest'
import { isPresetResolutionError, isTopLevelSession, needsSelect, needsWrite, shouldApplyOn } from '../src/policy.ts'

describe('isPresetResolutionError', () => {
  it('recognises the code a preset registry raises for an unknown preset', () => {
    expect(isPresetResolutionError({ code: 'agent-preset/not-found' })).toBe(true)
  })

  it('recognises the code a preset registry raises for an unusable preset', () => {
    const error = Object.assign(new Error('Unknown agent preset: gone'), { code: 'agent-preset/invalid' })
    expect(isPresetResolutionError(error)).toBe(true)
  })

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['a bare string', 'agent-preset/not-found'],
    ['a number', 42],
    ['a boolean', true],
    ['an error carrying no code at all', new Error('workspace/not-found')],
    ['an error carrying an unrelated code', Object.assign(new Error('no such workspace'), { code: 'workspace/not-found' })],
    ['an error carrying a locked-preset code', Object.assign(new Error('locked'), { code: 'agent-preset/locked' })],
    ['an error whose code is not a string', Object.assign(new Error('number code'), { code: 404 })],
  ])('rejects %s', (_label, error) => {
    expect(isPresetResolutionError(error)).toBe(false)
  })
})

describe('isTopLevelSession', () => {
  it('accepts an ordinary session with no lineage and no subagent classification', () => {
    expect(isTopLevelSession({})).toBe(true)
  })

  it('rejects a delegated child by its product classification alone', () => {
    expect(isTopLevelSession({ origin: 'subagent' })).toBe(false)
  })

  it('rejects a session with seed lineage even without the subagent classification', () => {
    expect(isTopLevelSession({ parentSession: SessionId('session-parent') })).toBe(false)
  })

  it('rejects a child that carries both marks', () => {
    expect(isTopLevelSession({ origin: 'subagent', parentSession: SessionId('session-parent') })).toBe(false)
  })
})

describe('shouldApplyOn', () => {
  it('applies only to a fresh startup creation', () => {
    expect(shouldApplyOn('startup')).toBe(true)
  })

  it.each(['resume', 'clear', 'compact'] as const)('leaves a %s creation alone', (source) => {
    expect(shouldApplyOn(source)).toBe(false)
  })
})

describe('needsSelect', () => {
  it('switches a session composed with something else', () => {
    expect(needsSelect('code', 'standard')).toBe(true)
  })

  it('switches a session whose creation recorded no preset at all', () => {
    expect(needsSelect('code', undefined)).toBe(true)
  })

  it('does nothing for a workspace that remembers no preset', () => {
    expect(needsSelect(undefined, 'standard')).toBe(false)
    expect(needsSelect(undefined, undefined)).toBe(false)
  })

  it('skips a session already composed with the remembered preset', () => {
    expect(needsSelect('code', 'code')).toBe(false)
  })
})

describe('needsWrite', () => {
  it('writes when the workspace has no binding yet', () => {
    expect(needsWrite(undefined, 'code')).toBe(true)
  })

  it('writes when the remembered preset differs', () => {
    expect(needsWrite({ agentPreset: 'standard', updatedAt: 't' }, 'code')).toBe(true)
  })

  it('skips a repeat of the remembered preset', () => {
    expect(needsWrite({ agentPreset: 'code', updatedAt: 't' }, 'code')).toBe(false)
  })
})
