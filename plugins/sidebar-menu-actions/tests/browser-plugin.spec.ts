// @vitest-environment jsdom
/**
 * The browser half's lifecycle over a real Cordis context, plus the node half's
 * exported name. Beyond the registrations themselves this spec pins the cases that fail
 * silently when a guard is dropped: the copy row must be grafted even when the
 * launch probe is still in flight or answered with neither app, and a full
 * teardown proven not by the returned disposer but by arming a row afterwards
 * and asserting the menu stays as shipped.
 *
 * `pathOf` is driven through both answers: a row whose id the workspace
 * snapshot carries (the POST fires) and one it does not (no request at all).
 */
import { Context, type Fiber } from '@deepseek-ai/cordis'
import * as primitives from '@deepseek-ai/dsh-client-ui-primitives'
import { act, createElement, type ComponentType } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { IWorkspaces } from '@deepseek-ai/dsh-api-workspace-controller/client'
import { apply, inject } from '../src/client/index.ts'
import { en, NS, zh } from '../src/client/locales.ts'
import type { NoticeToastInjected, NoticeToastProps } from '../src/client/NoticeToast.tsx'
import { name as nodeName } from '../src/index.ts'
import {
  appendWorkspaceRow, armPointer, buildMenu, COPY_ROW, EXPLORER_ROW, flush, injectedButton,
  recordKeys, requireInjected, viewportRows, VSCODE_ROW,
} from './fixtures.ts'
import { LocaleDouble } from './locale-double.ts'
import { SlotsDouble } from './slots-double.ts'
import { translateEn as t } from './translate.ts'
import { workspacesDouble } from './workspaces-double.ts'

const NOTICE = 'sidebar-menu-actions.notice'

const WORKSPACES = [{ workspaceId: 'ws-1', path: '/ws/alpha' }]

/**
 * The notice entry ignores these, but the composed props type requires them:
 * ui-session and ui-workspace merge `GlobalStandardProps` onto every slot key,
 * so a fixture cast must supply all of them or the entry's own props type
 * rejects the cast.
 */
const STANDARD_PROPS = {
  useSessions: (() => {}) as never,
  useSessionStatus: (() => {}) as never,
  useSessionRetainInfo: (() => {}) as never,
  useWorkspaces: (() => {}) as never,
  useShortcuts: (() => {}) as never,
}

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

function stubApps(apps: readonly string[] = ['vscode', 'explorer']): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ apps }) }))
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

/** Mount the plugin's own `shell.overlay` entry over the face it registered. */
async function mountNotice(slots: SlotsDouble): Promise<HTMLElement> {
  const entry = slots.entry(NOTICE)
  if (entry === undefined) throw new Error('the overlay entry was not registered')
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  roots.push(root)
  await act(async () => {
    // The registration boundary is where these casts belong: the recorded
    // component IS the notice entry and the recorded face IS its inject face.
    const component = entry.component as ComponentType<NoticeToastProps>
    const face = entry.injected as unknown as NoticeToastInjected
    root.render(createElement(component, { t, ...STANDARD_PROPS, ...face }))
  })
  return host
}

/** The banner copy on display, or a failure when nothing is mounted. */
function bannerText(host: HTMLElement): string {
  const banner = host.querySelector<HTMLElement>('[data-toast]')
  if (banner === null) throw new Error('no banner is mounted')
  return banner.textContent ?? ''
}

/** Complete the mounted banner the way the primitive does once its fade ends. */
async function finishBanner(host: HTMLElement): Promise<void> {
  const done = host.querySelector<HTMLElement>('[data-toast-done]')
  if (done === null) throw new Error('no banner to complete')
  await act(async () => { done.click() })
}

/** Graft the menu of one workspace row and return every injected row. */
async function graftedRows(workspaceId: string): Promise<{
  readonly vscode: HTMLButtonElement | null
  readonly explorer: HTMLButtonElement | null
  readonly copy: HTMLButtonElement
}> {
  const row = appendWorkspaceRow(workspaceId)
  armPointer(row.trigger)
  const menu = buildMenu()
  document.body.append(menu.menu)
  await flush()
  return {
    vscode: injectedButton(menu.menu, VSCODE_ROW),
    explorer: injectedButton(menu.menu, EXPLORER_ROW),
    copy: requireInjected(menu.menu, COPY_ROW),
  }
}

/** Click one row and collect every keydown it dispatches on document. */
async function click(button: HTMLElement): Promise<string[]> {
  const keys = recordKeys()
  // Inside act(): a click that raises a notice is a React update.
  await act(async () => {
    button.click()
    await flush()
  })
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
    expect(translate('menu.copyWorkspacePath')).toBe(zh['menu.copyWorkspacePath'])
    ctx.locale.setLocale('en')
    expect(translate('menu.copyWorkspacePath')).toBe(en['menu.copyWorkspacePath'])
    await fiber.dispose()
    expect(translate('menu.copyWorkspacePath')).toBe('menu.copyWorkspacePath')
  })

  it('keeps the copy row only on a Host that resolved neither launch app', async () => {
    stubApps([])
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { slots } = await bench()
    await flush()
    expect(warn).toHaveBeenCalledWith('sidebar-menu-actions: vscode is not available on this host; the workspace menu omits that row')
    expect(warn).toHaveBeenCalledWith('sidebar-menu-actions: explorer is not available on this host; the workspace menu omits that row')
    expect(slots.entry(NOTICE)).toBeDefined()
    const row = appendWorkspaceRow('ws-1')
    armPointer(row.trigger)
    const menu = buildMenu()
    document.body.append(menu.menu)
    await flush()
    expect(viewportRows(menu)).toBe(3)
    expect(injectedButton(menu.menu, VSCODE_ROW)).toBeNull()
    expect(injectedButton(menu.menu, EXPLORER_ROW)).toBeNull()
    expect(injectedButton(menu.menu, COPY_ROW)).not.toBeNull()
  })

  it('omits only the file-browser row on a Host without explorer', async () => {
    // What a macOS or Linux Host reports: `explorer` is declared on win32 alone.
    stubApps([VSCODE_ROW])
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { slots } = await bench()
    await flush()
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn).toHaveBeenCalledWith('sidebar-menu-actions: explorer is not available on this host; the workspace menu omits that row')
    expect(slots.entry(NOTICE)).toBeDefined()
    const { vscode, explorer } = await graftedRows('ws-1')
    expect(vscode).not.toBeNull()
    expect(explorer).toBeNull()
  })

  it('opens the Workspace in the file browser through the explorer catalog id', async () => {
    const fetchMock = stubApps()
    await bench()
    await flush()
    const { explorer } = await graftedRows('ws-1')
    if (explorer === null) throw new Error('the file-browser row was not grafted')
    const keys = await click(explorer)
    expect(fetchMock).toHaveBeenLastCalledWith('open-in-app/open', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ app: 'explorer', path: '/ws/alpha' }),
    })
    expect(keys).toEqual(['Escape'])
  })

  it('installs the workspace menu on a probing Host and opens the resolved path', async () => {
    const fetchMock = stubApps()
    const { slots } = await bench()
    await flush()
    const { vscode } = await graftedRows('ws-1')
    if (vscode === null) throw new Error('the VS Code row was not grafted')
    const keys = await click(vscode)
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

  it('writes the resolved directory to the clipboard and raises the copied notice', async () => {
    stubApps()
    const write = vi.spyOn(primitives, 'writeClipboard').mockResolvedValue(true)
    const { slots } = await bench()
    await flush()
    const host = await mountNotice(slots)
    expect(host.textContent).toBe('')
    const { copy } = await graftedRows('ws-1')
    const keys = await click(copy)
    expect(keys).toEqual(['Escape'])
    expect(write).toHaveBeenCalledWith('/ws/alpha')
    expect(bannerText(host)).toBe(en['toast.pathCopied'])
    // Completing the banner takes it down; nothing else is left mounted.
    await finishBanner(host)
    expect(host.textContent).toBe('')
  })

  it('restarts the banner for a second copy instead of extending the first', async () => {
    stubApps()
    vi.spyOn(primitives, 'writeClipboard').mockResolvedValue(true)
    const { slots } = await bench()
    await flush()
    const host = await mountNotice(slots)
    const { copy } = await graftedRows('ws-1')
    await click(copy)
    const first = host.querySelector<HTMLElement>('[data-toast]')
    await click(copy)
    const second = host.querySelector<HTMLElement>('[data-toast]')
    // The same text is a new showing (a new `seq`), so the banner is a NEW element.
    expect(first).not.toBeNull()
    expect(second).not.toBe(first)
    expect(bannerText(host)).toBe(en['toast.pathCopied'])
  })

  it('reports a refused clipboard write through the console and the failure notice', async () => {
    stubApps()
    vi.spyOn(primitives, 'writeClipboard').mockResolvedValue(false)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { slots } = await bench()
    await flush()
    const host = await mountNotice(slots)
    const { copy } = await graftedRows('ws-1')
    await click(copy)
    expect(warn).toHaveBeenCalledWith('sidebar-menu-actions: copy workspace path failed: the clipboard refused the write')
    expect(bannerText(host)).toBe(en['toast.copyFailed'])
  })

  it('dismisses the menu without a request when the row’s workspace is gone', async () => {
    const fetchMock = stubApps()
    const write = vi.spyOn(primitives, 'writeClipboard').mockResolvedValue(true)
    await bench()
    await flush()
    const { copy } = await graftedRows('ws-gone')
    const keys = await click(copy)
    // Only the probe's own GET: `pathOf` missed, so nothing is written or posted.
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(write).not.toHaveBeenCalled()
    expect(keys).toEqual(['Escape'])
  })

  it('keeps the copy row while the probe is still in flight', async () => {
    let release = (): void => {}
    const gate = new Promise<void>((resolve) => { release = resolve })
    vi.stubGlobal('fetch', vi.fn(async () => {
      await gate
      return { ok: true, status: 200, json: async () => ({ apps: ['vscode'] }) }
    }))
    await bench()
    const { vscode, explorer, copy } = await graftedRows('ws-1')
    // The launch rows wait for the answer; the browser-local row does not.
    expect(vscode).toBeNull()
    expect(explorer).toBeNull()
    expect(copy).not.toBeNull()
    release()
    await flush()
  })

  it('leaves nothing grafted when the fiber is disposed before the probe settles', async () => {
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

  it('releases the dictionaries, the notice entry, and the workspace install with the fiber', async () => {
    stubApps()
    const { ctx, fiber, slots } = await bench()
    await flush()
    // The install is live before teardown: the arm below grafts every row.
    const live = appendWorkspaceRow('ws-1')
    armPointer(live.trigger)
    const liveMenu = buildMenu()
    document.body.append(liveMenu.menu)
    await flush()
    expect(viewportRows(liveMenu)).toBe(5)
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
    expect(injectedButton(menu.menu, VSCODE_ROW)).toBeNull()
  })
})

describe('sidebar-menu-actions node half', () => {
  it('names the plugin, which is how the Loader row identifies it', () => {
    expect(nodeName).toBe('sidebar-menu-actions')
  })
})
