// @vitest-environment jsdom
/**
 * The browser half over a real Cordis context: the hover binding, the A
 * keypress, the archive dispatch, and the disposal path.
 *
 * The gesture is driven through real DOM events on fixture rows whose fiber
 * chains carry session ids, so a spec proves what the browser proves: hovering a
 * row and pressing A archives THAT session, and the portaled hover card keeps
 * the same binding.
 */
import { Context } from '@deepseek-ai/cordis'
import type { ISessions } from '@deepseek-ai/dsh-api-session-controller/client'
import type { IWorkspaces } from '@deepseek-ai/dsh-api-workspace-controller/client'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { apply, inject } from '../src/client/index.ts'
import { hoverCard, sessionRow } from './fiber-fixture.ts'
import { sessionListOf, sessionSummary } from './session-list-double.ts'

/** Boot the browser half over a context providing the two injected services. */
async function bench(options: {
  sessions?: readonly ReturnType<typeof sessionSummary>[]
  archived?: readonly string[]
  reject?: boolean
} = {}) {
  const archiveSession = options.reject === true
    ? vi.fn(async () => { throw new Error('nope') })
    : vi.fn(async () => {})
  const current = options.sessions ?? [sessionSummary({ id: 'session-1' }), sessionSummary({ id: 'session-2' })]
  const sessions = { list: { getSnapshot: () => sessionListOf(current) } } as unknown as ISessions
  const workspaces = {
    archiveSession,
    list: { getSnapshot: () => ({ archivedSessionIds: (options.archived ?? []).map(SessionId) }) },
  } as unknown as IWorkspaces

  const ctx = new Context()
  ctx.provide('sessions', sessions)
  ctx.provide('workspaces', workspaces)
  const fiber = ctx.plugin({ inject: [...inject], apply })
  await fiber.await()
  // Document listeners are global: a fiber left running would keep handling
  // keydowns in later specs (and its stopImmediatePropagation would mask the
  // spec's own fiber), so every bench is torn down after its test.
  booted.push(fiber)
  return { ctx, fiber, archiveSession }
}

/** Hover a node the way the browser does: pointerover with a target. */
function hover(target: Element): void {
  target.dispatchEvent(new PointerEvent('pointerover', { bubbles: true }))
}

/** Press the physical A key on the document. */
function pressA(target: EventTarget = document): boolean {
  const event = new KeyboardEvent('keydown', { key: 'a', code: 'KeyA', bubbles: true, cancelable: true })
  target.dispatchEvent(event)
  return event.defaultPrevented
}

/** Every fiber this file booted, torn down after each spec. */
const booted: { dispose: () => Promise<void> }[] = []

afterEach(async () => {
  for (const fiber of booted.splice(0)) await fiber.dispose()
  document.body.innerHTML = ''
})

describe('hover-archive browser half', () => {
  it('declares the services it binds', () => {
    expect(inject).toEqual(['sessions', 'workspaces'])
  })

  it('archives the hovered row session on A', async () => {
    const row = sessionRow({ id: 'session-2' })
    document.body.append(row)
    const { archiveSession } = await bench()
    hover(row)
    expect(pressA()).toBe(true)
    expect(archiveSession).toHaveBeenCalledWith('session-2')
  })

  it('keeps the binding when the pointer moves onto the portaled hover card', async () => {
    const row = sessionRow({ id: 'session-1' })
    const card = hoverCard('session-1')
    document.body.append(row, card)
    const { archiveSession } = await bench()
    hover(row)
    // The card is not a DOM descendant of the row; only the shared id links them.
    hover(card)
    expect(pressA()).toBe(true)
    expect(archiveSession).toHaveBeenCalledWith('session-1')
  })

  it('re-binds the row from the card id when the hover starts on the card', async () => {
    const row = sessionRow({ id: 'session-1' })
    const card = hoverCard('session-1')
    document.body.append(row, card)
    const { archiveSession } = await bench()
    hover(card)
    expect(pressA()).toBe(true)
    expect(archiveSession).toHaveBeenCalledWith('session-1')
  })

  it('ignores a card whose session row is no longer rendered', async () => {
    const card = hoverCard('session-gone')
    document.body.append(card)
    const { archiveSession } = await bench()
    hover(card)
    expect(pressA()).toBe(false)
    expect(archiveSession).not.toHaveBeenCalled()
  })

  it('clears the binding when the pointer leaves the row', async () => {
    const row = sessionRow({ id: 'session-1' })
    document.body.append(row)
    const { archiveSession } = await bench()
    hover(row)
    row.dispatchEvent(new PointerEvent('pointerout', { bubbles: true, relatedTarget: document.body }))
    expect(pressA()).toBe(false)
    expect(archiveSession).not.toHaveBeenCalled()
  })

  it('keeps the binding while the pointer stays inside the row', async () => {
    const row = sessionRow({ id: 'session-1' })
    document.body.append(row)
    const { archiveSession } = await bench()
    hover(row)
    const inner = row.querySelector('span')!
    hover(inner)
    // pointerout to a node still inside the row must not clear the binding.
    row.dispatchEvent(new PointerEvent('pointerout', { bubbles: true, relatedTarget: inner }))
    expect(pressA()).toBe(true)
    expect(archiveSession).toHaveBeenCalledWith('session-1')
  })

  it('does nothing without a hovered row', async () => {
    const { archiveSession } = await bench()
    expect(pressA()).toBe(false)
    expect(archiveSession).not.toHaveBeenCalled()
  })

  it('ignores a pointerout that arrives with nothing hovered', async () => {
    const row = sessionRow({ id: 'session-1' })
    document.body.append(row)
    const { archiveSession } = await bench()
    row.dispatchEvent(new PointerEvent('pointerout', { bubbles: true, relatedTarget: document.body }))
    expect(pressA()).toBe(false)
    expect(archiveSession).not.toHaveBeenCalled()
  })

  it('does nothing after the hovered row leaves the document', async () => {
    const row = sessionRow({ id: 'session-1' })
    document.body.append(row)
    const { archiveSession } = await bench()
    hover(row)
    row.remove()
    expect(pressA()).toBe(false)
    expect(archiveSession).not.toHaveBeenCalled()
  })

  it('refuses a blank New Session row', async () => {
    const row = sessionRow({ id: 'session-blank', blank: true })
    document.body.append(row)
    const { archiveSession } = await bench({ sessions: [sessionSummary({ id: 'session-blank', blank: true })] })
    hover(row)
    expect(pressA()).toBe(false)
    expect(archiveSession).not.toHaveBeenCalled()
  })

  it('refuses a Session the list no longer carries', async () => {
    const row = sessionRow({ id: 'session-1' })
    document.body.append(row)
    const { archiveSession } = await bench({ sessions: [sessionSummary({ id: 'session-2' })] })
    hover(row)
    expect(pressA()).toBe(false)
    expect(archiveSession).not.toHaveBeenCalled()
  })

  it('refuses a subagent-origin Session', async () => {
    const row = sessionRow({ id: 'session-child' })
    document.body.append(row)
    const { archiveSession } = await bench({ sessions: [sessionSummary({ id: 'session-child', origin: 'subagent' })] })
    hover(row)
    expect(pressA()).toBe(false)
    expect(archiveSession).not.toHaveBeenCalled()
  })

  it('refuses an already-archived Session', async () => {
    const row = sessionRow({ id: 'session-1' })
    document.body.append(row)
    const { archiveSession } = await bench({ archived: ['session-1'] })
    hover(row)
    expect(pressA()).toBe(false)
    expect(archiveSession).not.toHaveBeenCalled()
  })

  it('leaves a modified or chording key to the composer', async () => {
    const row = sessionRow({ id: 'session-1' })
    document.body.append(row)
    const { archiveSession } = await bench()
    hover(row)
    for (const init of [
      { key: 'a', code: 'KeyA', shiftKey: true },
      { key: 'a', code: 'KeyA', ctrlKey: true },
      { key: 'a', code: 'KeyA', metaKey: true },
      { key: 'a', code: 'KeyA', altKey: true },
      { key: 'a', code: 'KeyB' },
      { key: 'a', code: 'KeyA', repeat: true },
      { key: 'a', code: 'KeyA', isComposing: true },
    ]) {
      const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init })
      document.dispatchEvent(event)
      expect(event.defaultPrevented).toBe(false)
    }
    expect(archiveSession).not.toHaveBeenCalled()
  })

  it('keeps A for a focused text field', async () => {
    const input = document.createElement('input')
    document.body.append(input)
    const { archiveSession } = await bench()
    // Hover a real row first, then type into the input: the field wins.
    const row = sessionRow({ id: 'session-1' })
    document.body.append(row)
    hover(row)
    expect(pressA(input)).toBe(false)
    expect(archiveSession).not.toHaveBeenCalled()
  })

  it('logs a rejection without throwing', async () => {
    const row = sessionRow({ id: 'session-1' })
    document.body.append(row)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await bench({ reject: true })
    hover(row)
    pressA()
    await Promise.resolve()
    await Promise.resolve()
    expect(warn).toHaveBeenCalledWith('session archive rejected:', expect.any(Error))
    warn.mockRestore()
  })

  it('releases every listener with the fiber', async () => {
    const row = sessionRow({ id: 'session-1' })
    document.body.append(row)
    const { fiber, archiveSession } = await bench()
    hover(row)
    await fiber.dispose()
    expect(pressA()).toBe(false)
    expect(archiveSession).not.toHaveBeenCalled()
  })

  it('exposes an empty Host half', async () => {
    const host = await import('../src/index.ts')
    expect(host.name).toBe('hover-archive')
    expect(() => { host.apply() }).not.toThrow()
  })
})
