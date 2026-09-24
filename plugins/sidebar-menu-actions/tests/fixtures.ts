/**
 * Shared DOM fixtures and driving gestures for the workspace-menu specs.
 *
 * Everything here is built strictly from the README's DOM contract table:
 * real workspace title rows keyed `workspace:<id>`, a "..." trigger that is the
 * row's FIRST button (the second is New session, and the trigger may contain
 * nested elements), arming gestures (`pointerdown` on any target inside the
 * trigger, or `keydown` with `Enter`/`' '`), and a `role=menu` fixture whose
 * presentation viewport holds the rename row first and the danger delete row
 * last — each row carrying two spans (icon, label).
 */

/** Await one macrotask so MutationObserver callbacks (and probe chains) run. */
export const flush = (): Promise<void> => new Promise(resolve => { setTimeout(resolve, 0) })

/** A workspace title row plus its two buttons. */
export interface WorkspaceRowFixture {
  readonly row: HTMLDivElement
  /** The "..." trigger: the row's FIRST button. */
  readonly trigger: HTMLButtonElement
  /** The row's second button (the New session affordance). */
  readonly other: HTMLButtonElement
}

/**
 * Append one container holding a real workspace title row.
 * @param id - the workspace id after the `workspace:` prefix.
 * @returns the row and its buttons.
 */
export function appendWorkspaceRow(id: string): WorkspaceRowFixture {
  return appendRow(`workspace:${id}`)
}

/**
 * Append the ungrouped-bucket row: `data-row-key="workspace:"` with an empty
 * suffix, which the contract says carries no menu.
 * @returns the row and its buttons.
 */
export function appendUngroupedRow(): WorkspaceRowFixture {
  return appendRow('workspace:')
}

/**
 * Append one row host under body.
 * @param rowKey - the literal `data-row-key` value.
 * @returns the row and its buttons.
 */
function appendRow(rowKey: string): WorkspaceRowFixture {
  const host = document.createElement('div')
  host.dataset.harnessRows = ''
  const row = document.createElement('div')
  row.dataset.rowKey = rowKey
  const trigger = document.createElement('button')
  const nested = document.createElement('span')
  nested.textContent = '⋯'
  trigger.append(nested)
  const other = document.createElement('button')
  other.textContent = 'New session'
  row.append(trigger, other)
  host.append(row)
  document.body.append(host)
  return { row, trigger, other }
}

/**
 * Append a real workspace title row with no buttons at all.
 * @param id - the workspace id after the `workspace:` prefix.
 * @returns the bare row.
 */
export function appendButtonlessRow(id: string): HTMLDivElement {
  const host = document.createElement('div')
  host.dataset.harnessRows = ''
  const row = document.createElement('div')
  row.dataset.rowKey = `workspace:${id}`
  host.append(row)
  document.body.append(host)
  return row
}

/** The `role=menu` fixture: presentation viewport, rename row, delete row. */
export interface MenuFixture {
  readonly menu: HTMLDivElement
  readonly presentation: HTMLElement
  /** The first menu row: the rename template (className source). */
  readonly rename: HTMLDivElement
  /** The last menu row: the danger delete row (insertion anchor). */
  readonly deleteRow: HTMLDivElement
  readonly renameLabel: string
  readonly deleteLabel: string
}

/**
 * Build (but do not append) one contract-shaped menu fixture.
 * @returns the menu with two menuitem rows, each carrying icon + label spans.
 */
export function buildMenu(): MenuFixture {
  const menu = document.createElement('div')
  menu.setAttribute('role', 'menu')
  const presentation = document.createElement('div')
  presentation.setAttribute('role', 'presentation')
  menu.append(presentation)
  const rename = menuRow('row-rename', 'rename-glyph', 'Rename')
  const deleteRow = menuRow('row-delete', 'delete-glyph', 'Delete')
  presentation.append(rename, deleteRow)
  return {
    menu,
    presentation,
    rename,
    deleteRow,
    renameLabel: 'Rename',
    deleteLabel: 'Delete',
  }
}

/**
 * Build one menu row: wrapper div > button[role=menuitem] > (icon span, label span).
 * @param className - the wrapper's class, cloned by the injector onto its own row.
 * @param iconGlyph - plain text standing in for the original icon markup.
 * @param label - the row's label text.
 * @returns the wrapper div.
 */
function menuRow(className: string, iconGlyph: string, label: string): HTMLDivElement {
  const wrapper = document.createElement('div')
  wrapper.className = className
  const button = document.createElement('button')
  button.setAttribute('role', 'menuitem')
  const icon = document.createElement('span')
  icon.className = 'icon'
  icon.textContent = iconGlyph
  const text = document.createElement('span')
  text.className = 'label'
  text.textContent = label
  button.append(icon, text)
  wrapper.append(button)
  return wrapper
}

/**
 * Arm through the trigger with the pointer gesture (arbitrary key/shape).
 * @param target - the event target; any element the trigger contains qualifies.
 */
export function armPointer(target: EventTarget): void {
  target.dispatchEvent(new Event('pointerdown'))
}

/**
 * Arm through a keydown gesture.
 * @param target - the event target.
 * @param key - the key (`Enter` and `' '` arm; anything else must not).
 */
export function armKey(target: EventTarget, key: string): void {
  target.dispatchEvent(new KeyboardEvent('keydown', { key }))
}

/**
 * The injected VS Code row inside one menu.
 * @param scope - the menu (or document) to search.
 * @returns the injected menuitem button, or null when nothing was injected.
 */
export function injectedButton(scope: ParentNode = document): HTMLButtonElement | null {
  return scope.querySelector('button[data-menu-actions="vscode"]')
}

/**
 * Count menuitem rows inside one presentation viewport.
 * @param fixture - the menu whose viewport to count.
 * @returns the number of wrapper children.
 */
export function viewportRows(fixture: MenuFixture): number {
  return fixture.presentation.children.length
}

/** Record every keydown dispatched on document, for the Escape assertion. */
export function recordKeys(): { keys: string[]; stop: () => void } {
  const keys: string[] = []
  const listener = (event: Event): void => { keys.push((event as KeyboardEvent).key) }
  document.addEventListener('keydown', listener)
  return { keys, stop: () => { document.removeEventListener('keydown', listener) } }
}
