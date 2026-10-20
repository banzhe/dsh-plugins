// @vitest-environment jsdom
/**
 * The browser half's lifecycle over a real Cordis context, plus the node half's
 * exported name. Beyond the registrations themselves this spec pins the cases that fail
 * silently when a guard is dropped: a disposal that must win the race against a
 * probe still in flight (no install may land after teardown), and a full
 * teardown proven not by the returned disposer but by arming a row afterwards
 * and asserting the menu stays as shipped.
 *
 * `pathOf` is driven through both answers: a row whose id the workspace
 * snapshot carries (the POST fires) and one it does not (no request at all).
 */
import { Context, type Fiber } from '@deepseek-ai/cordis'
import { act } from 'react'
import type { Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { IWorkspaces } from '@deepseek-ai/dsh-api-workspace-controller/client'
import { apply, inject } from '../src/client/index.ts'
import { en, NS, zh } from '../src/client/locales.ts'
import { name as nodeName } from '../src/index.ts'
import {
  appendWorkspaceRow, armPointer, buildMenu, flush, injectedButton, recordKeys, viewportRows,
} from './fixtures.ts'
import { LocaleDouble } from './locale-double.ts'
import { SlotsDouble } from './slots-double.ts'
import { workspacesDouble } from './workspaces-double.ts'

const NOTICE = 'sidebar-menu-actions.notice'

const WORKSPACES = [{ workspaceId: 'ws-1', path: '/ws/alpha' }]

let fibers: Fiber[] = []
let roots: Root[] = []

// React only honors act() when it is told it runs in a test environment.
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

interface Bench {
  readonly ctx: Context
  readonly fiber: Fiber
  readonly slots: SlotsDouble
}

async function bench(): Promise<Bench> {
  const ctx = new Context()
  ctx.provide('workspaces', workspacesDouble(WORKSPACES) as unknown as IWorkspaces)
  ctx.provide('locale', new LocaleDouble() as never)
  // A cordis Service registers itself under its name in its own constructor.
  const slots = new SlotsDouble(ctx)
  const fiber = ctx.plugin({ inject: [...inject], apply })
  await fiber.await()
  fibers.push(fiber)
  return { ctx, fiber, slots }
}

function stubApps(apps: readonly string[] = ['vscode']): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ apps }) }))
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

async function graftedRow(workspaceId: string): Promise<HTMLButtonElement> {
  const row = appendWorkspaceRow(workspaceId)
  armPointer(row.trigger)
  const menu = buildMenu()
  document.body.append(menu.menu)
  await flush()
  const button = injectedButton(menu.menu)
  if (button === null) throw new Error('the workspace menu stayed as shipped')
  return button
}

/** Click one row and collect every keydown it dispatches on document. */
async function click(button: HTMLElement): Promise<string[]> {
  const keys = recordKeys()
  button.click()
  await flush()
  keys.stop()
  return keys.keys
}

afterEach(async () => {
  // Unmount inside act(): tearing a root down is itself an update in a test env.
  await act(async () => {
    for (const root of roots) root.unmount()
  })
  roots = []
  const pending = fibers
  fibers = []
  for (const fiber of pending) await fiber.dispose()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  document.head.innerHTML = ''
  document.body.innerHTML = ''
})

describe('sidebar-menu-actions browser half', () => {
  it('registers the notice entry on the shell overlay seat', async () => {
    stubApps()
    const { slots } = await bench()
    await flush()
    const entry = slots.entry(NOTICE)
    expect(entry).toBeDefined()
    expect(entry?.options.name).toBe('shell.overlay')
    expect(entry?.options.locale).toBe(NS)
    expect(entry?.component).toBeTypeOf('function')
    expect(entry?.injected.useNotice).toBeTypeOf('function')
    expect(entry?.injected.dismiss).toBeTypeOf('function')
  })

  it('registers both dictionaries and releases them with the fiber', async () => {
    stubApps()
    const { ctx, fiber } = await bench()
    await flush()
    const translate = ctx.locale.bind(NS)
    ctx.locale.setLocale('zh')
    expect(translate('menu.openInVscode')).toBe(zh['menu.openInVscode'])
    ctx.locale.setLocale('en')
    expect(translate('menu.openInVscode')).toBe(en['menu.openInVscode'])
    await fiber.dispose()
    expect(translate('menu.openInVscode')).toBe('menu.openInVscode')
  })

  it('stays inert on a Host without VS Code, but keeps the notice entry', async () => {
    stubApps([])
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { slots } = await bench()
    await flush()
    expect(warn).toHaveBeenCalledWith('sidebar-menu-actions: VS Code is not available on this host; the workspace menu item stays disabled')
    expect(slots.entry(NOTICE)).toBeDefined()
    // Nothing listens: the same arm and menu an installed half would answer.
    const row = appendWorkspaceRow('ws-1')
    armPointer(row.trigger)
    const menu = buildMenu()
    document.body.append(menu.menu)
    await flush()
    expect(viewportRows(menu)).toBe(2)
    expect(injectedButton(document)).toBeNull()
  })

  it('installs the workspace menu on a probing Host and opens the resolved path', async () => {
    const fetchMock = stubApps()
    const { slots } = await bench()
    await flush()
    const button = await graftedRow('ws-1')
    const keys = await click(button)
    expect(fetchMock).toHaveBeenNthCalledWith(1, 'open-in-app/apps', { headers: { accept: 'application/json' } })
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(fetchMock).toHaveBeenLastCalledWith('open-in-app/open', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ app: 'vscode', path: '/ws/alpha' }),
    })
    expect(keys).toEqual(['Escape'])
    expect(slots.entry(NOTICE)).toBeDefined()
  })

  it('dismisses the menu without a request when the row’s workspace is gone', async () => {
    const fetchMock = stubApps()
    await bench()
    await flush()
    const button = await graftedRow('ws-gone')
    const keys = await click(button)
    // Only the probe's own GET: `pathOf` missed, so no open request is issued.
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(keys).toEqual(['Escape'])
  })

  it('installs nothing when the fiber is disposed before the probe settles', async () => {
    let release = (): void => {}
    const gate = new Promise<void>((resolve) => { release = resolve })
    vi.stubGlobal('fetch', vi.fn(async () => {
      await gate
      return { ok: true, status: 200, json: async () => ({ apps: ['vscode'] }) }
    }))
    const { fiber, slots } = await bench()
    expect(slots.entry(NOTICE)).toBeDefined()
    await fiber.dispose()
    release()
    await flush()
    const row = appendWorkspaceRow('ws-1')
    armPointer(row.trigger)
    const menu = buildMenu()
    document.body.append(menu.menu)
    await flush()
    expect(viewportRows(menu)).toBe(2)
  })

  it('releases the dictionaries, both entries, and the workspace install with the fiber', async () => {
    stubApps()
    const { ctx, fiber, slots } = await bench()
    await flush()
    // The install is live before teardown: the arm below grafts the row.
    const live = appendWorkspaceRow('ws-1')
    armPointer(live.trigger)
    const liveMenu = buildMenu()
    document.body.append(liveMenu.menu)
    await flush()
    expect(viewportRows(liveMenu)).toBe(3)
    await fiber.dispose()
    expect(slots.entry(NOTICE)).toBeUndefined()
    expect(ctx.locale.bind(NS)('toast.vscodeFailed', { detail: 'x' })).toBe('toast.vscodeFailed')
    // Both listeners and the observer left with the fiber: a fresh arm grafts nothing.
    const row = appendWorkspaceRow('ws-2')
    armPointer(row.trigger)
    const menu = buildMenu()
    document.body.append(menu.menu)
    await flush()
    expect(viewportRows(menu)).toBe(2)
    expect(injectedButton(menu.menu)).toBeNull()
  })
})

describe('sidebar-menu-actions node half', () => {
  it('names the plugin, which is how the Loader row identifies it', () => {
    expect(nodeName).toBe('sidebar-menu-actions')
  })
})
