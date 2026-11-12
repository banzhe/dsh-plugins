// @vitest-environment jsdom
/**
 * The wiring this plugin contributes: ONE entry into the official file
 * context menu (its id, target and order), the keyed icon renderer its rows
 * point at, and the probe round behind both.
 *
 * The Cordis context is real; the `slots`, `contextMenus` and `sessions`
 * services are doubles, so the spec can inspect exactly what was registered,
 * resolve it on demand, and drive each Session's workspace root. The rows
 * themselves are `tests/actions.spec.ts`'s subject.
 */
import { Context } from '@deepseek-ai/cordis'
import { OPEN_IN_APP_APPS_ROUTE } from '@deepseek-ai/dsh-host-open-in-app/shared'
import { act, createElement, type FunctionComponent } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { apply, inject } from '../src/client.tsx'
import { APP_ICON_KEY } from '../src/client/actions.ts'
import { INFO_ROUTE, LAUNCH_ROUTE } from '../src/routes.ts'
import { ContextMenusDouble } from './context-menus-double.ts'
import { LocaleDouble } from './locale-double.ts'
import { SessionsDouble } from './sessions-double.ts'
import { SlotsDouble } from './slots-double.ts'
import { clipboard, clipboardWrites } from './ui-primitives-double.tsx'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const SESSION = 'sess-1'
const CWD = '/work/demo'

/** One canned answer; a route the spec never listed answers 404. */
interface Answer {
  readonly status: number
  readonly body: unknown
}

interface Call {
  readonly url: string
  readonly init?: RequestInit
}

/** The parsed JSON body of a posted call; the rows always post a JSON string. */
function bodyOf(call: Call): unknown {
  const raw = call.init?.body
  return typeof raw === 'string' ? (JSON.parse(raw) as unknown) : null
}

interface Bench {
  readonly slots: SlotsDouble
  readonly menus: ContextMenusDouble
  readonly sessions: SessionsDouble
  /** Live answers; a spec may add one to model a host that recovers. */
  readonly answers: Record<string, Answer>
  /** Every fetch the plugin made, in order. */
  readonly calls: Call[]
  /** Bodies posted to one route, parsed. */
  readonly posts: (url: string) => unknown[]
  dispose(): void
}

const benches: Bench[] = []
const roots: { root: Root, container: HTMLElement }[] = []

const OK = (body: unknown): Answer => ({ status: 200, body })

/** Boot the browser half over a real Cordis context plus the service doubles. */
async function bench(answers: Record<string, Answer> = {}): Promise<Bench> {
  const calls: Call[] = []
  const live = { ...answers }
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    calls.push(init === undefined ? { url } : { url, init })
    const answer = live[url]
    if (answer === undefined) return { ok: false, status: 404, json: async () => null } as unknown as Response
    return {
      ok: answer.status >= 200 && answer.status < 300,
      status: answer.status,
      json: async () => answer.body,
    } as unknown as Response
  }))
  const ctx = new Context()
  ctx.provide('locale', new LocaleDouble() as never)
  const sessions = new SessionsDouble()
  sessions.setCwd(SESSION, CWD)
  ctx.provide('sessions', sessions as never)
  const slots = new SlotsDouble(ctx)
  const menus = new ContextMenusDouble(ctx)
  apply(ctx)
  const handle: Bench = {
    slots,
    menus,
    sessions,
    answers: live,
    calls,
    posts: (url) => calls
      .filter(call => call.url === url && call.init?.method === 'POST')
      .map(bodyOf),
    dispose: () => { void ctx.fiber.dispose() },
  }
  benches.push(handle)
  // Let the activation probe settle before a test reads the calls.
  await act(async () => { await Promise.resolve() })
  return handle
}

/** The rows for one clicked destination, as the registry would ask for them. */
async function rowsFor(b: Bench, target: { path: string, line?: number, sessionId?: string }) {
  return await b.menus.resolve('file-link-open', { sessionId: SESSION, ...target })
}

const ids = (rows: readonly { id: string }[]): string[] => rows.map(entry => entry.id)

/** One row; throws so a spec cannot silently pass against a missing row. */
function row(rows: readonly { id: string, run?: () => void | Promise<void> }[], id: string) {
  const found = rows.find(candidate => candidate.id === id)
  if (found === undefined) throw new Error(`no row "${id}"`)
  return found
}

const APPS_ANSWER = OK({ apps: ['vscode', 'cursor', 'explorer'] })
const INFO_ANSWER = OK({ available: ['vscode', 'cursor'] })
const ANSWERS = {
  [OPEN_IN_APP_APPS_ROUTE]: APPS_ANSWER,
  [INFO_ROUTE]: INFO_ANSWER,
  [LAUNCH_ROUTE]: OK({ ok: true }),
}

beforeEach(() => {
  clipboard.accepts = true
  clipboardWrites.length = 0
})

afterEach(async () => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  const open = roots.splice(0, roots.length)
  for (const entry of open) {
    await act(async () => { entry.root.unmount() })
    entry.container.remove()
  }
  const live = benches.splice(0, benches.length)
  for (const b of live) b.dispose()
})

describe('contribution', () => {
  it('waits on the locale, slot, context-menu and sessions services', async () => {
    await bench()
    expect(inject).toEqual(['locale', 'slots', 'contextMenus', 'sessions'])
  })

  it('registers ONE file menu contribution under the plugin id', async () => {
    const b = await bench()
    expect(b.menus.contribution('file-link-open')).toMatchObject({
      id: 'file-link-open', target: 'file', order: 200,
    })
  })

  it('registers only its icon renderer on the official slots', async () => {
    const b = await bench()
    expect(b.slots.entry(APP_ICON_KEY).options).toMatchObject({
      name: 'contextMenu.icon', key: APP_ICON_KEY,
    })
    expect(b.slots.injectKeys()).toEqual(['contextMenu.icon'])
  })
})

describe('resolution', () => {
  it('reads both app probes once per plugin life', async () => {
    const b = await bench(ANSWERS)
    await rowsFor(b, { path: 'src/a.ts' })
    await rowsFor(b, { path: 'src/a.ts' })
    expect(b.calls.map(call => call.url)).toEqual([OPEN_IN_APP_APPS_ROUTE, INFO_ROUTE])
    expect(b.calls.map(call => call.init?.headers)).toEqual([
      { accept: 'application/json' },
      { accept: 'application/json' },
    ])
  })

  it('builds the editor rows from both probe answers, and no row the official menu owns', async () => {
    const b = await bench(ANSWERS)
    const rows = await rowsFor(b, { path: 'src/a.ts', line: 24 })
    expect(ids(rows)).toEqual(['line', 'app:vscode', 'app:cursor', 'copy-rel'])
  })

  it('offers the copy row alone when the host answers neither route', async () => {
    const b = await bench()
    const rows = await rowsFor(b, { path: 'src/a.ts' })
    expect(ids(rows)).toEqual(['copy-rel'])
  })

  it('shares one probe round between openings that ask at the same time', async () => {
    const b = await bench(ANSWERS)
    const before = b.calls.length
    await Promise.all([rowsFor(b, { path: 'src/a.ts' }), rowsFor(b, { path: 'src/b.ts' })])
    expect(b.calls.length).toBe(before)
  })

  it('asks again after a round that could not answer, so a retry shows the rows', async () => {
    const b = await bench()
    expect(ids(await rowsFor(b, { path: 'src/a.ts' }))).toEqual(['copy-rel'])
    Object.assign(b.answers, ANSWERS)
    expect(ids(await rowsFor(b, { path: 'src/a.ts' }))).toEqual(['app:vscode', 'app:cursor', 'copy-rel'])
    // Activation, the failed opening, and the retry — three rounds, none shared.
    expect(b.calls.filter(call => call.url === OPEN_IN_APP_APPS_ROUTE)).toHaveLength(3)
  })

  it('refuses to build rows for an aborted occurrence', async () => {
    const b = await bench(ANSWERS)
    const controller = new AbortController()
    controller.abort()
    await expect(b.menus.contribution('file-link-open').resolve({ sessionId: SESSION, path: 'src/a.ts' }, controller.signal))
      .rejects.toThrow(/abort/i)
  })
})

describe('row execution', () => {
  it('posts the launch with the Session-absolute path and the named line', async () => {
    const b = await bench(ANSWERS)
    const rows = await rowsFor(b, { path: 'src/a.ts', line: 24 })
    await act(async () => { await row(rows, 'app:vscode').run?.() })
    expect(b.posts(LAUNCH_ROUTE)).toEqual([{ app: 'vscode', path: '/work/demo/src/a.ts', line: 24 }])
  })

  it('resolves each Session against its own workspace root', async () => {
    const b = await bench(ANSWERS)
    b.sessions.setCwd('sess-2', '/work/other')
    await act(async () => { await row(await rowsFor(b, { path: 'src/a.ts' }), 'app:vscode').run?.() })
    await act(async () => { await row(await rowsFor(b, { path: 'src/a.ts', sessionId: 'sess-2' }), 'app:vscode').run?.() })
    expect(b.posts(LAUNCH_ROUTE)).toEqual([
      { app: 'vscode', path: '/work/demo/src/a.ts' },
      { app: 'vscode', path: '/work/other/src/a.ts' },
    ])
  })

  it('copies the workspace-relative path', async () => {
    const b = await bench(ANSWERS)
    const rows = await rowsFor(b, { path: 'src/a.ts', line: 24 })
    await act(async () => { await row(rows, 'copy-rel').run?.() })
    expect(clipboardWrites).toEqual(['src/a.ts'])
  })

  it('rejects a refused launch so the shared menu reports it', async () => {
    const b = await bench({ ...ANSWERS, [LAUNCH_ROUTE]: { status: 502, body: { code: 'launch-failed' } } })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const rows = await rowsFor(b, { path: 'src/a.ts', line: 24 })
    await expect(row(rows, 'app:vscode').run?.()).rejects.toThrow('502')
    expect(warn).toHaveBeenCalledTimes(1)
  })

  it('rejects a refused clipboard write so the shared menu reports it', async () => {
    const b = await bench(ANSWERS)
    clipboard.accepts = false
    const rows = await rowsFor(b, { path: 'src/a.ts' })
    await expect(row(rows, 'copy-rel').run?.()).rejects.toThrow(/clipboard/)
  })
})

describe('row icon', () => {
  async function renderIcon(icon: { key: string, src?: string }): Promise<HTMLElement> {
    const b = benches[0]
    if (b === undefined) throw new Error('no bench')
    const Icon = b.slots.entry(APP_ICON_KEY).component as FunctionComponent<{ icon: { key: string, src?: string } }>
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    roots.push({ root, container })
    await act(async () => { root.render(createElement(Icon, { icon })) })
    return container
  }

  it('renders the application image the row named', async () => {
    await bench()
    const container = await renderIcon({ key: APP_ICON_KEY, src: 'open-in-app/icon/vscode' })
    expect(container.querySelector('img')?.getAttribute('src')).toBe('open-in-app/icon/vscode')
  })

  it('falls back to the native-open glyph when the image fails', async () => {
    await bench()
    const container = await renderIcon({ key: APP_ICON_KEY, src: 'open-in-app/icon/vscode' })
    const img = container.querySelector('img')
    if (img === null) throw new Error('no image')
    await act(async () => { img.dispatchEvent(new Event('error')) })
    expect(container.querySelector('img')).toBeNull()
    expect(container.querySelector('[data-test-icon-fallback]')).not.toBeNull()
  })

  it('falls back immediately when no image was named', async () => {
    await bench()
    const container = await renderIcon({ key: APP_ICON_KEY })
    expect(container.querySelector('img')).toBeNull()
    expect(container.querySelector('[data-test-icon-fallback]')).not.toBeNull()
  })
})
