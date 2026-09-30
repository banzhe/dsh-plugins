// @vitest-environment jsdom
/**
 * The `shell.overlay` entry, mounted the way the shell mounts one: the component
 * `SlotsDouble` recorded is rendered over the business face the plugin's `inject`
 * factory returned, and the content is driven through the REAL list/status
 * sources, so what is pinned is the whole store → hook → component wiring.
 */
import { Context, type Fiber } from '@deepseek-ai/cordis'
import type { ISessions } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { act, createElement, type ComponentType } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PANEL_ID, type AttentionInjected, type AttentionOverlayProps } from '../src/client/AttentionOverlay.tsx'
import { apply, inject } from '../src/client/index.ts'
import { zh, type AttentionKey } from '../src/client/locales.ts'
import { LocaleDouble } from './locale-double.ts'
import { sessionRow, sessionSources, type SessionRow, type SessionSources } from './session-list-double.ts'
import { SlotsDouble } from './slots-double.ts'

const ENTRY = 'session-attention.panel'

/**
 * The entry ignores these, but the composed props type requires them: ui-session
 * and ui-workspace merge `GlobalStandardProps` onto every slot key, so a fixture
 * cast must supply all four selectors or the entry's own props type rejects the
 * cast.
 */
const STANDARD_PROPS = {
  useSessions: (() => {}) as never,
  useSessionStatus: (() => {}) as never,
  useSessionRetainInfo: (() => {}) as never,
  useWorkspaces: (() => {}) as never,
}

/** Translate through the Chinese dictionary, the key-set source of truth. */
const t = ((key: AttentionKey, params?: Record<string, unknown>) => {
  const template = zh[key]
  if (params === undefined) return template
  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    name in params ? String(params[name]) : match)
}) as never

let fibers: Fiber[] = []
let roots: Root[] = []

// React only honors act() when it is told it runs in a test environment.
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

interface Harness {
  readonly host: HTMLElement
  readonly open: ReturnType<typeof vi.fn>
  /** The toggle, always mounted. */
  trigger(): HTMLButtonElement
  panel(): HTMLElement | null
  /** Section headings exactly as rendered. */
  headings(): string[]
  rowLabels(): string[]
  badge(): string | null
  click(element: HTMLElement): Promise<void>
  escape(): Promise<void>
  update(recipe: Parameters<SessionSources['update']>[0]): Promise<void>
}

/** Boot the browser half over a context providing the five injected services, then mount its entry. */
async function bench(rows: readonly SessionRow[] = []): Promise<Harness> {
  const surface = sessionSources(rows)
  const open = vi.fn()
  const ctx = new Context()
  ctx.provide('sessions', { list: surface.list } as unknown as ISessions)
  ctx.provide('uiSession', { sessionStatus: surface.status } as never)
  ctx.provide('uiWorkspace', { openSession: open } as never)
  ctx.provide('locale', new LocaleDouble() as never)
  // A cordis Service registers itself under its name in its own constructor.
  const slots = new SlotsDouble(ctx)
  const fiber = ctx.plugin({ inject: [...inject], apply })
  await fiber.await()
  fibers.push(fiber)

  const entry = slots.entry(ENTRY)
  if (entry === undefined) throw new Error('the overlay entry was not registered')
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  roots.push(root)
  await act(async () => {
    // The registration boundary is where these casts belong: the recorded
    // component IS the overlay entry and the recorded face IS its inject face.
    const component = entry.component as ComponentType<AttentionOverlayProps>
    const face = entry.injected as unknown as AttentionInjected
    root.render(createElement(component, { t, ...STANDARD_PROPS, ...face }))
  })
  const trigger = (): HTMLButtonElement => {
    const found = host.querySelector<HTMLButtonElement>('.sa-trigger')
    if (found === null) throw new Error('no toggle is mounted')
    return found
  }
  return {
    host,
    open,
    trigger,
    panel: () => host.querySelector<HTMLElement>('.sa-panel'),
    headings: () => [...host.querySelectorAll<HTMLElement>('.sa-section-title')].map(node => node.textContent ?? ''),
    rowLabels: () => [...host.querySelectorAll<HTMLElement>('.sa-row')].map(node => node.textContent ?? ''),
    badge: () => host.querySelector<HTMLElement>('.sa-badge')?.textContent ?? null,
    click: async (element: HTMLElement): Promise<void> => { await act(async () => { element.click() }) },
    escape: async (): Promise<void> => {
      await act(async () => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })) })
    },
    update: async (recipe): Promise<void> => {
      await act(async () => { surface.update(recipe) })
    },
  }
}

afterEach(async () => {
  // Unmount inside act(): tearing a root down is itself an update in a test env.
  await act(async () => {
    for (const root of roots) root.unmount()
  })
  roots = []
  const pending = fibers
  fibers = []
  for (const fiber of pending) await fiber.dispose()
  document.head.innerHTML = ''
  document.body.innerHTML = ''
})

describe('AttentionOverlay', () => {
  it('mounts only the toggle while closed, with a zero badge and the accessibility wiring', async () => {
    // An idle Session is nobody's attention row, so the badge reads zero rather
    // than vanishing: the readout itself is the proof the toggle is alive.
    const overlay = await bench([sessionRow('idle')])
    const trigger = overlay.trigger()
    expect(overlay.panel()).toBeNull()
    expect(trigger.getAttribute('aria-label')).toBe(zh['trigger.label'])
    expect(trigger.getAttribute('aria-expanded')).toBe('false')
    expect(trigger.getAttribute('aria-controls')).toBe(PANEL_ID)
    expect(overlay.badge()).toBe('0')
  })

  it('opens on the toggle and lists both sections, newest first, with the badge count', async () => {
    const overlay = await bench()
    await overlay.update((draft) => {
      draft.ids = ['older-run' as SessionId, 'newer-run' as SessionId, 'finished' as SessionId]
      draft.byId['older-run' as SessionId] = sessionRow('older-run', { running: true, updatedAt: 1 })
      draft.byId['newer-run' as SessionId] = sessionRow('newer-run', { running: true, updatedAt: 5 })
      draft.byId['finished' as SessionId] = sessionRow('finished', { completed: true, updatedAt: 3 })
    })
    await overlay.click(overlay.trigger())

    const panel = overlay.panel()
    expect(panel?.getAttribute('role')).toBe('dialog')
    expect(panel?.getAttribute('aria-label')).toBe(zh['panel.title'])
    expect(panel?.getAttribute('id')).toBe(PANEL_ID)
    expect(overlay.trigger().getAttribute('aria-expanded')).toBe('true')
    expect(overlay.headings()).toEqual([zh['section.running'], zh['section.unread']])
    expect(overlay.rowLabels()).toEqual(['newer-run', 'older-run', 'finished'])
    expect(overlay.badge()).toBe('3')
    const dots = [...overlay.host.querySelectorAll<HTMLElement>('[data-test-state-dot]')]
      .map(node => node.dataset['testStateDot'])
    expect(dots).toEqual(['ongoing', 'ongoing', 'done'])
  })

  it('renders only the section that has rows', async () => {
    const runningOnly = await bench([sessionRow('run', { running: true })])
    await runningOnly.click(runningOnly.trigger())
    expect(runningOnly.headings()).toEqual([zh['section.running']])

    const unreadOnly = await bench([sessionRow('done', { completed: true })])
    await unreadOnly.click(unreadOnly.trigger())
    expect(unreadOnly.headings()).toEqual([zh['section.unread']])
  })

  it('shows the empty state when there is nothing to attend to', async () => {
    const overlay = await bench()
    await overlay.click(overlay.trigger())
    expect(overlay.panel()?.textContent).toContain(zh['panel.empty'])
    expect(overlay.headings()).toEqual([])
    expect(overlay.badge()).toBe('0')
  })

  it('jumps to a Session and closes the panel behind it', async () => {
    const overlay = await bench([sessionRow('run', { running: true, displayTitle: 'Build the page' })])
    await overlay.click(overlay.trigger())
    const row = overlay.host.querySelector<HTMLButtonElement>('.sa-row')
    if (row === null) throw new Error('no row is mounted')
    expect(row.getAttribute('aria-label')).toBe(zh['row.open'].replace('{title}', 'Build the page'))
    await overlay.click(row)
    expect(overlay.open).toHaveBeenCalledWith('run')
    expect(overlay.panel()).toBeNull()
  })

  it('closes through the panel close button', async () => {
    const overlay = await bench([sessionRow('run', { running: true })])
    await overlay.click(overlay.trigger())
    const close = overlay.host.querySelector<HTMLButtonElement>('.sa-close')
    if (close === null) throw new Error('no close button is mounted')
    expect(close.getAttribute('aria-label')).toBe(zh['panel.close'])
    await overlay.click(close)
    expect(overlay.panel()).toBeNull()
  })

  it('closes on Escape while open, and only on Escape', async () => {
    const overlay = await bench([sessionRow('run', { running: true })])
    // Closed: the listener is not attached, so Escape is nobody's business.
    await overlay.escape()
    expect(overlay.panel()).toBeNull()

    await overlay.click(overlay.trigger())
    await act(async () => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'a' })) })
    expect(overlay.panel()).not.toBeNull()

    await overlay.escape()
    expect(overlay.panel()).toBeNull()
    // The listener left with the panel: a second Escape after teardown is inert.
    await overlay.escape()
    expect(overlay.panel()).toBeNull()
  })

  it('toggles closed again from the trigger', async () => {
    const overlay = await bench([sessionRow('run', { running: true })])
    await overlay.click(overlay.trigger())
    expect(overlay.panel()).not.toBeNull()
    await overlay.click(overlay.trigger())
    expect(overlay.panel()).toBeNull()
  })

  it('follows the sources while the panel is open', async () => {
    const overlay = await bench([sessionRow('run', { running: true, displayTitle: 'First' })])
    await overlay.click(overlay.trigger())
    expect(overlay.rowLabels()).toEqual(['First'])

    await overlay.update((draft) => {
      draft.byId['run' as SessionId] = sessionRow('run', { displayTitle: 'Second' })
      draft.ids.push('done' as SessionId)
      draft.byId['done' as SessionId] = sessionRow('done', { completed: true, updatedAt: 9 })
    })
    expect(overlay.headings()).toEqual([zh['section.unread']])
    expect(overlay.rowLabels()).toEqual(['done'])
    expect(overlay.badge()).toBe('1')
  })
})
