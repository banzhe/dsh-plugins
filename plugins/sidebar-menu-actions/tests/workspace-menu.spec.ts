// @vitest-environment jsdom
/**
 * `workspaceMenu.ts`'s observable contract, driven through the shared DOM
 * fixtures (README "DOM contract"). Most of the coverage here is the negative
 * side, because that is where the regressions live: which gestures and targets
 * must NOT arm, when the graft must NOT happen, and the guards that keep the
 * arm from leaking into another row's menu.
 *
 * The portal menu is appended straight to `document.body`, exactly as the Menu
 * primitive's portal does, so the observer reads the real mutation shape.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { en } from '../src/client/locales.ts'
import { injectMenuItem, installWorkspaceMenu, type WorkspaceMenuOptions } from '../src/client/workspaceMenu.ts'
import {
  appendButtonlessRow, appendUngroupedRow, appendWorkspaceRow, armKey, armPointer,
  buildMenu, flush, injectedButton, recordKeys, viewportRows,
  type MenuFixture, type WorkspaceRowFixture,
} from './fixtures.ts'
import { translateEn as t } from './translate.ts'

/** The workspace directory the default stub resolves; every other id misses. */
const PATHS: Record<string, string> = { 'ws-1': '/ws/alpha' }

interface OptionsFixture {
  readonly options: WorkspaceMenuOptions
  readonly showToast: ReturnType<typeof vi.fn>
}

function optionsFixture(paths: Record<string, string> = PATHS): OptionsFixture {
  const showToast = vi.fn()
  return {
    showToast,
    options: { t, pathOf: (workspaceId: string) => paths[workspaceId], showToast },
  }
}

let disposers: Array<() => void> = []

function install(paths?: Record<string, string>): OptionsFixture {
  const fixture = optionsFixture(paths)
  disposers.push(installWorkspaceMenu(fixture.options))
  return fixture
}

afterEach(() => {
  for (const dispose of disposers) dispose()
  disposers = []
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  document.head.innerHTML = ''
  document.body.innerHTML = ''
})

/** The injected VS Code row, or a failure when the graft did not happen. */
function injected(scope: ParentNode): HTMLButtonElement {
  const found = injectedButton(scope)
  if (found === null) throw new Error('no VS Code row was injected')
  return found
}

/** The nested content of one row's trigger — where a real pointer gesture lands. */
function nested(trigger: HTMLElement): HTMLElement {
  const found = trigger.querySelector<HTMLElement>('span')
  if (found === null) throw new Error('the row fixture lost its nested trigger content')
  return found
}

async function graft(workspaceId = 'ws-1'): Promise<{
  readonly row: WorkspaceRowFixture
  readonly menu: MenuFixture
  readonly button: HTMLButtonElement
}> {
  const row = appendWorkspaceRow(workspaceId)
  armPointer(row.trigger)
  const menu = buildMenu()
  document.body.append(menu.menu)
  await flush()
  return { row, menu, button: injected(menu.menu) }
}

/** Click one row and collect every keydown it dispatches on document. */
async function click(button: HTMLElement): Promise<string[]> {
  const keys = recordKeys()
  button.click()
  await flush()
  keys.stop()
  return keys.keys
}

describe('installWorkspaceMenu', () => {
  it('grafts nothing when a menu opens with no arm', async () => {
    install()
    const menu = buildMenu()
    document.body.append(menu.menu)
    await flush()
    expect(viewportRows(menu)).toBe(2)
    expect(injectedButton(menu.menu)).toBeNull()
  })

  it('arms from a pointerdown on content nested inside the trigger', async () => {
    install()
    const row = appendWorkspaceRow('ws-1')
    armPointer(nested(row.trigger))
    const menu = buildMenu()
    document.body.append(menu.menu)
    await flush()
    expect(viewportRows(menu)).toBe(3)
    expect(injectedButton(menu.menu)).not.toBeNull()
  })

  it('arms from the Enter key', async () => {
    install()
    const row = appendWorkspaceRow('ws-1')
    armKey(row.trigger, 'Enter')
    const menu = buildMenu()
    document.body.append(menu.menu)
    await flush()
    expect(viewportRows(menu)).toBe(3)
  })

  it('arms from the space key', async () => {
    install()
    const row = appendWorkspaceRow('ws-1')
    armKey(row.trigger, ' ')
    const menu = buildMenu()
    document.body.append(menu.menu)
    await flush()
    expect(viewportRows(menu)).toBe(3)
  })

  /**
   * Every gesture and target an open must refuse, one row per shape: what they
   * share is the guard that stops the arm from widening to a row, a key, or a
   * target it does not own. `install()` runs first, so each row arms against a
   * live observer.
   */
  const NON_ARMING: ReadonlyArray<readonly [label: string, arm: () => void]> = [
    ['any other key', () => { armKey(appendWorkspaceRow('ws-1').trigger, 'Tab') }],
    ['the row’s second button', () => { armPointer(appendWorkspaceRow('ws-1').other) }],
    ['a session row nested inside the workspace row', () => {
      const row = appendWorkspaceRow('ws-1')
      const session = document.createElement('div')
      session.dataset.rowKey = 'session:sess-9'
      const trigger = document.createElement('button')
      session.append(trigger)
      row.row.append(session)
      armPointer(trigger)
    }],
    ['a target outside any workspace row', () => { armPointer(document.body) }],
    ['a target that is not an element', () => { armPointer(document) }],
    ['the ungrouped bucket row', () => { armPointer(appendUngroupedRow().trigger) }],
    ['a workspace row with no buttons', () => { armPointer(appendButtonlessRow('ws-1')) }],
  ]

  it.each(NON_ARMING)('does not arm from %s', async (_label, arm) => {
    install()
    arm()
    const menu = buildMenu()
    document.body.append(menu.menu)
    await flush()
    expect(viewportRows(menu)).toBe(2)
  })

  it('keeps the arm while other body mutations pass and consumes it on the menu', async () => {
    install()
    const row = appendWorkspaceRow('ws-1')
    armPointer(row.trigger)
    document.body.append(document.createTextNode('noise'))
    document.body.append(document.createElement('div'))
    const menu = buildMenu()
    document.body.append(menu.menu)
    await flush()
    expect(viewportRows(menu)).toBe(3)
  })

  it('takes an open while the trigger still holds focus', async () => {
    install()
    const row = appendWorkspaceRow('ws-1')
    armPointer(row.trigger)
    row.trigger.focus()
    const menu = buildMenu()
    document.body.append(menu.menu)
    await flush()
    expect(document.activeElement).toBe(row.trigger)
    expect(injectedButton(menu.menu)).not.toBeNull()
  })

  it('takes an open while the body holds focus', async () => {
    install()
    const row = appendWorkspaceRow('ws-1')
    armPointer(row.trigger)
    const menu = buildMenu()
    document.body.append(menu.menu)
    await flush()
    expect(document.activeElement).toBe(document.body)
    expect(injectedButton(menu.menu)).not.toBeNull()
  })

  it('takes an open while focus sits inside the menu', async () => {
    install()
    const row = appendWorkspaceRow('ws-1')
    armPointer(row.trigger)
    const menu = buildMenu()
    document.body.append(menu.menu)
    const inside = menu.deleteRow.querySelector('button')
    if (inside === null) throw new Error('the menu fixture lost its delete row button')
    inside.focus()
    await flush()
    expect(document.activeElement).toBe(inside)
    expect(injectedButton(menu.menu)).not.toBeNull()
  })

  it('refuses an open raised while focus is somewhere else entirely', async () => {
    install()
    const decoy = document.createElement('button')
    document.body.append(decoy)
    const row = appendWorkspaceRow('ws-1')
    armPointer(row.trigger)
    decoy.focus()
    const menu = buildMenu()
    document.body.append(menu.menu)
    await flush()
    expect(document.activeElement).toBe(decoy)
    expect(viewportRows(menu)).toBe(2)
  })

  it('refuses an open whose trigger left the document', async () => {
    install()
    const row = appendWorkspaceRow('ws-1')
    armPointer(row.trigger)
    row.row.remove()
    const menu = buildMenu()
    document.body.append(menu.menu)
    await flush()
    expect(viewportRows(menu)).toBe(2)
    expect(injectedButton(menu.menu)).toBeNull()
  })

  it('removes both listeners and the observer with the disposer', async () => {
    const { options } = optionsFixture()
    installWorkspaceMenu(options)()
    const row = appendWorkspaceRow('ws-1')
    armPointer(row.trigger)
    const pointerMenu = buildMenu()
    document.body.append(pointerMenu.menu)
    await flush()
    expect(viewportRows(pointerMenu)).toBe(2)

    const keyed = appendWorkspaceRow('ws-2')
    armKey(keyed.trigger, 'Enter')
    const keyMenu = buildMenu()
    document.body.append(keyMenu.menu)
    await flush()
    expect(viewportRows(keyMenu)).toBe(2)
  })
})

describe('injectMenuItem', () => {
  it('grafts a clone of the rename row between rename and delete', async () => {
    install()
    const { menu, button } = await graft()
    expect(viewportRows(menu)).toBe(3)
    const wraps = [...menu.presentation.children]
    expect(wraps[0]).toBe(menu.rename)
    expect(wraps[2]).toBe(menu.deleteRow)
    expect(wraps[1]).toBe(button.parentElement)
    expect(wraps[1]?.className).toBe('row-rename')
    expect(button.getAttribute('role')).toBe('menuitem')
    expect(button.getAttribute('data-menu-actions')).toBe('vscode')
    expect(button.textContent).toBe(en['menu.openInVscode'])
    // The rename row's edit icon is gone, replaced by the inline glyph.
    expect(button.querySelector('span.icon')?.textContent).toBe('')
    expect(button.querySelector('svg path')?.getAttribute('d'))
      .toBe('M6 4.5 3 8l3 3.5M10 4.5 13 8l-3 3.5')
    // The shipped rows the clone was taken from stay untouched.
    expect(menu.rename.querySelectorAll('span')[0]?.textContent).toBe('rename-glyph')
    expect(menu.rename.querySelectorAll('span')[1]?.textContent).toBe(menu.renameLabel)
    expect(menu.deleteRow.querySelectorAll('span')[1]?.textContent).toBe(menu.deleteLabel)
  })

  it('does not double the row when the same menu is offered twice', async () => {
    const fixture = install()
    const { menu } = await graft()
    injectMenuItem(menu.menu, 'ws-1', fixture.options)
    expect(viewportRows(menu)).toBe(3)
    expect(menu.menu.querySelectorAll('button[data-menu-actions="vscode"]')).toHaveLength(1)
  })

  it('bails on a menu with no menuitem rows', () => {
    const { options } = optionsFixture()
    const menu = document.createElement('div')
    menu.setAttribute('role', 'menu')
    menu.append(document.createElement('div'))
    injectMenuItem(menu, 'ws-1', options)
    expect(menu.children).toHaveLength(1)
    expect(injectedButton(menu)).toBeNull()
  })

  it('opens the resolved directory in VS Code, then dismisses the menu', async () => {
    install()
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const { button } = await graft()
    const keys = await click(button)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock).toHaveBeenCalledWith('open-in-app/open', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ app: 'vscode', path: '/ws/alpha' }),
    })
    expect(keys).toEqual(['Escape'])
  })

  it('reports a non-2xx answer as an HTTP failure', async () => {
    const { showToast } = install()
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 503 })))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { button } = await graft()
    await click(button)
    expect(warn).toHaveBeenCalledWith('sidebar-menu-actions: open in VS Code failed:', 'HTTP 503')
    expect(showToast).toHaveBeenCalledWith(t('toast.vscodeFailed', { detail: 'HTTP 503' }))
  })

  it('reports a rejected request with the Error message', async () => {
    const { showToast } = install()
    vi.stubGlobal('fetch', vi.fn((): Promise<never> => Promise.reject(new Error('host offline'))))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { button } = await graft()
    await click(button)
    expect(warn).toHaveBeenCalledWith('sidebar-menu-actions: open in VS Code failed:', 'host offline')
    expect(showToast).toHaveBeenCalledWith(t('toast.vscodeFailed', { detail: 'host offline' }))
  })

  it('reports a non-Error rejection verbatim', async () => {
    const { showToast } = install()
    // The case is a non-Error rejection; that is the behavior under test.
    // oxlint-disable-next-line typescript/prefer-promise-reject-errors
    vi.stubGlobal('fetch', vi.fn((): Promise<never> => Promise.reject('nope')))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { button } = await graft()
    await click(button)
    expect(warn).toHaveBeenCalledWith('sidebar-menu-actions: open in VS Code failed:', 'nope')
    expect(showToast).toHaveBeenCalledWith(t('toast.vscodeFailed', { detail: 'nope' }))
  })

  it('issues no request and still dismisses a menu whose workspace is gone', async () => {
    const { showToast } = install()
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const { button } = await graft('ws-gone')
    const keys = await click(button)
    expect(fetchMock).not.toHaveBeenCalled()
    expect(keys).toEqual(['Escape'])
    expect(showToast).not.toHaveBeenCalled()
  })
})
