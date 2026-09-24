// @vitest-environment jsdom
/**
 * `CopySessionIdMenuItem` rendered through react-dom directly: the menuitem
 * button the primitives double materializes, the copy icon, the translated
 * label, and the click's two-step contract — close the row menu FIRST, then
 * copy the session id (asserted through `invocationCallOrder`).
 *
 * Rendered with `createElement`, never JSX: only `.tsx` doubles may use JSX in
 * this package (the vitest include matches only `.spec.ts` under `tests/`).
 */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CopySessionIdMenuItem } from '../src/client/CopySessionIdMenuItem.tsx'
import { zh } from '../src/client/locales.ts'
import { translateZh as t } from './translate.ts'

/**
 * The standard-kit props every slot component receives. The row ignores them,
 * but the composed props type requires them: ui-session and ui-workspace merge
 * `GlobalStandardProps` onto every slot key, so a fixture cast must supply all
 * four selectors or the component's own props type rejects the cast.
 */
const STANDARD_PROPS = {
  useSessions: (() => {}) as never,
  useSessionStatus: (() => {}) as never,
  useSessionRetainInfo: (() => {}) as never,
  useWorkspaces: (() => {}) as never,
}

const SESSION_ID = 'sess-42'

let roots: Root[] = []

// React only honors act() when it is told it runs in a test environment.
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

interface Harness {
  readonly setMenuOpen: ReturnType<typeof vi.fn>
  readonly copy: ReturnType<typeof vi.fn>
  button(): HTMLButtonElement
  click(): Promise<void>
}

/**
 * Mount the menu item over a controllable menu-state setter and copy face.
 * @returns the harness driving the mounted tree.
 */
async function mount(): Promise<Harness> {
  const setMenuOpen = vi.fn()
  const copy = vi.fn()
  const useMenuOpenState = (): readonly [boolean, (open: boolean) => void] => [true, setMenuOpen]
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  roots.push(root)
  await act(async () => {
    root.render(createElement(CopySessionIdMenuItem, {
      // The slot contract hands out a branded `SessionId`; this standalone
      // package does not declare `@deepseek-ai/dsh-session`, so the fixture
      // casts at the boundary exactly as STANDARD_PROPS does.
      sessionId: SESSION_ID as never,
      displayTitle: 'Alpha',
      useMenuOpenState,
      t,
      copy,
      ...STANDARD_PROPS,
    }))
  })
  const button = (): HTMLButtonElement => {
    const found = host.querySelector('button[role="menuitem"]')
    if (found === null) throw new Error('no menuitem button rendered')
    return found as HTMLButtonElement
  }
  return {
    setMenuOpen,
    copy,
    button,
    click: async (): Promise<void> => {
      await act(async () => { button().click() })
    },
  }
}

afterEach(() => {
  for (const root of roots) root.unmount()
  roots = []
  document.body.innerHTML = ''
  vi.clearAllMocks()
})

describe('CopySessionIdMenuItem', () => {
  it('renders a menuitem button with the copy icon and the translated label', async () => {
    const row = await mount()
    const button = row.button()
    expect(button).not.toBeNull()
    expect(button.querySelector('svg[data-icon="copy"]')).not.toBeNull()
    expect(button.textContent).toBe(zh['menu.copySessionId'])
  })

  it('closes the menu first, then copies the row’s session id', async () => {
    const row = await mount()
    await row.click()
    expect(row.setMenuOpen).toHaveBeenCalledTimes(1)
    expect(row.setMenuOpen).toHaveBeenCalledWith(false)
    expect(row.copy).toHaveBeenCalledTimes(1)
    expect(row.copy).toHaveBeenCalledWith(SESSION_ID)
    const [closeOrder] = row.setMenuOpen.mock.invocationCallOrder
    const [copyOrder] = row.copy.mock.invocationCallOrder
    expect(closeOrder).toBeDefined()
    expect(copyOrder).toBeDefined()
    expect(closeOrder!).toBeLessThan(copyOrder!)
  })
})
