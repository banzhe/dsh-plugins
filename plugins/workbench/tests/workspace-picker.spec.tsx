// @vitest-environment jsdom
/**
 * The workspace picker overlay as a user meets it: a nested list ordered by the
 * nearest registered ancestor and indented a level per depth, fold arrows that
 * hide a subtree without selecting the row they sit in, the selected row's mark,
 * a title click that picks, and the add-workspace row that hands over to the
 * directory flow.
 */
import { act, createElement, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi, type Mock } from 'vitest'
import { WorkspacePickFlow, type WorkspacePickFlowProps } from '../src/client/WorkspacePicker.tsx'

/** One registered workspace, reduced to the fields the overlay lists. */
type View = { readonly workspaceId: string; readonly title: string | null; readonly path: string }

const view = (workspaceId: string, path: string, title: string | null = workspaceId): View =>
  ({ workspaceId, title, path })

/** Alpha holds Bravo, Bravo holds Charlie; Delta is a root of its own. */
const NESTED: readonly View[] = [
  view('a', 'C:/ws/alpha', 'Alpha'),
  view('b', 'C:/ws/alpha/bravo', 'Bravo'),
  view('c', 'C:/ws/alpha/bravo/charlie', 'Charlie'),
  view('d', 'C:/ws/delta', 'Delta'),
]
const NESTED_TITLES: readonly string[] = ['Alpha', 'Bravo', 'Charlie', 'Delta']

/** What the overlay asks the directory flow to draw; only open/busy are read. */
type DirectoryOwner = {
  readonly open: boolean
  readonly busy: boolean
  readonly onPicked: (path: string) => void
  readonly onCancel: () => void
  readonly onError: (message: string) => void
}

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let roots: Root[] = []

afterEach(() => {
  act(() => { for (const root of roots) root.unmount() })
  roots = []
  document.body.replaceChildren()
})

type MountOptions = {
  readonly items?: readonly View[]
  readonly addOnly?: boolean
  readonly selectedId?: string
  readonly groupExpansion?: Record<string, boolean>
}

/** The seats the test owns: the expansion store it feeds, and the callbacks it reads back. */
type Picker = {
  readonly onPick: Mock
  readonly onClose: Mock
  readonly setGroupExpanded: Mock
  readonly dirOwners: readonly { readonly open: boolean; readonly busy: boolean }[]
}

function mountPicker(options: MountOptions = {}): Picker {
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  roots.push(root)

  let expansion: Record<string, boolean> = { ...options.groupExpansion }
  const onPick = vi.fn()
  const onClose = vi.fn()
  const dirOwners: { open: boolean; busy: boolean }[] = []
  const snapshot = { phase: 'ready' as const, items: options.items ?? [] }

  function render(): void {
    act(() => { root.render(createElement(WorkspacePickFlow, props())) })
  }

  const setGroupExpanded = vi.fn((key: string, expanded: boolean) => {
    expansion = { ...expansion, [key]: expanded }
    render()
  })

  function props(): WorkspacePickFlowProps {
    return {
      t: (key: string) => key,
      open: true,
      useWorkspaces: (selector: (state: typeof snapshot) => unknown) => selector(snapshot),
      createWorkspace: async (input: { path: string }) => view('created', input.path, 'Created'),
      useDirectoryFlow: (selector: (occupied: boolean) => unknown) => selector(true),
      renderDirectoryFlow: (owner: DirectoryOwner): ReactNode => {
        dirOwners.push({ open: owner.open, busy: owner.busy })
        return owner.open ? createElement('span', { 'data-testid': 'dir-flow-open' }) : null
      },
      onPick,
      onClose,
      useStore: (selector: (state: { groupExpansion: Record<string, boolean> }) => unknown) =>
        selector({ groupExpansion: expansion }),
      setGroupExpanded,
      addOnly: options.addOnly,
      selectedId: options.selectedId,
    } as unknown as WorkspacePickFlowProps
  }

  render()

  return { onPick, onClose, setGroupExpanded, dirOwners }
}

/** Every clickable row the overlay drew, in document order. */
function menuItems(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>('[role="menuitem"]'))
}

function textOf(element: HTMLElement): string {
  return (element.textContent ?? '').trim()
}

function describeItems(): string {
  return menuItems().map(textOf).join(' | ')
}

/** The clickable row carrying a workspace title, tolerating any subtitle after it. */
function itemFor(title: string): HTMLElement {
  const match = menuItems().find(item => textOf(item) === title || textOf(item).startsWith(title))
  if (!match) throw new Error(`no menu item for "${title}"; items: ${describeItems()}`)
  return match
}

function itemReading(text: string): HTMLElement {
  const match = menuItems().find(item => textOf(item) === text)
  if (!match) throw new Error(`no menu item reading "${text}"; items: ${describeItems()}`)
  return match
}

/** The listed workspace titles, in the order the overlay lists them. */
function listed(titles: readonly string[]): string[] {
  const seen: string[] = []
  for (const item of menuItems()) {
    const text = textOf(item)
    const hit = titles.find(title => text === title || text.startsWith(title))
    if (hit !== undefined && !seen.includes(hit)) seen.push(hit)
  }
  return seen
}

/** The box a listed workspace draws as: the nearest one carrying the inline indent. */
function rowOf(item: HTMLElement): HTMLElement {
  for (let node: HTMLElement | null = item; node; node = node.parentElement) {
    if (node.style.paddingLeft !== '') return node
    if (node.getAttribute('role') === 'menu') break
  }
  const fallback = item.parentElement
  if (!fallback) throw new Error(`"${textOf(item)}" draws no row`)
  return fallback
}

function indentOf(title: string): number {
  return parseFloat(rowOf(itemFor(title)).style.paddingLeft || '0')
}

/** The fold arrow a row carries, read off `aria-expanded` rather than any class. */
function arrowOf(title: string): HTMLElement | undefined {
  return rowOf(itemFor(title)).querySelector<HTMLElement>('button[aria-expanded]') ?? undefined
}

function click(element: HTMLElement): void {
  act(() => { element.click() })
}

describe('Workspace picker', () => {
  describe('nesting', () => {
    it('lists a workspace under the nearest registered ancestor, one indent step per depth', () => {
      mountPicker({ items: NESTED })

      expect(listed(NESTED_TITLES)).toEqual(NESTED_TITLES)
      expect(indentOf('Alpha')).toBe(0)
      expect(indentOf('Bravo')).toBe(12)
      expect(indentOf('Charlie')).toBe(24)
      expect(indentOf('Delta')).toBe(0)
    })

    it('keeps two sibling roots in registration order when one of them gains a child', () => {
      mountPicker({
        items: [
          view('a', 'C:/ws/alpha', 'Alpha'),
          view('d', 'C:/ws/delta', 'Delta'),
          view('e', 'C:/ws/alpha/echo', 'Echo'),
        ],
      })

      const order = listed(['Alpha', 'Delta', 'Echo'])
      expect(order).toHaveLength(3)
      // Same-level roots keep the order they were registered in.
      expect(order.indexOf('Alpha')).toBeLessThan(order.indexOf('Delta'))
      // A parent is always listed before its child.
      expect(order.indexOf('Alpha')).toBeLessThan(order.indexOf('Echo'))
      expect(indentOf('Echo')).toBe(12)
      expect(indentOf('Delta')).toBe(0)
      // A leaf gains no arrow from sitting next to a parent.
      expect(arrowOf('Echo')).toBeUndefined()
      expect(arrowOf('Delta')).toBeUndefined()
      expect(arrowOf('Alpha')).toBeDefined()
    })

    it('reads nesting across backslashes, trailing separators and UNC spellings', () => {
      mountPicker({
        items: [
          view('w', 'C:\\ws\\alpha\\', 'Whiskey'),
          view('x', 'C:/ws/alpha/beta', 'Xray'),
          view('u', '\\\\server\\share\\root', 'Uniform'),
          view('v', '//server/share/root/child', 'Victor'),
        ],
      })

      expect(indentOf('Whiskey')).toBe(0)
      expect(indentOf('Xray')).toBe(12)
      expect(indentOf('Uniform')).toBe(0)
      expect(indentOf('Victor')).toBe(12)
      expect(arrowOf('Whiskey')).toBeDefined()
      expect(arrowOf('Uniform')).toBeDefined()
      expect(arrowOf('Xray')).toBeUndefined()
      expect(arrowOf('Victor')).toBeUndefined()
    })
  })

  describe('fold arrows', () => {
    it('shows an arrow only on rows with registered descendants', () => {
      mountPicker({ items: NESTED })

      expect(arrowOf('Alpha')?.getAttribute('aria-expanded')).toBe('true')
      expect(arrowOf('Bravo')?.getAttribute('aria-expanded')).toBe('true')
      expect(arrowOf('Charlie')).toBeUndefined()
      expect(arrowOf('Delta')).toBeUndefined()
    })

    it('folds and unfolds a subtree from the arrow without selecting the row', () => {
      const picker = mountPicker({ items: NESTED })

      const arrow = arrowOf('Alpha')
      const title = itemFor('Alpha')
      expect(arrow).toBeDefined()
      // The arrow is neither the title button nor nested with it, so folding cannot pick.
      expect(arrow).not.toBe(title)
      expect(arrow?.contains(title)).toBe(false)
      expect(title.contains(arrow!)).toBe(false)
      // Both sit in the row that carries the indent.
      expect(rowOf(title).contains(arrow!)).toBe(true)

      click(arrow!)

      expect(picker.setGroupExpanded).toHaveBeenCalledTimes(1)
      expect(picker.setGroupExpanded).toHaveBeenCalledWith('a', false)
      expect(picker.onPick).not.toHaveBeenCalled()
      expect(picker.onClose).not.toHaveBeenCalled()

      expect(listed(NESTED_TITLES)).toEqual(['Alpha', 'Delta'])
      expect(arrowOf('Alpha')?.getAttribute('aria-expanded')).toBe('false')

      click(arrowOf('Alpha')!)

      expect(picker.setGroupExpanded).toHaveBeenCalledTimes(2)
      expect(picker.setGroupExpanded).toHaveBeenLastCalledWith('a', true)
      expect(listed(NESTED_TITLES)).toEqual(NESTED_TITLES)
      expect(arrowOf('Alpha')?.getAttribute('aria-expanded')).toBe('true')
      expect(picker.onPick).not.toHaveBeenCalled()
    })

    it('treats a row with no expansion entry as expanded', () => {
      mountPicker({ items: NESTED })

      expect(listed(NESTED_TITLES)).toEqual(NESTED_TITLES)
    })

    it('hides a collapsed row\'s whole subtree, grandchildren included', () => {
      mountPicker({ items: NESTED, groupExpansion: { a: false } })

      expect(listed(NESTED_TITLES)).toEqual(['Alpha', 'Delta'])
      expect(arrowOf('Alpha')?.getAttribute('aria-expanded')).toBe('false')
    })

    it('hides only the collapsed middle row\'s subtree', () => {
      mountPicker({ items: NESTED, groupExpansion: { b: false } })

      expect(listed(NESTED_TITLES)).toEqual(['Alpha', 'Bravo', 'Delta'])
      expect(arrowOf('Bravo')?.getAttribute('aria-expanded')).toBe('false')
      expect(arrowOf('Alpha')?.getAttribute('aria-expanded')).toBe('true')
    })
  })

  describe('selection', () => {
    it('marks only the selected row, visibly and to assistive technology', () => {
      mountPicker({ items: NESTED, selectedId: 'b' })

      const selected = rowOf(itemFor('Bravo'))
      expect(selected.querySelector('[data-testid="check-outline"]')).not.toBeNull()
      expect(selected.querySelector('[aria-current]')).not.toBeNull()

      for (const title of ['Alpha', 'Charlie', 'Delta']) {
        const row = rowOf(itemFor(title))
        expect(row.querySelector('[data-testid="check-outline"]')).toBeNull()
        expect(row.querySelector('[aria-current]')).toBeNull()
      }
    })

    it('picks the workspace whose title is clicked, once', () => {
      const picker = mountPicker({ items: NESTED })

      const title = itemFor('Bravo')
      expect(title.tagName).toBe('BUTTON')
      expect(title.getAttribute('role')).toBe('menuitem')

      click(title)

      expect(picker.onPick).toHaveBeenCalledTimes(1)
      expect(picker.onPick).toHaveBeenCalledWith('b')
      expect(picker.setGroupExpanded).not.toHaveBeenCalled()
      expect(picker.onClose).not.toHaveBeenCalled()
    })
  })

  describe('adding a workspace', () => {
    it('keeps the add row in the menu and hands over to the directory flow', () => {
      const picker = mountPicker({ items: NESTED })

      expect(document.querySelector('[data-testid="dir-flow-open"]')).toBeNull()
      expect(picker.dirOwners.some(owner => owner.open)).toBe(false)

      const add = itemReading('menu.addWorkspace')
      expect(add.closest('[role="menu"]')).not.toBeNull()

      click(add)

      expect(picker.onClose).toHaveBeenCalledTimes(1)
      expect(picker.onPick).not.toHaveBeenCalled()
      expect(document.querySelector('[data-testid="dir-flow-open"]')).not.toBeNull()
      expect(picker.dirOwners[picker.dirOwners.length - 1]?.open).toBe(true)
    })

    it('opens the directory flow straight away when no workspace is registered', () => {
      const picker = mountPicker({ items: [] })

      expect(listed(NESTED_TITLES)).toEqual([])
      expect(document.querySelector('[role="menu"]')).toBeNull()
      expect(document.querySelector('[data-testid="dir-flow-open"]')).not.toBeNull()
      expect(picker.dirOwners.some(owner => owner.open)).toBe(true)
    })

    it('lists no workspace row when the overlay is add-only', () => {
      mountPicker({ items: NESTED, addOnly: true })

      expect(listed(NESTED_TITLES)).toEqual([])
    })
  })
})
