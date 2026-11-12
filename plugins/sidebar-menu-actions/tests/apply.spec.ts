// @vitest-environment jsdom
/**
 * `apply` driven through a REAL Cordis context: the plugin's own `inject` list,
 * its fiber lifetime, and the four services it reads (service doubles, a real
 * `Context`). Every assertion here is an observable of the sealed contract —
 * one workspace contribution, its rows for a host app catalog, what a clicked
 * row does to the Host and the clipboard, one notice per failure, and what the
 * unload withdraws.
 *
 * No DOM and no popup lifecycle: the shell owns menu presentation and dismissal.
 */
import { Context, Service } from '@deepseek-ai/cordis'
import type { MenuAction } from '@deepseek-ai/dsh-client-ui-context-menu/client'
import * as primitives from '@deepseek-ai/dsh-client-ui-primitives'
import { createElement, type ComponentType } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { apply, inject } from '../src/client/index.ts'
import { CATALOG_FAILURE_LOG, missingAppLog } from '../src/client/probe.ts'
import { CONTRIBUTION_ID, CONTRIBUTION_ORDER } from '../src/client/workspace-actions.ts'
import { ContextMenusDouble } from './context-menus-double.ts'
import { LocaleDouble, type LocaleDicts } from './locale-double.ts'
import { SlotsDouble } from './slots-double.ts'
import { translateEn } from './translate.ts'
import { workspacesDouble, type WorkspaceItem } from './workspaces-double.ts'

const CATALOG = 'open-in-app/apps'
const LAUNCH = 'open-in-app/open'
const ICON_SLOT = 'contextMenu.icon'
const ICON_KEYS = [
  'sidebar-menu-actions.vscode',
  'sidebar-menu-actions.explorer',
  'sidebar-menu-actions.copy-path',
] as const
const DICTIONARY_KEYS = [
  'menu.openInVscode',
  'menu.openInFileBrowser',
  'menu.copyWorkspacePath',
  'toast.pathCopied',
  'toast.copyFailed',
  'toast.vscodeFailed',
  'toast.fileBrowserFailed',
] as const

/** The captured menu target: `path` is what the row saw when the menu opened. */
const TARGET = { workspaceId: 'w1', path: '/repo/captured', displayTitle: 'one' }
const ITEMS: readonly WorkspaceItem[] = [{ workspaceId: 'w1', path: '/repo/live' }]

/**
 * `LocaleDouble` behind a Service, so the registration rides the caller's
 * context like the real service does. The disposer it returns is deliberately
 * NOT wrapped in an effect: withholding the dictionary is the plugin's own
 * cleanup, and the double must not perform it on the plugin's behalf.
 */
class LocaleService extends Service {
  private readonly dicts = new LocaleDouble()

  constructor(ctx: Context) {
    super(ctx, 'locale')
  }

  register(ns: string, dicts: LocaleDicts): () => void {
    return this.dicts.register(ns, dicts)
  }

  bind(ns: string): (key: string, params?: Record<string, unknown>) => string {
    return this.dicts.bind(ns)
  }

  /** What the `menu-actions` namespace resolves right now. */
  menuActionsText(key: string): string {
    return this.dicts.bind('menu-actions')(key)
  }
}

interface FakeResponse {
  readonly ok: boolean
  readonly status: number
  readonly json: () => Promise<unknown>
}

function answer(payload: unknown, status = 200): FakeResponse {
  return { ok: status >= 200 && status < 300, status, json: async () => payload }
}

/** One route's answer: a response, a never-answering request, or a rejection. */
type Planned = FakeResponse | 'pending' | { readonly thrown: unknown }

interface FetchPlan {
  readonly catalog?: Planned | undefined
  readonly launch?: Planned | undefined
}

interface FetchCall {
  readonly url: string
  readonly init: RequestInit | undefined
}

/** Route the Host's two routes; anything else is a bug in the plugin. */
function stubFetch(plan: FetchPlan): FetchCall[] {
  const calls: FetchCall[] = []
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init })
    const planned = url === CATALOG ? plan.catalog : url === LAUNCH ? plan.launch : undefined
    if (planned === undefined) throw new Error('unexpected fetch: ' + url)
    if (planned === 'pending') return new Promise<FakeResponse>(() => {})
    if ('thrown' in planned) throw planned.thrown
    return planned
  }))
  return calls
}

function stubCatalog(apps: readonly string[] = ['vscode', 'explorer']): FetchCall[] {
  return stubFetch({ catalog: answer({ apps }) })
}

interface Harness {
  readonly menus: ContextMenusDouble
  readonly locale: LocaleService
  readonly slots: SlotsDouble
  readonly dispose: () => Promise<void>
  readonly logged: () => readonly string[]
}

function provideService(ctx: Context, name: string, value: unknown): void {
  const loose = ctx as unknown as { provide(name: string, value: unknown): () => void }
  loose.provide(name, value)
}

async function start(items: readonly WorkspaceItem[] = ITEMS): Promise<Harness> {
  const ctx = new Context()
  const logged: string[] = []
  ctx.logger.exporter({
    export: (message) => {
      if (message.type === 'warn' || message.type === 'error') {
        logged.push(message.args.map(argument => String(argument)).join(' '))
      }
    },
  })
  const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
  const menus = new ContextMenusDouble(ctx)
  const locale = new LocaleService(ctx)
  const slots = new SlotsDouble(ctx)
  provideService(ctx, 'workspaces', workspacesDouble(items))
  const fiber = ctx.plugin({ inject: [...inject], apply })
  await fiber.await()
  return {
    menus,
    locale,
    slots,
    dispose: async () => { await fiber.dispose() },
    logged: () => [
      ...logged,
      ...consoleWarn.mock.calls.map(call => call.map(argument => String(argument)).join(' ')),
      ...consoleError.mock.calls.map(call => call.map(argument => String(argument)).join(' ')),
    ],
  }
}

interface WorkspaceTarget {
  readonly workspaceId: string
  readonly path: string
  readonly displayTitle: string
}

async function rowsOf(harness: Harness, target: WorkspaceTarget = TARGET): Promise<readonly MenuAction[]> {
  const contribution = harness.menus.contribution(CONTRIBUTION_ID)
  return await contribution.resolve(target, new AbortController().signal)
}

function actionOf(rows: readonly MenuAction[], id: string): MenuAction {
  const found = rows.find(row => row.id === id)
  if (found === undefined) throw new Error('no action ' + id + ' among ' + rows.map(row => row.id).join(', '))
  return found
}

function headerValue(init: RequestInit | undefined, name: string): string | undefined {
  const headers = init?.headers
  if (headers === undefined) return undefined
  const asHeaders = headers as Headers
  if (typeof asHeaders.get === 'function') return asHeaders.get(name) ?? undefined
  if (Array.isArray(headers)) {
    const pair = (headers as readonly (readonly string[])[]).find(entry => entry[0]?.toLowerCase() === name)
    return pair?.[1]
  }
  const record = headers as Record<string, string | undefined>
  const key = Object.keys(record).find(candidate => candidate.toLowerCase() === name)
  return key === undefined ? undefined : record[key]
}

function bodyOf(call: FetchCall | undefined): unknown {
  const body = call?.init?.body
  return typeof body === 'string' ? JSON.parse(body) : undefined
}

/** Recover the `{detail}` a translate template interpolated, so no copy is duplicated here. */
function detailOf(template: string, text: string): string | undefined {
  const marker = '{detail}'
  const at = template.indexOf(marker)
  if (at < 0) return undefined
  const prefix = template.slice(0, at)
  const suffix = template.slice(at + marker.length)
  if (!text.startsWith(prefix) || !text.endsWith(suffix)) return undefined
  return text.slice(prefix.length, text.length - suffix.length)
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('the published wiring', () => {
  it('declares the four services it reads', () => {
    expect([...inject]).toEqual(['workspaces', 'locale', 'slots', 'contextMenus'])
  })

  it('contributes exactly one workspace menu', async () => {
    stubCatalog()
    const harness = await start()
    expect(harness.menus.live.map(contribution => contribution.id)).toEqual([CONTRIBUTION_ID])
    const contribution = harness.menus.contribution(CONTRIBUTION_ID)
    expect(contribution.id).toBe('sidebar-menu-actions.workspace')
    expect(contribution.order).toBe(CONTRIBUTION_ORDER)
    expect(contribution.order).toBe(110)
    expect(contribution.target).toBe('workspace')
  })

  it('contributes each action icon as its own keyed contextMenu.icon entry', async () => {
    stubCatalog()
    const harness = await start()
    const icons = harness.slots.entriesOf(ICON_SLOT)
    expect(icons.map(icon => icon.key)).toEqual([...ICON_KEYS])
    expect(new Set(harness.slots.injections)).toEqual(new Set([ICON_SLOT]))
    expect(new Set(icons.map(icon => icon.dispose)).size).toBe(ICON_KEYS.length)
  })

  it('renders each contributed icon as an aria-hidden SVG glyph', async () => {
    stubCatalog()
    const harness = await start()
    const glyphs = harness.slots.entriesOf(ICON_SLOT).map(icon =>
      renderToStaticMarkup(createElement(icon.component as ComponentType<Record<string, never>>, {})))
    expect(glyphs).toHaveLength(ICON_KEYS.length)
    for (const glyph of glyphs) {
      expect(glyph).toContain('<svg')
      expect(glyph).toContain('aria-hidden="true"')
    }
  })

  it('registers the menu-actions dictionary and withdraws it on unload', async () => {
    stubCatalog()
    const harness = await start()
    for (const key of DICTIONARY_KEYS) {
      expect(harness.locale.menuActionsText(key)).toBe(translateEn(key))
    }
    await harness.dispose()
    for (const key of DICTIONARY_KEYS) {
      expect(harness.locale.menuActionsText(key)).toBe(key)
    }
  })

  it('withdraws the contribution and every icon entry on unload', async () => {
    stubCatalog()
    const harness = await start()
    expect(harness.menus.live).toHaveLength(1)
    expect(harness.slots.entriesOf(ICON_SLOT).map(icon => icon.key)).toEqual([...ICON_KEYS])
    await harness.dispose()
    expect(harness.menus.live).toHaveLength(0)
    expect(() => harness.menus.contribution(CONTRIBUTION_ID)).toThrow()
    expect(harness.slots.live).toHaveLength(0)
    for (const key of ICON_KEYS) expect(harness.slots.entryOf(ICON_SLOT, key)).toBeUndefined()
  })
})

describe('the rows a workspace menu offers', () => {
  it('offers the rows the host lists, then copy', async () => {
    stubCatalog()
    const harness = await start()
    const rows = await rowsOf(harness)
    expect(rows.map(row => row.id)).toEqual(['vscode', 'explorer', 'copy-path'])
    expect(rows.map(row => row.icon?.key)).toEqual([...ICON_KEYS])
    expect(rows.map(row => row.label)).toEqual([
      translateEn('menu.openInVscode'),
      translateEn('menu.openInFileBrowser'),
      translateEn('menu.copyWorkspacePath'),
    ])
    expect(rows.every(row => row.failureLabel === undefined)).toBe(true)
  })

  it('omits a launch row the host does not list, and says so once', async () => {
    stubCatalog(['vscode'])
    const harness = await start()
    const rows = await rowsOf(harness)
    expect(rows.map(row => row.id)).toEqual(['vscode', 'copy-path'])
    expect(harness.logged().some(text => text.includes(missingAppLog('explorer')))).toBe(true)
  })

  it('omits both launch rows and reports the catalog failure when it cannot be read', async () => {
    stubFetch({ catalog: answer({}, 503) })
    const harness = await start()
    const rows = await rowsOf(harness)
    expect(rows.map(row => row.id)).toEqual(['copy-path'])
    const reported = harness.logged()
    expect(reported.some(text => text.includes(CATALOG_FAILURE_LOG) && text.includes('HTTP 503'))).toBe(true)
  })

  it('rejects with the abort reason when the menu was dismissed', async () => {
    stubFetch({ catalog: 'pending' })
    const harness = await start()
    const contribution = harness.menus.contribution(CONTRIBUTION_ID)
    const controller = new AbortController()
    controller.abort()
    await expect(Promise.resolve(contribution.resolve(TARGET, controller.signal))).rejects.toBe(controller.signal.reason)
  })

  it('rejects when the menu is dismissed while the rows are still waiting', async () => {
    const calls = stubFetch({ catalog: 'pending' })
    const harness = await start()
    const contribution = harness.menus.contribution(CONTRIBUTION_ID)
    const controller = new AbortController()
    const pending = Promise.resolve(contribution.resolve(TARGET, controller.signal))
    controller.abort()
    await expect(pending).rejects.toBe(controller.signal.reason)
    expect(calls.filter(call => call.url === CATALOG).length).toBeLessThanOrEqual(1)
  })
})

describe('running a row', () => {
  it('launches VS Code with the path the workspace has now, not the captured one', async () => {
    const calls = stubFetch({ catalog: answer({ apps: ['vscode', 'explorer'] }), launch: answer({}) })
    const harness = await start()
    const rows = await rowsOf(harness)
    await actionOf(rows, 'vscode').run?.()
    const post = calls.find(call => call.url === LAUNCH)
    expect(post?.init?.method).toBe('POST')
    expect(headerValue(post?.init, 'content-type')).toBe('application/json')
    expect(bodyOf(post)).toEqual({ app: 'vscode', path: '/repo/live' })
    expect(harness.menus.notifications).toEqual([])
  })

  it('launches the file browser for the explorer row', async () => {
    const calls = stubFetch({ catalog: answer({ apps: ['vscode', 'explorer'] }), launch: answer({}) })
    const harness = await start()
    const rows = await rowsOf(harness)
    await actionOf(rows, 'explorer').run?.()
    expect(bodyOf(calls.find(call => call.url === LAUNCH))).toEqual({ app: 'explorer', path: '/repo/live' })
    expect(harness.menus.notifications).toEqual([])
  })

  it('copies the path and confirms with a successful notice', async () => {
    const clipboard = vi.spyOn(primitives, 'writeClipboard').mockResolvedValue(true)
    stubCatalog()
    const harness = await start()
    const rows = await rowsOf(harness)
    await actionOf(rows, 'copy-path').run?.()
    expect(clipboard).toHaveBeenCalledWith('/repo/live')
    expect(harness.menus.notifications).toEqual([{ text: translateEn('toast.pathCopied'), success: true }])
  })

  it('reports a refused clipboard write once and still resolves', async () => {
    const clipboard = vi.spyOn(primitives, 'writeClipboard').mockResolvedValue(false)
    stubCatalog()
    const harness = await start()
    const rows = await rowsOf(harness)
    await expect(actionOf(rows, 'copy-path').run?.()).resolves.toBeUndefined()
    expect(clipboard).toHaveBeenCalledWith('/repo/live')
    expect(harness.menus.notifications).toEqual([{ text: translateEn('toast.copyFailed'), success: undefined }])
    expect(harness.logged().length).toBeGreaterThan(0)
  })

  it('reports a failed VS Code launch once with the Host status and still resolves', async () => {
    const calls = stubFetch({ catalog: answer({ apps: ['vscode', 'explorer'] }), launch: answer({}, 502) })
    const harness = await start()
    const rows = await rowsOf(harness)
    const row = actionOf(rows, 'vscode')
    expect(row.failureLabel).toBeUndefined()
    await expect(row.run?.()).resolves.toBeUndefined()
    expect(calls.filter(call => call.url === LAUNCH)).toHaveLength(1)
    expect(harness.menus.notifications).toHaveLength(1)
    const notice = harness.menus.notifications[0]
    expect(detailOf(translateEn('toast.vscodeFailed'), notice?.text ?? '')).toContain('502')
  })

  it('reports a failed file-browser launch under its own notice', async () => {
    stubFetch({ catalog: answer({ apps: ['vscode', 'explorer'] }), launch: answer({}, 500) })
    const harness = await start()
    const rows = await rowsOf(harness)
    await actionOf(rows, 'explorer').run?.()
    expect(harness.menus.notifications).toHaveLength(1)
    const notice = harness.menus.notifications[0]
    expect(detailOf(translateEn('toast.fileBrowserFailed'), notice?.text ?? '')).toContain('500')
  })

  it('keeps the exception message when the launch itself fails', async () => {
    stubFetch({ catalog: answer({ apps: ['vscode', 'explorer'] }), launch: { thrown: new Error('spawn failed') } })
    const harness = await start()
    const rows = await rowsOf(harness)
    await actionOf(rows, 'vscode').run?.()
    expect(harness.menus.notifications).toHaveLength(1)
    const notice = harness.menus.notifications[0]
    expect(detailOf(translateEn('toast.vscodeFailed'), notice?.text ?? '')).toContain('spawn failed')
  })

  it('keeps a non-Error launch failure as its text', async () => {
    stubFetch({ catalog: answer({ apps: ['vscode', 'explorer'] }), launch: { thrown: 'boom' } })
    const harness = await start()
    const rows = await rowsOf(harness)
    await actionOf(rows, 'vscode').run?.()
    expect(harness.menus.notifications).toHaveLength(1)
    const notice = harness.menus.notifications[0]
    expect(detailOf(translateEn('toast.vscodeFailed'), notice?.text ?? '')).toContain('boom')
  })

  it('does nothing when the workspace is gone', async () => {
    const calls = stubFetch({ catalog: answer({ apps: ['vscode', 'explorer'] }), launch: answer({}) })
    const clipboard = vi.spyOn(primitives, 'writeClipboard')
    const harness = await start()
    const rows = await rowsOf(harness, { workspaceId: 'gone', path: '/repo/gone', displayTitle: 'gone' })
    for (const row of rows) await row.run?.()
    expect(calls.some(call => call.url === LAUNCH)).toBe(false)
    expect(clipboard).not.toHaveBeenCalled()
    expect(harness.menus.notifications).toEqual([])
  })
})
