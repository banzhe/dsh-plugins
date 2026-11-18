// @vitest-environment jsdom
import { act, createElement, useState, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { AttentionSection } from '../src/client/attention/AttentionSection.tsx'
import type { AttentionModel, AttentionRow } from '../src/client/attention/model.ts'

/** The fourth fold's title is whatever the owner injects: the region must not invent one. */
const TREE_TITLE = 'My projects'

const MESSAGES: Record<string, string> = {
  'attention.section.unread': 'Unread',
  'attention.section.pinned': 'Pinned',
  'attention.section.running': 'Running',
  // A row's trailing time label is not part of this region's contract; the empty
  // rendering keeps a row's text equal to the title a test selects it by.
  'time.now': '',
}

/**
 * The locale seat, reduced to the lookup the region asks of it. The cast is the
 * fixture boundary: the real seat is generated from the dictionary types.
 */
const t = ((key: string, params?: Record<string, string | number>): string => {
  const template = MESSAGES[key] ?? key
  if (params === undefined) return template
  return template.replace(/\{(\w+)\}/g, (match: string, name: string) => name in params ? String(params[name]) : match)
}) as never

/** One row the fold hands the region, carrying the real Session state it holds. */
const node = (id: string, over: Partial<AttentionRow> = {}): AttentionRow => ({
  id: id as SessionId,
  title: id,
  blank: false,
  running: false,
  runningSubagentCount: 0,
  completed: false,
  pinned: false,
  archived: false,
  updatedAt: 0,
  ...over,
})

const attention = (over: Partial<AttentionModel> = {}): AttentionModel => ({
  running: [],
  unread: [],
  pinned: [],
  waiting: [],
  ...over,
})

const EMPTY = attention()

const GROUPS = ['unread', 'pinned', 'running'] as const

const THREE = attention({
  unread: [node('done', { completed: true })],
  pinned: [node('pin', { pinned: true })],
  running: [node('run', { running: true })],
})

/** The row action slot's owner: exactly the Session and the title it is drawn for. */
function ownerOf(owner: unknown): { sessionId: string; displayTitle: string } {
  if (typeof owner !== 'object' || owner === null) {
    throw new Error('row action owner must name the Session: ' + JSON.stringify(owner))
  }
  const bag = owner as { sessionId?: unknown; displayTitle?: unknown }
  const sessionId = typeof bag.sessionId === 'string' ? bag.sessionId : ''
  const displayTitle = typeof bag.displayTitle === 'string' ? bag.displayTitle : ''
  if (sessionId === '') throw new Error('row action owner must name the Session: ' + JSON.stringify(owner))
  return { sessionId, displayTitle }
}

/** A factory slot's props, whether the shell passes the object or a renderer for it. */
function optionsOf(value: unknown): { target?: { value?: { sessionId?: unknown; displayTitle?: unknown } } } {
  if (typeof value !== 'function') return value ?? {}
  try {
    return optionsOf((value as () => unknown)())
  } catch {
    // A renderer that needs its props cannot be called bare; the assertions then
    // report the missing target instead of a stack from this fixture.
    return {}
  }
}

/** Whether an element is drawn, for folds that hide by attribute instead of unmounting. */
function shown(element: Element): boolean {
  for (let current: Element | null = element; current !== null; current = current.parentElement) {
    if (current.hasAttribute('hidden')) return false
    const style = (current as HTMLElement).style
    if (style !== undefined && (style.display === 'none' || style.visibility === 'hidden')) return false
  }
  return true
}

const FOCUSABLE = 'button, a[href], input, select, textarea, [tabindex], [contenteditable="true"]'

/** Whether a keyboard user can reach, and a screen reader announce, the control. */
function reachable(element: Element): boolean {
  if (!shown(element)) return false
  for (let current: Element | null = element; current !== null; current = current.parentElement) {
    if (current.hasAttribute('inert') || current.getAttribute('aria-hidden') === 'true') return false
  }
  if ((element as HTMLButtonElement).disabled) return false
  const tabindex = element.getAttribute('tabindex')
  return tabindex === null || Number(tabindex) >= 0
}

/** A body whose state only survives while the region keeps the same element mounted. */
function Counter(): ReactNode {
  const [count, setCount] = useState(0)
  return createElement('button', {
    'data-testid': 'counter',
    onClick: () => { setCount(value => value + 1) },
  }, String(count))
}

const BODY = createElement('div', { 'data-testid': 'tree-body' },
  createElement('div', { 'data-row-key': 'session:tree-row', role: 'treeitem' }, 'tree-row'))

// React only honors act() when it is told it runs in a test environment.
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let roots: Root[] = []

afterEach(() => {
  act(() => { for (const root of roots) root.unmount() })
  roots = []
  document.body.replaceChildren()
})

interface Options {
  /** What the Session access hook answers. */
  readonly allowed?: boolean
  /** Whether the stubbed row-action slot applies the access gate the way the native entry does. */
  readonly rowActionGate?: boolean
  /** The Session the host considers current. */
  readonly currentId?: string
  readonly children?: ReactNode
}

interface Harness {
  readonly host: HTMLElement
  readonly open: ReturnType<typeof vi.fn>
  readonly rename: ReturnType<typeof vi.fn>
  /** The exact owner each row-action slot was rendered with, in render order. */
  readonly actionOwners: { sessionId: string; displayTitle: string }[]
  /** The Session whose row action was clicked. */
  readonly actionClicks: string[]
  /** The Session each row's context-menu button was built for. */
  readonly menuTargets: { sessionId: string; displayTitle: string }[]
  readonly menuClicks: string[]
  text(): string
  folds(): string[]
  fold(name: string): Element
  headerTexts(): string[]
  header(name: string): HTMLButtonElement
  expanded(name: string): string | null
  ariaControls(name: string): Element | null
  rows(): string[]
  rowsIn(name: string): string[]
  row(group: string, id: string): HTMLElement
  selection(group: string, id: string): string | null
  clickRow(id: string, title?: string): void
  testId(id: string): HTMLElement | null
  bodyShown(): boolean
  controlsInBody(): Element[]
  reachableInBody(): Element[]
}

/** Mount the region over a model, with the slots of the surrounding shell stubbed. */
function mount(model: AttentionModel, options: Options = {}): Harness {
  const open = vi.fn()
  const rename = vi.fn()
  const actionOwners: { sessionId: string; displayTitle: string }[] = []
  const actionClicks: string[] = []
  const menuTargets: { sessionId: string; displayTitle: string }[] = []
  const menuClicks: string[] = []
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  roots.push(root)

  const useAttention = ((select: (snapshot: AttentionModel) => AttentionModel) => select(model)) as never
  const useSessionAccess = (() => options.allowed ?? true) as never
  // A predicate selector over the one Session a menu could be open for. Nothing is
  // open in this fixture, so every row answers false.
  const useContextMenuTarget = (() => false) as never
  const useContextMenu = (() => ({ getTriggerProps: () => ({}) })) as never

  // The row action is the shell's control: the region names the Session and the
  // title it draws, for every row, exactly like the tree does. The access gate
  // lives inside the native entry, so a stub only applies it when asked to.
  const renderSlot = ((name: string, owner?: unknown): ReactNode => {
    if (name !== 'sidebar.workspaces.session.row.action') return null
    if (options.rowActionGate === true && options.allowed === false) return null
    const exact = ownerOf(owner)
    actionOwners.push(exact)
    return createElement('button', {
      'data-testid': 'row-pin-' + exact.sessionId,
      onClick: () => { actionClicks.push(exact.sessionId) },
    }, 'pin:' + exact.sessionId)
  }) as never

  // The context-menu trigger is the shell's control too.
  const renderFactorySlot = ((name: string, slotOptions?: unknown): ReactNode => {
    if (name !== 'contextMenu.button') return null
    const resolved = optionsOf(slotOptions)
    const value = resolved.target?.value ?? {}
    const sessionId = typeof value.sessionId === 'string' ? value.sessionId : ''
    const displayTitle = typeof value.displayTitle === 'string' ? value.displayTitle : ''
    menuTargets.push({ sessionId, displayTitle })
    return createElement('button', {
      'data-testid': 'more-' + sessionId,
      onClick: () => { menuClicks.push(sessionId) },
    }, 'more:' + sessionId)
  }) as never

  const props = {
    useAttention,
    useSessionAccess,
    open,
    onSessionRenameRequest: rename,
    ...(options.currentId === undefined ? {} : { currentId: options.currentId as SessionId }),
    workspacesTitle: TREE_TITLE,
    renderSlot,
    renderFactorySlot,
    useContextMenuTarget,
    useContextMenu,
    t,
    children: options.children ?? BODY,
  }
  act(() => { root.render(createElement(AttentionSection, props as never)) })

  const folds = (): string[] => ([...host.querySelectorAll('[data-browser-fold]')])
    .map(element => element.getAttribute('data-browser-fold') ?? '')
  const fold = (name: string): Element => {
    const found = host.querySelector('[data-browser-fold="' + name + '"]')
    if (found === null) throw new Error('no fold "' + name + '" in ' + JSON.stringify(folds()))
    return found
  }
  const header = (name: string): HTMLButtonElement => {
    const found = fold(name).querySelector('button[aria-expanded]')
    if (found === null) throw new Error('no fold header for "' + name + '"')
    return found as HTMLButtonElement
  }
  const headerTexts = (): string[] => folds().map(name => header(name).textContent ?? '')
  const expanded = (name: string): string | null => header(name).getAttribute('aria-expanded')
  const ariaControls = (name: string): Element | null => {
    const id = header(name).getAttribute('aria-controls')
    return id === null ? null : document.getElementById(id)
  }
  const keyId = (key: string): string => {
    const parts = key.split(':')
    return (parts[0] === 'quick' ? parts.slice(2) : parts.slice(1)).join(':')
  }
  const rowsIn = (name: string): string[] => ([...fold(name).querySelectorAll('[data-row-key]')] as HTMLElement[])
    .filter(shown)
    .map(element => keyId(element.getAttribute('data-row-key') ?? ''))
  const rows = (): string[] => GROUPS.flatMap(name =>
    host.querySelector('[data-browser-fold="' + name + '"]') === null ? [] : rowsIn(name))
  const row = (group: string, id: string): HTMLElement => {
    const found = ([...fold(group).querySelectorAll('[data-row-key]')] as HTMLElement[])
      .find(element => keyId(element.getAttribute('data-row-key') ?? '') === id)
    if (found === undefined) throw new Error('no row "' + id + '" in "' + group + '"')
    return found
  }
  const body = (): HTMLElement | null => host.querySelector('[data-testid="tree-body"]')
  return {
    host,
    open,
    rename,
    actionOwners,
    actionClicks,
    menuTargets,
    menuClicks,
    text: () => host.textContent ?? '',
    folds,
    fold,
    headerTexts,
    header,
    expanded,
    ariaControls,
    rows,
    rowsIn,
    row,
    // The row's selection state is announced on the row it belongs to; which node
    // inside carries it is not part of the contract.
    selection: (group, id) => {
      const element = row(group, id)
      const holder = element.hasAttribute('aria-selected') ? element : element.querySelector('[aria-selected]')
      return holder?.getAttribute('aria-selected') ?? null
    },
    // The click lands on the innermost element drawing the title, so it reaches the
    // row's open target whether that target is the row itself or a child control.
    clickRow: (id, title) => {
      const element = ([...host.querySelectorAll('[data-row-key^="quick:"]')] as HTMLElement[])
        .find(candidate => keyId(candidate.getAttribute('data-row-key') ?? '') === id)
      if (element === undefined) throw new Error('no quick row "' + id + '" in ' + JSON.stringify(rows()))
      const label = title ?? id
      const titled = ([...element.querySelectorAll('*')] as HTMLElement[])
        .filter(child => (child.textContent ?? '') === label)
      act(() => { (titled[titled.length - 1] ?? element).click() })
    },
    testId: id => host.querySelector('[data-testid="' + id + '"]'),
    bodyShown: () => {
      const element = body()
      return element !== null && shown(element)
    },
    controlsInBody: () => {
      const element = body()
      return element === null ? [] : [...element.querySelectorAll(FOCUSABLE)]
    },
    reachableInBody: () => {
      const element = body()
      if (element === null) return []
      return [...element.querySelectorAll(FOCUSABLE)].filter(reachable)
    },
  }
}

describe('In work region', () => {
  it('keeps the workspaces fold while every quick group is empty', () => {
    const view = mount(EMPTY)
    expect(view.folds()).toEqual(['workspaces'])
    expect(view.headerTexts()).toEqual([TREE_TITLE])
    expect(view.rows()).toEqual([])
    expect(view.bodyShown()).toBe(true)
  })

  it('draws the three quick folds in unread, pinned, running order, each counted', () => {
    const view = mount(THREE)
    expect(view.folds()).toEqual(['unread', 'pinned', 'running', 'workspaces'])
    expect(view.headerTexts()).toEqual(['Unread 1', 'Pinned 1', 'Running 1', TREE_TITLE])
    expect(view.rows()).toEqual(['done', 'pin', 'run'])
    expect(view.rowsIn('pinned')).toEqual(['pin'])
  })

  it('hides a quick fold that has nothing to list', () => {
    const view = mount(attention({ pinned: [node('pin', { pinned: true })] }))
    expect(view.folds()).toEqual(['pinned', 'workspaces'])
    expect(view.headerTexts()).toEqual(['Pinned 1', TREE_TITLE])
    expect(view.rows()).toEqual(['pin'])
  })

  it('collapses each quick fold on its own', () => {
    const view = mount(THREE)
    act(() => { view.header('unread').click() })
    expect(view.expanded('unread')).toBe('false')
    expect(view.rowsIn('unread')).toEqual([])
    expect(view.rows()).toEqual(['pin', 'run'])
    expect(view.expanded('pinned')).toBe('true')
    act(() => { view.header('pinned').click() })
    expect(view.rows()).toEqual(['run'])
    expect(view.expanded('running')).toBe('true')
    act(() => { view.header('unread').click() })
    expect(view.rows()).toEqual(['done', 'run'])
    act(() => { view.header('pinned').click() })
    expect(view.rows()).toEqual(['done', 'pin', 'run'])
  })

  it('never leaves a fold header pointing at a body it removed', () => {
    const view = mount(THREE)
    const assertTargets = (): void => {
      for (const name of view.folds()) {
        const id = view.header(name).getAttribute('aria-controls')
        // A fold may announce its body or stay silent; it must not announce a node
        // that is gone, which is what a screen reader would follow into nothing.
        if (id !== null) expect(document.getElementById(id)).not.toBeNull()
      }
    }
    assertTargets()
    act(() => { view.header('unread').click() })
    assertTargets()
    act(() => { view.header('workspaces').click() })
    assertTargets()
  })

  it('expands the workspaces fold by default and keeps its announced target across a collapse', () => {
    const view = mount(EMPTY)
    expect(view.expanded('workspaces')).toBe('true')
    expect(view.bodyShown()).toBe(true)
    const target = view.ariaControls('workspaces')
    expect(target).not.toBeNull()
    act(() => { view.header('workspaces').click() })
    expect(view.expanded('workspaces')).toBe('false')
    expect(view.bodyShown()).toBe(false)
    // The announced target still exists: assistive tech is never pointed at nothing.
    expect(view.ariaControls('workspaces')).not.toBeNull()
    expect(view.ariaControls('workspaces')).toBe(target)
    expect(view.text()).toContain(TREE_TITLE)
    act(() => { view.header('workspaces').click() })
    expect(view.bodyShown()).toBe(true)
  })

  it('takes the collapsed workspaces body out of the keyboard without unmounting it', () => {
    const view = mount(EMPTY, {
      children: createElement('div', { 'data-testid': 'tree-body' }, createElement(Counter)),
    })
    const controls = view.controlsInBody()
    expect(controls).toHaveLength(1)
    expect(view.reachableInBody()).toHaveLength(1)
    act(() => { view.header('workspaces').click() })
    // Still mounted, so a body that holds state can come back unchanged...
    expect(view.controlsInBody()).toHaveLength(1)
    // ...but neither a keyboard user nor a screen reader can reach it.
    expect(view.reachableInBody()).toHaveLength(0)
    act(() => { view.header('workspaces').click() })
    expect(view.reachableInBody()).toHaveLength(1)
  })

  it('restores the state of the workspaces body after a collapse', () => {
    const view = mount(EMPTY, {
      children: createElement('div', { 'data-testid': 'tree-body' }, createElement(Counter)),
    })
    const counter = view.testId('counter')
    expect(counter).not.toBeNull()
    act(() => { counter?.click() })
    act(() => { counter?.click() })
    expect(view.testId('counter')?.textContent).toBe('2')
    act(() => { view.header('workspaces').click() })
    act(() => { view.header('workspaces').click() })
    expect(view.testId('counter')).toBe(counter)
    expect(view.testId('counter')?.textContent).toBe('2')
  })

  it('opens the Session behind a row of every group', () => {
    const view = mount(THREE)
    view.clickRow('done')
    view.clickRow('pin')
    view.clickRow('run')
    expect(view.open.mock.calls).toEqual([['done'], ['pin'], ['run']])
  })

  it('keeps the real state of each row in its dot', () => {
    const view = mount(THREE)
    expect(view.row('running', 'run').querySelector('[data-state="ongoing"]')).not.toBeNull()
    expect(view.row('unread', 'done').querySelector('[data-state="done"]')).not.toBeNull()
    // A quiet pinned Session reports no activity of its own.
    expect(view.row('pinned', 'pin').querySelectorAll('[data-testid="state-dot"]')).toHaveLength(0)
  })

  it('marks a blocked turn with the warning dot', () => {
    const view = mount(attention({
      running: [node('run', { running: true, pendingInteraction: 'approval' })],
    }))
    expect(view.row('running', 'run').querySelector('[data-state="warning"]')).not.toBeNull()
  })

  it('builds the native context-menu button for the right Session and title', () => {
    const view = mount(attention({
      unread: [node('done', { title: 'Done work', completed: true })],
      pinned: [node('pin', { title: 'Pinned work', pinned: true })],
      running: [node('run', { title: 'Running work', running: true })],
    }))
    expect(view.menuTargets).toEqual([
      { sessionId: 'done', displayTitle: 'Done work' },
      { sessionId: 'pin', displayTitle: 'Pinned work' },
      { sessionId: 'run', displayTitle: 'Running work' },
    ])
    const more = view.testId('more-pin')
    expect(more).not.toBeNull()
    act(() => { more?.click() })
    expect(view.menuClicks).toEqual(['pin'])
    expect(view.open).not.toHaveBeenCalled()
  })

  it('keeps every row closed while no menu is open', () => {
    const view = mount(THREE)
    // The predicate selector answers false for every Session here, so no row may
    // announce itself as an open menu.
    expect(view.host.querySelectorAll('[data-row-key^="quick:"] [aria-expanded="true"]')).toHaveLength(0)
  })

  it('draws the row title of a named Session', () => {
    const view = mount(attention({ unread: [node('done', { title: 'Done work', completed: true })] }))
    expect(view.row('unread', 'done').textContent).toContain('Done work')
    view.clickRow('done', 'Done work')
    expect(view.open.mock.calls).toEqual([['done']])
  })

  it('names the exact owner of every row action and keeps it out of the open path', () => {
    const view = mount(attention({
      unread: [node('done', { title: 'Done work', completed: true })],
      pinned: [node('pin', { title: 'Pinned work', pinned: true })],
      running: [node('run', { title: 'Running work', running: true })],
    }))
    expect(view.actionOwners).toEqual([
      { sessionId: 'done', displayTitle: 'Done work' },
      { sessionId: 'pin', displayTitle: 'Pinned work' },
      { sessionId: 'run', displayTitle: 'Running work' },
    ])
    const action = view.testId('row-pin-run')
    expect(action).not.toBeNull()
    act(() => { action?.click() })
    expect(view.actionClicks).toEqual(['run'])
    expect(view.open).not.toHaveBeenCalled()
  })

  it('marks only the row of the current Session as selected', () => {
    const view = mount(THREE, { currentId: 'pin' })
    expect(view.selection('pinned', 'pin')).toBe('true')
    expect(view.selection('unread', 'done')).toBe('false')
    expect(view.selection('running', 'run')).toBe('false')
  })

  it('leaves every row unselected without a current Session', () => {
    const view = mount(THREE)
    expect([
      view.selection('unread', 'done'),
      view.selection('pinned', 'pin'),
      view.selection('running', 'run'),
    ]).toEqual(['false', 'false', 'false'])
  })

  it('offers the row action slot where Session access refuses, leaving the gate to the entry', () => {
    const view = mount(attention({ pinned: [node('pin', { pinned: true })] }), { allowed: false })
    // The region renders the slot unconditionally, like the tree: the native entry
    // decides for itself whether it draws a pin control.
    expect(view.actionOwners).toEqual([{ sessionId: 'pin', displayTitle: 'pin' }])
  })

  it('keeps the row usable when the native row action draws nothing', () => {
    const view = mount(attention({ pinned: [node('pin', { pinned: true })] }), { allowed: false, rowActionGate: true })
    expect(view.actionOwners).toEqual([])
    expect(view.testId('row-pin-pin')).toBeNull()
    view.clickRow('pin')
    expect(view.open.mock.calls).toEqual([['pin']])
  })

  it('draws one flat row per Session with no nested rows', () => {
    const view = mount(attention({
      running: [node('run', { running: true }), node('run-2', { running: true })],
      unread: [node('done', { completed: true })],
    }))
    expect(view.rows()).toEqual(['done', 'run', 'run-2'])
    expect(view.fold('running').querySelectorAll('[data-row-key] [data-row-key]')).toHaveLength(0)
  })

  it('shows every entry when the groups are long', () => {
    const running = Array.from({ length: 9 }, (_, index) => node('run' + String(index), { running: true }))
    const unread = Array.from({ length: 5 }, (_, index) => node('done' + String(index), { completed: true }))
    const pinned = Array.from({ length: 4 }, (_, index) => node('pin' + String(index), { pinned: true }))
    const view = mount(attention({ running, unread, pinned }))
    expect(view.rows()).toHaveLength(18)
    expect(view.headerTexts()).toEqual(['Unread 5', 'Pinned 4', 'Running 9', TREE_TITLE])
    expect(view.text()).not.toContain('Showing the first')
  })
})
