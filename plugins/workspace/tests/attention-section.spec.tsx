// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { AttentionSection } from '../src/client/attention/AttentionSection.tsx'
import type { AttentionModel, AttentionRow } from '../src/client/attention/model.ts'

const MESSAGES: Record<string, string> = {
  'attention.title': 'Attention',
  'attention.empty': 'No sessions need attention',
  'attention.expand': 'Expand sessions needing attention',
  'attention.collapse': 'Collapse sessions needing attention',
  'attention.section.pinned': 'Pinned',
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

const empty: AttentionModel = { running: [], unread: [], waiting: [], total: 0 }

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
  header(): HTMLButtonElement
  button(label: string): HTMLButtonElement
  badge(): string
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
  const header = (): HTMLButtonElement => {
    const found = host.querySelector('button[aria-expanded]')
    if (found === null) throw new Error('no fold header')
    return found as HTMLButtonElement
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
    header,
    button,
    badge: () => host.querySelector('[class*="badge"]')?.textContent?.trim() ?? '',
  }
}

describe('attention region', () => {
  it('names its fold control by the visible title and count', () => {
    const view = mount(empty)
    expect(view.header().textContent).toContain('Attention')
    expect(view.header().textContent).toContain('0')
    expect(view.header().textContent).not.toContain('sessions needing attention')
    expect(view.header().getAttribute('aria-expanded')).toBe('true')
  })

  it('renders the empty state when nothing needs a look', () => {
    const view = mount(empty)
    expect(view.text()).toContain('No sessions need attention')
    expect(view.host.querySelectorAll('h3')).toHaveLength(0)
    expect(view.badge()).toBe('0')
  })

  it('renders pinned, running and unread groups with their counts', () => {
    const model: AttentionModel = {
      running: [row('pin', { container: true, pinned: true }), row('run')],
      unread: [row('done')],
      waiting: [],
      total: 2,
    }
    const view = mount(model)
    const headings = [...view.host.querySelectorAll('h3')].map(node => node.textContent)
    expect(headings).toEqual(['Pinned 1', 'Running 1', 'Unread 1'])
    // The count beside a group name is decoration; the header carries the total.
    expect(view.host.querySelectorAll('h3 [aria-hidden="true"]')).toHaveLength(3)
    expect(view.badge()).toBe('2')
    expect(view.text()).not.toContain('No sessions need attention')
  })

  it('opens the Session behind a row', () => {
    const view = mount({ running: [row('run')], unread: [], waiting: [], total: 1 })
    act(() => { view.button('Open session run').click() })
    expect(view.open).toHaveBeenCalledWith('run')
  })

  it('opens an unread row too, leaving the unread flag to the host', () => {
    // Clearing the completion flag is ui-session's response to the navigation this
    // click starts; the region holds no copy of that flag to clear itself.
    const view = mount({ running: [], unread: [row('done')], waiting: [], total: 1 })
    act(() => { view.button('Open session done').click() })
    expect(view.open).toHaveBeenCalledWith('done')
    expect(view.text()).toContain('Unread')
  })

  it('releases a pin without opening the row', () => {
    const view = mount({ running: [row('pin', { container: true, pinned: true })], unread: [], waiting: [], total: 0 })
    act(() => { view.button('Unpin session').click() })
    expect(view.unpin).toHaveBeenCalledWith('pin')
    expect(view.open).not.toHaveBeenCalled()
  })

  it('hides the release control where the Session access refuses unpinning', () => {
    const model: AttentionModel = {
      running: [row('pin', { container: true, pinned: true })],
      unread: [],
      waiting: [],
      total: 0,
    }
    const view = mount(model, { allowed: false })
    expect(view.text()).toContain('pin')
    expect([...view.host.querySelectorAll('button')].some(node => node.getAttribute('aria-label') === 'Unpin session'))
      .toBe(false)
  })

  it('marks a blocked turn with the warning dot instead of the group dot', () => {
    const model: AttentionModel = { running: [row('run')], unread: [], waiting: [row('run')], total: 1 }
    const view = mount(model)
    expect(view.host.querySelector('[data-state="warning"]')).not.toBeNull()
  })

  it('draws no state dot on a container row', () => {
    const model: AttentionModel = {
      running: [row('parent', { container: true, children: [row('child')] })],
      unread: [],
      waiting: [],
      total: 1,
    }
    const view = mount(model)
    expect(view.host.querySelectorAll('[data-testid="state-dot"]')).toHaveLength(1)
  })

  it('collapses its groups and keeps the activity count visible', () => {
    const model: AttentionModel = { running: [row('run')], unread: [row('done')], waiting: [], total: 2 }
    const view = mount(model)
    act(() => { view.header().click() })
    expect(view.host.querySelectorAll('h3')).toHaveLength(0)
    expect(view.text()).not.toContain('run')
    expect(view.badge()).toBe('2')
    expect(view.header().getAttribute('aria-expanded')).toBe('false')
    expect(view.header().textContent).toContain('Attention')
  })

  it('nests a mounted subagent under its parent row', () => {
    const model: AttentionModel = {
      running: [row('parent', { container: true, children: [row('child')] })],
      unread: [],
      waiting: [],
      total: 1,
    }
    const view = mount(model)
    expect(view.text()).toContain('parent')
    expect(view.text()).toContain('child')
  })
})
