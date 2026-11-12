// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { FOCUS_ATTRIBUTE, TURN_ATTRIBUTE, clearFocus, findTurnRows, focusTurn } from '../src/client/anchor.ts'

function row(turn: string, text: string, attributes: Record<string, string> = {}): HTMLElement {
  const element = document.createElement('div')
  element.setAttribute(TURN_ATTRIBUTE, turn)
  for (const [key, value] of Object.entries(attributes)) element.setAttribute(key, value)
  element.textContent = text
  return element
}

function mountTranscript(): HTMLElement {
  const root = document.createElement('div')
  root.append(
    row('1', 'turn one'),
    row('2', 'turn two first'),
    row('2', 'turn two last'),
    row('3', 'keyed row turn three', { 'data-chat-node-key': 'user:6', 'data-chat-anchor-key': 'assistant-step:11' }),
  )
  document.body.append(root)
  return root
}

describe('turn anchors', () => {
  afterEach(() => {
    document.body.innerHTML = ''
  })

  it('exports the turn and focus attribute names', () => {
    expect(TURN_ATTRIBUTE).toBe('data-chat-turn')
    expect(FOCUS_ATTRIBUTE).toBe('data-session-topic-map-focus')
  })

  it('finds every row of a turn in document order', () => {
    const root = mountTranscript()
    expect(findTurnRows(root, 2).map((element) => element.textContent)).toEqual(['turn two first', 'turn two last'])
  })

  it('returns no rows for a turn that is not in the transcript', () => {
    const root = mountTranscript()
    expect(findTurnRows(root, 9)).toEqual([])
  })

  it('focuses the LAST row of the turn and returns it', () => {
    const root = mountTranscript()
    const focused = focusTurn(root, 2, null)
    expect(focused?.textContent).toBe('turn two last')
    expect(focused?.hasAttribute(FOCUS_ATTRIBUTE)).toBe(true)
    const first = findTurnRows(root, 2)[0]
    expect(first?.hasAttribute(FOCUS_ATTRIBUTE)).toBe(false)
  })

  it('moves focus: clears the previous row and sets the attribute on the new turn', () => {
    const root = mountTranscript()
    const first = focusTurn(root, 1, null)
    const second = focusTurn(root, 2, first)
    expect(first?.hasAttribute(FOCUS_ATTRIBUTE)).toBe(false)
    expect(second?.hasAttribute(FOCUS_ATTRIBUTE)).toBe(true)
  })

  it('removes an outline through clearFocus, with nothing to clear being fine', () => {
    const root = mountTranscript()
    const focused = focusTurn(root, 1, null)
    clearFocus(focused)
    expect(focused?.hasAttribute(FOCUS_ATTRIBUTE)).toBe(false)
    expect(() => { clearFocus(null) }).not.toThrow()
  })

  it('clears the previous row and returns null when the turn is missing', () => {
    const root = mountTranscript()
    const first = focusTurn(root, 1, null)
    expect(focusTurn(root, 42, first)).toBeNull()
    expect(first?.hasAttribute(FOCUS_ATTRIBUTE)).toBe(false)
  })

  it('never matches by node or anchor key, whatever numbers the keys contain', () => {
    const root = mountTranscript()
    expect(focusTurn(root, 6, null)).toBeNull()
    expect(focusTurn(root, 11, null)).toBeNull()
    expect(root.querySelector('[data-chat-node-key]')?.hasAttribute(FOCUS_ATTRIBUTE)).toBe(false)
  })

  it('scrolls the focused row into the center when scrollIntoView is supported', () => {
    const root = mountTranscript()
    const target = findTurnRows(root, 1)[0]
    if (!target) throw new Error('expected a turn 1 row')
    const scroll = vi.fn()
    Object.defineProperty(target, 'scrollIntoView', { value: scroll, configurable: true })

    focusTurn(root, 1, null)
    expect(scroll).toHaveBeenCalledWith({ block: 'center', behavior: 'smooth' })
  })

  it('does not throw when scrollIntoView is unsupported', () => {
    const root = mountTranscript()
    const target = findTurnRows(root, 1)[0]
    if (!target) throw new Error('expected a turn 1 row')
    Object.defineProperty(target, 'scrollIntoView', { value: undefined, configurable: true })

    expect(() => focusTurn(root, 1, null)).not.toThrow()
    expect(target.hasAttribute(FOCUS_ATTRIBUTE)).toBe(true)
  })
})
