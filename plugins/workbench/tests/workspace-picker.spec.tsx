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
import pickerCss from '../src/client/WorkspacePicker.module.css'

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
  // The owner's chip: the menu hangs from it and measures the room under it.
  const anchor = document.createElement('button')
  anchor.textContent = 'workspace'
  document.body.append(anchor)
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
      anchorRef: { current: anchor },
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

/** The picker's always-open search field. */
function searchBox(): HTMLInputElement {
  const box = document.querySelector<HTMLInputElement>('[role="searchbox"]')
  if (box === null) throw new Error('the picker draws no search box')
  return box
}

/** The tree seat the picker's rows are drawn in. */
function treeList(): HTMLElement {
  const tree = document.querySelector<HTMLElement>('[data-testid="workspace-picker-tree"]')
  if (tree === null) throw new Error('the picker draws no tree list')
  return tree
}

/** Type a query the way a keystroke does: set the value, then fire the change. */
function search(query: string): void {
  const box = searchBox()
  act(() => {
    // React reads the DOM value through its own tracker, which a plain
    // assignment updates without reporting a change.
    const descriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')
    descriptor?.set?.call(box, query)
    box.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

/** Press a key on the picker's search field. */
function pressEscape(): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
  act(() => { searchBox().dispatchEvent(event) })
  return event
}

/** The picker's clear button, present only while the field holds text. */
function clearButton(): HTMLElement | null {
  return document.querySelector<HTMLElement>('[aria-label="search.clear"]')
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

  describe('search', () => {
    it('opens on a search field above a tree list that holds the rows', () => {
      mountPicker({ items: NESTED })

      const box = searchBox()
      expect(box.tagName).toBe('INPUT')
      expect(box.getAttribute('type')).toBe('text')
      expect(box.getAttribute('aria-label')).toBe('picker.search.aria')
      expect(box.getAttribute('placeholder')).toBe('picker.search.placeholder')
      expect(document.querySelectorAll('[role="searchbox"]')).toHaveLength(1)

      const tree = treeList()
      expect(tree.contains(box)).toBe(false)
      for (const title of NESTED_TITLES) expect(tree.contains(itemFor(title))).toBe(true)
      expect(clearButton()).toBeNull()
    })

    it('opens below its anchor and keeps the search field outside the tree scroller', () => {
      mountPicker({ items: NESTED })

      // The placement class reaches the card the primitive positions, which is
      // what pins it under the chip instead of letting it flip above once a
      // query shortens the list.
      const menu = document.querySelector<HTMLElement>('[role="menu"]')
      expect(menu).not.toBeNull()
      expect(menu?.className).toContain(pickerCss.openBelow)
      // The card caps itself with the room measured under the chip (jsdom has
      // no layout, so the anchor's bottom edge is 0 and the window is 768); the
      // measurement belongs to this card, not to the document.
      expect(menu?.style.getPropertyValue('--dsh-picker-menu-room')).toBe('768px')
      expect(document.documentElement.style.getPropertyValue('--dsh-picker-menu-room')).toBe('')

      const tree = treeList()
      expect(tree.className).toContain(pickerCss.treeList)
      expect(tree.contains(searchBox())).toBe(false)
      expect(tree.contains(itemFor('Delta'))).toBe(true)
    })

    it('draws no search field when the add action is the only entry', () => {
      mountPicker({ items: NESTED, addOnly: true })

      expect(document.querySelector('[role="searchbox"]')).toBeNull()
    })

    it('narrows to the matching rows plus the ancestors that lead to them, one fold none', () => {
      mountPicker({ items: NESTED })

      // A path tail that no title carries, upper-cased: matching is on the path
      // and ignores case; Alpha and Bravo stay as the ancestors of Charlie.
      search('ALPHA/BRAVO/C')

      expect(listed(NESTED_TITLES)).toEqual(['Alpha', 'Bravo', 'Charlie'])
      expect(indentOf('Alpha')).toBe(0)
      expect(indentOf('Bravo')).toBe(12)
      expect(indentOf('Charlie')).toBe(24)
      // Every kept row is unfolded and carries no disclosure to fold it with.
      expect(arrowOf('Alpha')).toBeUndefined()
      expect(treeList().querySelector('[aria-expanded]')).toBeNull()
    })

    it('restores every row when the query is cleared', () => {
      mountPicker({ items: NESTED })

      search('bravo')
      expect(listed(NESTED_TITLES)).toEqual(['Alpha', 'Bravo', 'Charlie'])

      search('')
      expect(listed(NESTED_TITLES)).toEqual(NESTED_TITLES)
      expect(arrowOf('Alpha')).toBeDefined()
    })

    it('keeps the menu open with a no-matches line when nothing matches', () => {
      mountPicker({ items: NESTED })

      search('zulu')

      expect(document.querySelector('[role="menu"]')).not.toBeNull()
      expect(searchBox().value).toBe('zulu')
      // The add action pins below the tree; no Workspace row is left.
      expect(menuItems().map(textOf)).toEqual(['menu.addWorkspace'])
      expect(treeList().textContent).toContain('picker.noMatches')
    })

    it('writes no shared expansion while filtering', () => {
      const picker = mountPicker({ items: NESTED })

      search('bravo')

      expect(picker.setGroupExpanded).not.toHaveBeenCalled()
    })

    it('picks the clicked row of a filtered list without closing first', () => {
      const picker = mountPicker({ items: NESTED })

      search('bravo')
      click(itemFor('Bravo'))

      expect(picker.onPick).toHaveBeenCalledTimes(1)
      expect(picker.onPick).toHaveBeenCalledWith('b')
      expect(picker.onClose).not.toHaveBeenCalled()
      expect(picker.setGroupExpanded).not.toHaveBeenCalled()
    })

    it('clears the query on Escape and leaves closing to the menu', () => {
      const picker = mountPicker({ items: NESTED })

      search('zulu')
      const event = pressEscape()

      expect(event.defaultPrevented).toBe(true)
      expect(searchBox().value).toBe('')
      expect(listed(NESTED_TITLES)).toEqual(NESTED_TITLES)
      expect(picker.onClose).not.toHaveBeenCalled()
    })

    it('clears the query from the trailing button', () => {
      mountPicker({ items: NESTED })

      search('delta')
      expect(listed(NESTED_TITLES)).toEqual(['Delta'])

      const clear = clearButton()
      expect(clear).not.toBeNull()
      click(clear!)

      expect(searchBox().value).toBe('')
      expect(listed(NESTED_TITLES)).toEqual(NESTED_TITLES)
      expect(clearButton()).toBeNull()
      expect(document.activeElement).toBe(searchBox())
    })

    it('folds from the arrow while no query is set, without picking', () => {
      const picker = mountPicker({ items: NESTED })

      const arrow = arrowOf('Alpha')
      expect(arrow).toBeDefined()
      click(arrow!)

      expect(picker.setGroupExpanded).toHaveBeenCalledWith('a', false)
      expect(picker.onPick).not.toHaveBeenCalled()
    })
  })
})
