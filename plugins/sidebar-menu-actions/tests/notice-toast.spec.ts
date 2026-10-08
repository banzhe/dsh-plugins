// @vitest-environment jsdom
/**
 * The `shell.overlay` notice entry, mounted the way the shell mounts one: the
 * component `SlotsDouble` recorded is rendered over the business face the
 * plugin's `inject` factory returned, so what is pinned is the real
 * store → hook → shipped-`Toast` wiring, not a stub of it.
 */
import { Context, type Fiber } from '@deepseek-ai/cordis'
import { act, createElement, type ComponentType } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { IWorkspaces } from '@deepseek-ai/dsh-api-workspace-controller/client'
import { apply, inject } from '../src/client/index.ts'
import { en } from '../src/client/locales.ts'
import type { NoticeToastInjected, NoticeToastProps } from '../src/client/NoticeToast.tsx'
import { LocaleDouble } from './locale-double.ts'
import { SlotsDouble } from './slots-double.ts'
import { translateEn as t } from './translate.ts'
import { workspacesDouble } from './workspaces-double.ts'

const NOTICE = 'sidebar-menu-actions.notice'
const COPY_ROW = 'sidebar-menu-actions.copy-session-id'
const SESSION_ID = 'sess-42'
const WORKSPACES = [{ workspaceId: 'ws-1', path: '/ws/alpha' }]

/**
 * The entry ignores these, but the composed props type requires them: ui-session
 * and ui-workspace merge `GlobalStandardProps` onto every slot key, so a fixture
 * cast must supply all four selectors or the entry's own props type rejects the
 * cast.
 */
const STANDARD_PROPS = {
  useSessions: (() => {}) as never,
  useSessionStatus: (() => {}) as never,
  useSessionRetainInfo: (() => {}) as never,
  useWorkspaces: (() => {}) as never,
}

let fibers: Fiber[] = []
let roots: Root[] = []

// React only honors act() when it is told it runs in a test environment.
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

interface Harness {
  /** The root the entry rendered into, so an unmount leaves an empty container. */
  readonly host: HTMLElement
  toast(): HTMLElement | null
  banner(): HTMLElement
  copy(): Promise<void>
  finish(): Promise<void>
}

async function mount(): Promise<Harness> {
  // The probe's route is not this spec's subject; an inert Host is the plain case.
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ apps: [] }) })))
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  const ctx = new Context()
  ctx.provide('workspaces', workspacesDouble(WORKSPACES) as unknown as IWorkspaces)
  ctx.provide('locale', new LocaleDouble() as never)
  // A cordis Service registers itself under its name in its own constructor.
  const slots = new SlotsDouble(ctx)
  const fiber = ctx.plugin({ inject: [...inject], apply })
  await fiber.await()
  fibers.push(fiber)

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
  return {
    host,
    toast: () => host.querySelector<HTMLElement>('[data-toast]'),
    banner: () => {
      const found = host.querySelector<HTMLElement>('[data-toast]')
      if (found === null) throw new Error('no banner is mounted')
      return found
    },
    copy: async (): Promise<void> => {
      // The injected face declares `copy` as void; its implementation is async,
      // so awaiting the same promise inside act() settles the notice update there.
      // oxlint-disable-next-line typescript/no-confusing-void-expression
      const pending = slots.injection(COPY_ROW).copy(SESSION_ID)
      await act(async () => { await Promise.resolve(pending) })
    },
    finish: async (): Promise<void> => {
      const done = host.querySelector<HTMLElement>('[data-toast-done]')
      if (done === null) throw new Error('no banner to complete')
      await act(async () => { done.click() })
    },
  }
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

describe('NoticeToast', () => {
  it('renders nothing while no notice is pending', async () => {
    const notice = await mount()
    expect(notice.toast()).toBeNull()
    expect(notice.host.textContent).toBe('')
  })

  it('renders the copied notice and unmounts it when the banner reports done', async () => {
    const notice = await mount()
    await notice.copy()
    expect(notice.banner().textContent).toBe(en['toast.copied'])
    await notice.finish()
    expect(notice.toast()).toBeNull()
  })

  it('remounts the banner for a second notice instead of extending the first', async () => {
    const notice = await mount()
    await notice.copy()
    const first = notice.banner()
    await notice.copy()
    const second = notice.banner()
    // The same text is a new showing (a new `seq`), so the banner is a NEW element.
    expect(second).not.toBe(first)
    expect(second.textContent).toBe(en['toast.copied'])
  })
})
