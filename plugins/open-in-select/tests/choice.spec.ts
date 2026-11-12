/**
 * The two decisions taken between the Host's answers and the control's render:
 * which application the left half opens, and whether a settled launch is worth
 * remembering.
 */
import { describe, expect, it } from 'vitest'
import { defaultApp, shouldRemember } from '../src/client/choice.ts'

describe('defaultApp', () => {
  it('opens the remembered application while the Host still resolves it', () => {
    expect(defaultApp(['vscode', 'cursor'], 'cursor')).toBe('cursor')
  })

  it('opens the first answered application when nothing is remembered', () => {
    expect(defaultApp(['vscode', 'cursor'], '')).toBe('vscode')
  })

  it('opens the first answered application when the remembered one is gone', () => {
    expect(defaultApp(['vscode', 'cursor'], 'zed')).toBe('vscode')
  })

  it('opens nothing while the Host has not answered', () => {
    expect(defaultApp([], 'cursor')).toBeUndefined()
  })
})

describe('shouldRemember', () => {
  it('remembers a pick the Host opened', () => {
    expect(shouldRemember({ kind: 'opened' }, true)).toBe(true)
  })

  it('keeps the current default when the left half opened', () => {
    expect(shouldRemember({ kind: 'opened' }, false)).toBe(false)
  })

  it('remembers nothing that did not open', () => {
    expect(shouldRemember({ kind: 'refused', status: 404 }, true)).toBe(false)
    expect(shouldRemember({ kind: 'unreachable' }, true)).toBe(false)
  })
})
