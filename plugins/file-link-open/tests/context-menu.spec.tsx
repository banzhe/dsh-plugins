// @vitest-environment jsdom
/**
 * The always-mounted right-click menu: one root for the plugin's whole
 * lifetime, with open/close, the cursor, the target link, the viewed session's
 * CWD and the two app probes all arriving as React state.
 *
 * `react-dom/client` is mocked for exactly one reason: the spec counts how many
 * times the plugin builds its root and calls `render` on it. Everything else —
 * the Cordis context, the locale and slot doubles, the ui-primitives stand-in —
 * is the real wiring, so a regression back to "render the menu again on every
 * event" fails here instead of in the browser.
 */
import { Context } from '@deepseek-ai/cordis'
import { OPEN_IN_APP_APPS_ROUTE } from '@deepseek-ai/dsh-host-open-in-app/shared'
import * as React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { apply } from '../src/client.tsx'
import { INFO_ROUTE } from '../src/routes.ts'
import { LocaleDouble } from './locale-double.ts'
import { SlotsDouble } from './slots-double.ts'
import { clipboardWrites } from './ui-primitives-double.tsx'

// React only suppresses its "not configured to support act(...)" warning when
// this flag is set; without it every `act` call below logs a false alarm.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const { act } = React

interface Root {
  render(node: unknown): void
  unmount(): void
}

/** Root builds and `render` calls the plugin made, reset per spec. */
const counts = vi.hoisted<{ created: number, rendered: number }>(() => ({ created: 0, rendered: 0 }))

/** The real `createRoot`, so the spec's own roots stay out of the counters. */
const actuals = vi.hoisted<{ createRoot: ((container: Element) => Root) | null }>(() => ({ createRoot: null }))

vi.mock('react-dom/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-dom/client')>()
  actuals.createRoot = actual.createRoot as unknown as (container: Element) => Root
  return {
    ...actual,
    createRoot: (container: Element): Root => {
      counts.created += 1
      const root = actual.createRoot(container)
      return {
        render: (node: unknown) => {
          counts.rendered += 1
          root.render(node as never)
        },
        unmount: () => { root.unmount() },
      }
    },
  }
})

type FetchResult = { ok: boolean, status: number, json: () => Promise<unknown> }
type FetchImpl = (url: string) => Promise<unknown>

/** A fetch that answers each route once, 404 for the rest. */
function routesFetch(routes: Record<string, unknown>): FetchImpl {
  return async (url) => {
    const body = routes[url]
    return {
      ok: body !== undefined,
      status: body === undefined ? 404 : 200,
      json: async () => body ?? null,
    } satisfies FetchResult
  }
}

/** A fetch that stays pending until the spec answers each route, as a slow host does. */
function deferredFetch() {
  const pending = new Map<string, (body: unknown) => void>()
  const impl: FetchImpl = url => new Promise((resolve) => {
    pending.set(url, (body) => {
      resolve({
        ok: body !== undefined,
        status: body === undefined ? 404 : 200,
        json: async () => body ?? null,
      } satisfies FetchResult)
    })
  })
  const respond = async (url: string, body: unknown): Promise<void> => {
    const settle = pending.get(url)
    if (settle === undefined) throw new Error(`no pending fetch for ${url}`)
    pending.delete(url)
    await act(async () => { settle(body) })
  }
  return { impl, respond }
}

interface Bench {
  readonly slots: SlotsDouble
  dispose(): void
}

const benches: Bench[] = []
const extraRoots: { root: Root, container: HTMLElement }[] = []

/** Boot the browser half over a real Cordis context plus the three doubles. */
async function bench(fetchImpl: FetchImpl = routesFetch({})): Promise<Bench> {
  vi.stubGlobal('fetch', vi.fn(fetchImpl))
  const ctx = new Context()
  ctx.provide('locale', new LocaleDouble() as never)
  const slots = new SlotsDouble(ctx)
  let dispose: () => void = () => {}
  await act(async () => {
    dispose = apply(ctx)
  })
  const handle: Bench = { slots, dispose }
  benches.push(handle)
  return handle
}

const CONTEXT_CONTAINER = '[data-flo-context]'
const MENU = '[data-test-menu]'
const MENU_STATE = '[data-test-menu-state]'

function contextContainer(): HTMLElement | null {
  return document.querySelector<HTMLElement>(CONTEXT_CONTAINER)
}

function menu(): HTMLElement | null {
  return document.querySelector<HTMLElement>(MENU)
}

function menuState(): string | null {
  return document.querySelector<HTMLElement>(MENU_STATE)?.dataset.testMenuState ?? null
}

function menuRows(): (string | null)[] {
  return [...document.querySelectorAll<HTMLElement>('[data-test-menu-item]')]
    .map(row => row.dataset.testMenuItem ?? null)
}

function menuItem(id: string): HTMLElement {
  const row = document.querySelector<HTMLElement>(`[data-test-menu-item="${id}"]`)
  if (row === null) throw new Error(`no menu row "${id}"`)
  return row
}

/** The official renderer's file link, as the target walk sees one. */
function fileLink(path: string): HTMLButtonElement {
  const button = document.createElement('button')
  button.type = 'button'
  button.className = 'md_fileMention md_fileLink'
  button.title = path
  button.textContent = path
  document.body.appendChild(button)
  return button
}

/** A link whose line rides the same fiber prop the official renderer puts it on. */
function withLine(button: HTMLButtonElement, path: string, line: number): HTMLButtonElement {
  ;(button as unknown as Record<string, unknown>)['__reactFiber$spec'] = {
    memoizedProps: { file: { path, line } },
    return: null,
  }
  return button
}

async function rightClick(target: Element, x: number, y: number): Promise<void> {
  await act(async () => {
    target.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: x, clientY: y }))
  })
}

async function click(target: Element): Promise<void> {
  await act(async () => { (target as HTMLElement).click() })
}

interface RecorderProps {
  sessionId: string
  useSessions: (selector: (sessionState: { byId: Record<string, { cwd?: string }> }) => string | undefined) => string | undefined
}

interface Recorder {
  /** Publish the viewed session's cwd, as the host's session store would. */
  publish(cwd: string | undefined): Promise<void>
  unmount(): Promise<void>
}

/**
 * Mount the plugin's own header cell (the registration it made on the slot
 * double) and drive the CWD the host would publish through its standard props.
 */
async function mountRecorder(b: Bench): Promise<Recorder> {
  const Cell = b.slots.entry('file-link-open').component as React.FunctionComponent<RecorderProps>
  const createRoot = actuals.createRoot
  if (createRoot === null) throw new Error('react-dom/client was never loaded')
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  extraRoots.push({ root, container })
  let byId: Record<string, { cwd?: string }> = {}
  const useSessions: RecorderProps['useSessions'] = selector => selector({ byId })
  const draw = async (cwd: string | undefined): Promise<void> => {
    byId = cwd === undefined ? {} : { 'sess-1': { cwd } }
    await act(async () => {
      root.render(React.createElement(Cell, { sessionId: 'sess-1', useSessions }))
    })
  }
  await draw(undefined)
  return {
    publish: draw,
    unmount: async () => {
      await act(async () => { root.unmount() })
      container.remove()
    },
  }
}

beforeEach(() => {
  counts.created = 0
  counts.rendered = 0
})

afterEach(async () => {
  const open = benches.splice(0, benches.length)
  for (const b of open) {
    await act(async () => { b.dispose() })
  }
  const roots = extraRoots.splice(0, extraRoots.length)
  for (const { root, container } of roots) {
    await act(async () => { root.unmount() })
    container.remove()
  }
  clipboardWrites.length = 0
  document.body.innerHTML = ''
  vi.unstubAllGlobals()
})

describe('mounted context menu', () => {
  it('builds its one root at activation and starts closed', async () => {
    await bench()
    expect(counts).toEqual({ created: 1, rendered: 1 })
    expect(contextContainer()).not.toBeNull()
    expect(menuState()).toBe('closed')
    expect(menu()).toBeNull()
  })

  it('opens at the cursor on the right-clicked link, still on that one root', async () => {
    await bench(routesFetch({
      [OPEN_IN_APP_APPS_ROUTE]: { apps: ['vscode', 'explorer'] },
      [INFO_ROUTE]: { available: ['vscode'] },
    }))
    const button = fileLink('src/a.ts')
    await rightClick(button, 120, 240)

    expect(menuState()).toBe('open')
    const panel = menu()
    expect(panel).not.toBeNull()
    // The rect handed to Menu is the cursor the plugin stored.
    expect(panel?.dataset.testMenuX).toBe('120')
    expect(panel?.dataset.testMenuY).toBe('240')
    // The app probes ride the same state: this session's probes answered them.
    expect(menuRows()).toEqual(['flo:fm:explorer', 'flo:app:vscode', 'flo:copy-rel', 'flo:copy-abs'])
    expect(counts).toEqual({ created: 1, rendered: 1 })
  })

  it('names the target line in a heading row when the link carried one', async () => {
    await bench()
    await rightClick(withLine(fileLink('src/a.ts'), 'src/a.ts', 24), 10, 20)
    const heading = document.querySelector<HTMLElement>('[data-test-menu-label="flo:line"]')
    expect(heading?.textContent).toBe('Line 24')
    expect(counts.rendered).toBe(1)
  })

  it('closes on the menu\'s own onClose, still on that one root', async () => {
    await bench()
    await rightClick(fileLink('src/a.ts'), 30, 40)
    expect(menuState()).toBe('open')

    await click(document.querySelector('[data-test-menu-close]') as HTMLElement)
    expect(menuState()).toBe('closed')
    expect(menu()).toBeNull()
    expect(counts).toEqual({ created: 1, rendered: 1 })
    // The stored target survives the close, so a second open re-anchors from
    // fresh coordinates rather than a rebuilt tree.
    await rightClick(fileLink('src/b.ts'), 50, 60)
    expect(menu()?.dataset.testMenuX).toBe('50')
    expect(counts).toEqual({ created: 1, rendered: 1 })
  })

  it('closes on selection and copies the path it resolved', async () => {
    await bench()
    await rightClick(fileLink('src/a.ts'), 5, 6)
    await click(menuItem('flo:copy-rel'))

    expect(menuState()).toBe('closed')
    expect(clipboardWrites).toEqual(['src/a.ts'])
    expect(counts.rendered).toBe(1)
  })

  it('takes the viewed session\'s CWD as state, and keeps the menu open under it', async () => {
    const b = await bench()
    const recorder = await mountRecorder(b)
    const button = fileLink('src/a.ts')
    await rightClick(button, 70, 80)

    await recorder.publish('/work/demo')
    // A CWD change is not a dismiss: the open menu stays open, re-anchored.
    expect(menuState()).toBe('open')

    await click(menuItem('flo:copy-abs'))
    expect(clipboardWrites).toEqual(['/work/demo/src/a.ts'])
    expect(menuState()).toBe('closed')
    expect(counts).toEqual({ created: 1, rendered: 1 })
  })

  it('recomputes its rows when an app probe lands while the menu is open', async () => {
    const probe = deferredFetch()
    await bench(probe.impl)
    await rightClick(fileLink('src/a.ts'), 1, 2)
    // Nothing has answered yet: only the two path rows are offerable.
    expect(menuRows()).toEqual(['flo:copy-rel', 'flo:copy-abs'])

    await probe.respond(OPEN_IN_APP_APPS_ROUTE, { apps: ['vscode', 'explorer'] })
    await probe.respond(INFO_ROUTE, { available: ['vscode'] })

    expect(menuRows()).toEqual(['flo:fm:explorer', 'flo:app:vscode', 'flo:copy-rel', 'flo:copy-abs'])
    expect(counts).toEqual({ created: 1, rendered: 1 })
  })

  it('leaves the native menu for a right-click that names no file link', async () => {
    await bench()
    const paragraph = document.createElement('p')
    paragraph.textContent = 'plain text'
    document.body.appendChild(paragraph)
    await rightClick(paragraph, 3, 4)
    expect(menu()).toBeNull()
    expect(counts.rendered).toBe(1)
  })

  it('unmounts its root and takes the container away on dispose', async () => {
    const b = await bench()
    await rightClick(fileLink('src/a.ts'), 9, 9)
    const container = contextContainer()
    await act(async () => { b.dispose() })
    benches.splice(benches.indexOf(b), 1)

    expect(contextContainer()).toBeNull()
    expect(container?.isConnected).toBe(false)
    // A right-click after unload reaches nothing at all.
    await rightClick(fileLink('src/b.ts'), 1, 1)
    expect(menu()).toBeNull()
    expect(counts).toEqual({ created: 1, rendered: 1 })
  })
})
