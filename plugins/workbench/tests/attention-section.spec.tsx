// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { AttentionSection } from '../src/client/attention/AttentionSection.tsx'
import type { AttentionModel, AttentionRow } from '../src/client/attention/model.ts'

const MESSAGES: Record<string, string> = {
  'attention.section.running': 'Running',
  'attention.section.unread': 'Unread',
  'attention.row.open': 'Open session {title}',
  'attention.row.openPinned': 'Open pinned session {title}',
  'attention.row.unpin': 'Unpin session',
}

/**
 * The locale seat, reduced to the two things the region asks of it. The cast is
 * the fixture boundary: the real seat is generated from the dictionary types.
 */
const t = ((key: string, params?: Record<string, string | number>): string => {
  const template = MESSAGES[key] ?? key
  if (params === undefined) return template
  return template.replace(/\{(\w+)\}/g, (match: string, name: string) => name in params ? String(params[name]) : match)
}) as never

const row = (id: string, extra: Partial<AttentionRow> = {}): AttentionRow => ({
  id: id as SessionId,
  title: id,
  ...extra,
})

const empty: AttentionModel = { running: [], unread: [], waiting: [] }

// React only honors act() when it is told it runs in a test environment.
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let roots: Root[] = []

afterEach(() => {
  act(() => { for (const root of roots) root.unmount() })
  roots = []
  document.body.replaceChildren()
})

interface Harness {
  readonly host: HTMLElement
  readonly open: ReturnType<typeof vi.fn>
  readonly unpin: ReturnType<typeof vi.fn>
  text(): string
  region(): Element | null
  header(index: number): HTMLButtonElement
  headers(): HTMLButtonElement[]
  button(label: string): HTMLButtonElement
  lists(): string[][]
}

/** The access hook the row actions' gate provides; `allowed` selects the fixture's answer. */
function mount(model: AttentionModel, options: { allowed?: boolean } = {}): Harness {
  const open = vi.fn()
  const unpin = vi.fn()
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  roots.push(root)
  const useSessionAccess = (() => options.allowed ?? true) as never
  // The real Hook is generic over the selected slice; the fixture always selects
  // the whole model, so the cast is a shape statement, not a behaviour change.
  const useAttention = ((select: (snapshot: AttentionModel) => AttentionModel) => select(model)) as never
  act(() => {
    root.render(createElement(AttentionSection, {
      useAttention,
      useSessionAccess,
      open,
      unpin,
      t,
    }))
  })
  const headers = (): HTMLButtonElement[] =>
    [...host.querySelectorAll('button[aria-expanded]')] as HTMLButtonElement[]
  const header = (index: number): HTMLButtonElement => {
    const found = headers()[index]
    if (found === undefined) throw new Error('no fold header at index ' + String(index))
    return found
  }
  const button = (label: string): HTMLButtonElement => {
    const found = [...host.querySelectorAll('button')].find(node => node.getAttribute('aria-label') === label)
    if (found === undefined) throw new Error('no button labelled "' + label + '"')
    return found
  }
  return {
    host,
    open,
    unpin,
    text: () => host.textContent ?? '',
    region: () => host.querySelector('[data-attention-section]'),
    header,
    headers,
    button,
    lists: () => [...host.querySelectorAll('ul')].map(list =>
      [...list.children].map(item => item.textContent ?? '')),
  }
}

describe('In work region', () => {
  it('draws nothing at all while both groups are empty', () => {
    const view = mount(empty)
    expect(view.region()).toBeNull()
    expect(view.text()).toBe('')
    expect(view.headers()).toHaveLength(0)
  })

  it('renders two independent folds, each with its own visible count and no region header', () => {
    const model: AttentionModel = {
      running: [row('run'), row('pin-run', { pinned: true })],
      unread: [row('done'), row('pin-idle', { container: true, pinned: true })],
      waiting: [],
    }
    const view = mount(model)
    expect(view.headers().map(node => node.textContent)).toEqual(['Running 2', 'Unread 2'])
    expect(view.lists()).toEqual([['run', 'pin-run'], ['done', 'pin-idle']])
    expect(view.host.querySelectorAll('h3')).toHaveLength(0)
    // The region holds the two folds and nothing above them: no title, no total.
    expect([...(view.region()?.children ?? [])]).toHaveLength(2)
    expect(view.region()?.firstElementChild?.firstElementChild?.getAttribute('aria-expanded')).toBe('true')
  })

  it('lists a pinned idle Session under unread with its release control', () => {
    const view = mount({
      running: [],
      unread: [row('pin', { container: true, pinned: true })],
      waiting: [],
    })
    expect(view.headers().map(node => node.textContent)).toEqual(['Unread 1'])
    expect(view.lists()).toEqual([['pin']])
    expect(view.button('Unpin session')).toBeDefined()
  })

  it('lists a pinned running Session only under running', () => {
    const view = mount({
      running: [row('pin-run', { pinned: true })],
      unread: [],
      waiting: [],
    })
    expect(view.headers().map(node => node.textContent)).toEqual(['Running 1'])
    expect(view.lists()).toEqual([['pin-run']])
    expect(view.text()).not.toContain('Unread')
    expect(view.host.querySelectorAll('ul > li')).toHaveLength(1)
  })

  it('collapses each group independently', () => {
    const model: AttentionModel = {
      running: [row('run')],
      unread: [row('done')],
      waiting: [],
    }
    const view = mount(model)
    act(() => { view.header(0).click() })
    expect(view.lists()).toEqual([['done']])
    expect(view.header(0).getAttribute('aria-expanded')).toBe('false')
    expect(view.header(1).getAttribute('aria-expanded')).toBe('true')
    act(() => { view.header(1).click() })
    expect(view.lists()).toEqual([])
    expect(view.header(0).textContent).toBe('Running 1')
    expect(view.header(1).textContent).toBe('Unread 1')
    act(() => { view.header(0).click() })
    expect(view.lists()).toEqual([['run']])
  })

  it('opens the Session behind a running row', () => {
    const view = mount({ running: [row('run')], unread: [], waiting: [] })
    act(() => { view.button('Open session run').click() })
    expect(view.open).toHaveBeenCalledWith('run')
  })

  it('opens an unread row too, leaving the unread flag to the host', () => {
    // Clearing the completion flag is ui-session's response to the navigation this
    // click starts; the region holds no copy of that flag to clear itself.
    const view = mount({ running: [], unread: [row('done')], waiting: [] })
    act(() => { view.button('Open session done').click() })
    expect(view.open).toHaveBeenCalledWith('done')
    expect(view.host.querySelector('[data-state="done"]')).not.toBeNull()
  })

  it('releases a pin without opening the row', () => {
    const view = mount({
      running: [],
      unread: [row('pin', { container: true, pinned: true })],
      waiting: [],
    })
    act(() => { view.button('Unpin session').click() })
    expect(view.unpin).toHaveBeenCalledWith('pin')
    expect(view.open).not.toHaveBeenCalled()
  })

  it('hides the release control where the Session access refuses unpinning', () => {
    const view = mount({
      running: [],
      unread: [row('pin', { container: true, pinned: true })],
      waiting: [],
    }, { allowed: false })
    expect(view.text()).toContain('pin')
    expect([...view.host.querySelectorAll('button')].some(node => node.getAttribute('aria-label') === 'Unpin session'))
      .toBe(false)
  })

  it('drops the action strip where the access refuses unpinning, keeping the resting mark', () => {
    const refused = mount({
      running: [],
      unread: [row('pin', { container: true, pinned: true })],
      waiting: [],
    }, { allowed: false })
    // The mark reports the pin, not the permission: it stays at rest either way.
    expect(refused.host.querySelectorAll('[data-testid="pin-filled"]')).toHaveLength(1)
    // Nothing but the open target and the resting cell is drawn, so hovering a
    // refused row cannot expose an empty action area.
    const rowBox = refused.host.querySelector('ul > li > div')
    expect(rowBox?.children).toHaveLength(2)
  })

  it('draws the action strip beside the resting mark when the access allows unpinning', () => {
    const allowed = mount({
      running: [],
      unread: [row('pin', { container: true, pinned: true })],
      waiting: [],
    })
    const rowBox = allowed.host.querySelector('ul > li > div')
    expect(rowBox?.children).toHaveLength(3)
  })

  it('marks a blocked turn with the warning dot instead of the group dot', () => {
    const view = mount({
      running: [row('run')],
      unread: [],
      waiting: [row('run')],
    })
    expect(view.host.querySelector('[data-state="warning"]')).not.toBeNull()
  })

  it('draws no state dot on a quiet pinned row', () => {
    const view = mount({
      running: [],
      unread: [row('pin', { container: true, pinned: true })],
      waiting: [],
    })
    expect(view.host.querySelectorAll('[data-testid="state-dot"]')).toHaveLength(0)
  })

  it('draws the ongoing dot for running and the done dot for unread', () => {
    const view = mount({
      running: [row('run')],
      unread: [row('done')],
      waiting: [],
    })
    expect(view.host.querySelector('[data-state="ongoing"]')).not.toBeNull()
    expect(view.host.querySelector('[data-state="done"]')).not.toBeNull()
  })

  it('shows every entry when both groups are long', () => {
    const running = Array.from({ length: 9 }, (_, index) => row('run' + String(index)))
    const unread = Array.from({ length: 5 }, (_, index) => row('done' + String(index)))
    const view = mount({ running, unread, waiting: [] })
    expect(view.host.querySelectorAll('ul > li')).toHaveLength(14)
    expect(view.text()).not.toContain('Showing the first')
  })

  it('renders one flat list per group, with no nested rows', () => {
    // Subagent Sessions never reach the region, so a row is always a single item:
    // there is no nested list for one Session's delegated work.
    const view = mount({
      running: [row('run'), row('run-2')],
      unread: [row('done')],
      waiting: [],
    })
    expect(view.lists()).toEqual([['run', 'run-2'], ['done']])
    expect(view.host.querySelectorAll('ul ul')).toHaveLength(0)
  })
})
