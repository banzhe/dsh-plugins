/**
 * Shared DOM fixtures and driving gestures for the workspace-menu specs.
 *
 * Everything here is built strictly from the README's DOM contract table, so a
 * DSH upgrade that moves the DOM must fail these tests.
 */

/** Await one macrotask so MutationObserver callbacks (and probe chains) run. */
export const flush = (): Promise<void> => new Promise(resolve => { setTimeout(resolve, 0) })

export interface WorkspaceRowFixture {
  readonly row: HTMLDivElement
  readonly trigger: HTMLButtonElement
  readonly other: HTMLButtonElement
}

export function appendWorkspaceRow(id: string): WorkspaceRowFixture {
  return appendRow(`workspace:${id}`)
}

export function appendUngroupedRow(): WorkspaceRowFixture {
  return appendRow('workspace:')
}

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

export function appendButtonlessRow(id: string): HTMLDivElement {
  const host = document.createElement('div')
  host.dataset.harnessRows = ''
  const row = document.createElement('div')
  row.dataset.rowKey = `workspace:${id}`
  host.append(row)
  document.body.append(host)
  return row
}

export interface MenuFixture {
  readonly menu: HTMLDivElement
  readonly presentation: HTMLElement
  readonly rename: HTMLDivElement
  readonly deleteRow: HTMLDivElement
  readonly renameLabel: string
  readonly deleteLabel: string
}

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

export function armPointer(target: EventTarget): void {
  target.dispatchEvent(new Event('pointerdown'))
}

export function armKey(target: EventTarget, key: string): void {
  target.dispatchEvent(new KeyboardEvent('keydown', { key }))
}

export function injectedButton(scope: ParentNode = document): HTMLButtonElement | null {
  return scope.querySelector('button[data-menu-actions="vscode"]')
}

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
