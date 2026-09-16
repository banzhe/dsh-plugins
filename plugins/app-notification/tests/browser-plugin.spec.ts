// @vitest-environment jsdom
/**
 * Browser-half lifecycle over a real Cordis context: the dictionary
 * registration with fiber teardown proving removal, the settings-row
 * registration (which is what carries the permission gesture), the Session-list
 * subscription the presenter installs, and the paths a page without either
 * surface takes.
 */
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { ISessions, SessionListState } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { apply, inject } from '../src/client/index.ts'
import { apply as nodeApply } from '../src/index.ts'
import { en, NS, zh } from '../src/client/locales.ts'
import { LocaleDouble } from './locale-double.ts'
import { SlotsDouble } from './slots-double.ts'

class FakeNotification {
  static permission: NotificationPermission = 'granted'
  static requestResult: NotificationPermission = 'granted'
  static requestPermission = vi.fn(async () => {
    FakeNotification.permission = FakeNotification.requestResult
    return FakeNotification.requestResult
  })

  static instances: FakeNotification[] = []
  onclick: (() => void) | null = null

  constructor(readonly title: string, readonly options?: NotificationOptions) {
    FakeNotification.instances.push(this)
  }

  close(): void {}
}

function stubCapabilities(options: { badge?: boolean; permission?: NotificationPermission } = {}): {
  sessions: ReturnType<typeof createSnapshotStore<SessionListState>>
  open: ReturnType<typeof vi.fn>
} {
  vi.stubGlobal('navigator', options.badge === false
    ? {}
    : { setAppBadge: vi.fn(async () => {}), clearAppBadge: vi.fn(async () => {}) })
  FakeNotification.permission = options.permission ?? 'granted'
  vi.stubGlobal('Notification', FakeNotification)
  const open = vi.fn()
  const sessions = createSnapshotStore<SessionListState>({
    ids: [],
    byId: {},
    current: undefined,
    phase: 'ready',
    subagentsByParent: {},
    jobsBySession: {},
    currentAddress: undefined,
  })
  return { sessions, open }
}

/** Boot the browser half over a context providing the three injected services. */
async function bench(
  surface: { sessions: ReturnType<typeof createSnapshotStore<SessionListState>>; open: ReturnType<typeof vi.fn> },
) {
  const ctx = new Context()
  ctx.provide('sessions', { list: surface.sessions, open: surface.open } as unknown as ISessions)
  ctx.provide('locale', new LocaleDouble() as never)
  // A cordis Service registers itself under its name in its own constructor.
  const slots = new SlotsDouble(ctx)
  const fiber = ctx.plugin({ inject: [...inject], apply })
  await fiber.await()
  return { ctx, fiber, slots }
}

afterEach(() => {
  FakeNotification.instances = []
  FakeNotification.permission = 'granted'
  FakeNotification.requestResult = 'granted'
  FakeNotification.requestPermission.mockClear()
  vi.unstubAllGlobals()
  document.head.innerHTML = ''
})

describe('app-badge browser half', () => {
  it('declares the services it binds', () => {
    expect(inject).toEqual(['sessions', 'locale', 'slots'])
  })

  it('projects the finished count and notifies, then releases both with the fiber', async () => {
    const surface = stubCapabilities()
    const { fiber } = await bench(surface)
    surface.sessions.update((state) => {
      state.ids = ['a' as SessionId]
      state.byId['a' as SessionId] = {
        id: 'a' as SessionId, displayTitle: 'Alpha', running: true, blank: false, updatedAt: 1,
      }
    })
    surface.sessions.update((state) => {
      state.byId['a' as SessionId] = {
        id: 'a' as SessionId, displayTitle: 'Alpha', running: false, completed: true, blank: false, updatedAt: 2,
      }
    })
    expect(FakeNotification.instances).toHaveLength(1)
    expect(FakeNotification.instances[0]?.title).toBe(en['notify.title'])
    expect(FakeNotification.instances[0]?.options).toMatchObject({
      body: en['notify.body'].replace('{title}', 'Alpha'),
      tag: 'dsh-session-completed',
    })
    await fiber.dispose()
    // The subscription left with the fiber: a later update produces nothing.
    surface.sessions.update((state) => {
      state.byId['b' as SessionId] = {
        id: 'b' as SessionId, displayTitle: 'Beta', running: false, completed: true, blank: false, updatedAt: 3,
      }
      state.ids = [...state.ids, 'b' as SessionId]
    })
    expect(FakeNotification.instances).toHaveLength(1)
  })

  it('opens the notification target through the sessions service', async () => {
    const surface = stubCapabilities()
    await bench(surface)
    surface.sessions.update((state) => {
      state.ids = ['a' as SessionId]
      state.byId['a' as SessionId] = {
        id: 'a' as SessionId, displayTitle: 'Alpha', running: true, blank: false, updatedAt: 1,
      }
    })
    surface.sessions.update((state) => {
      state.byId['a' as SessionId] = {
        id: 'a' as SessionId, displayTitle: 'Alpha', running: false, completed: true, blank: false, updatedAt: 2,
      }
    })
    FakeNotification.instances[0]?.onclick?.()
    expect(surface.open).toHaveBeenCalledWith('a')
  })

  it('registers both dictionaries under its own namespace and releases them with the fiber', async () => {
    const surface = stubCapabilities()
    const { ctx, fiber } = await bench(surface)
    ctx.locale.setLocale('zh')
    const translate = ctx.locale.bind(NS)
    expect(translate('notify.title')).toBe(zh['notify.title'])
    ctx.locale.setLocale('en')
    expect(translate('notify.title')).toBe(en['notify.title'])
    await fiber.dispose()
    expect(translate('notify.title')).not.toBe(en['notify.title'])
  })

  it('keeps the English dictionary key-identical to the Chinese source of truth', () => {
    expect(Object.keys(en).sort()).toEqual(Object.keys(zh).sort())
  })

  it('registers the settings row and removes its stylesheet with the fiber', async () => {
    const surface = stubCapabilities()
    const { fiber, slots } = await bench(surface)
    const entry = slots.entry('app-badge')
    expect(entry).toBeDefined()
    expect(entry?.options.order).toBe(20)
    expect(entry?.options.locale).toBe(NS)
    expect(entry?.component).toBeTypeOf('function')
    const styles = [...document.head.querySelectorAll('style[data-plugin]')]
    expect(styles.some(style => style.dataset.pluginCss?.endsWith('settings-row.css'))).toBe(true)
    await fiber.dispose()
    expect(slots.entry('app-badge')).toBeUndefined()
    expect(document.head.querySelectorAll('style[data-plugin]')).toHaveLength(0)
  })

  it('exposes the permission gesture and the test probe through the row injection', async () => {
    const surface = stubCapabilities({ permission: 'default' })
    const { slots } = await bench(surface)
    const injected = slots.injection('app-badge')
    expect(injected.permission).toBeTypeOf('function')
    expect(injected.permission()).toBe('default')
    expect(injected.badgeSupported()).toBe(true)
    // The test probe refuses while ungranted, and never throws.
    expect(injected.test()).toBe(false)
    expect(FakeNotification.instances).toEqual([])

    FakeNotification.permission = 'granted'
    expect(injected.permission()).toBe('granted')
    expect(injected.test()).toBe(true)
    expect(FakeNotification.instances).toHaveLength(1)
    expect(FakeNotification.instances[0]?.options).toMatchObject({ tag: 'dsh-session-completed-test' })
  })

  it('announces the next completion after a grant, without a reload', async () => {
    const surface = stubCapabilities({ badge: false, permission: 'default' })
    const { slots } = await bench(surface)
    // Nothing is announced while ungranted, but the subscription is already live.
    surface.sessions.update((state) => {
      state.ids = ['a' as SessionId]
      state.byId['a' as SessionId] = {
        id: 'a' as SessionId, displayTitle: 'Alpha', running: true, blank: false, updatedAt: 1,
      }
    })
    surface.sessions.update((state) => {
      state.byId['a' as SessionId] = {
        id: 'a' as SessionId, displayTitle: 'Alpha', running: false, completed: true, blank: false, updatedAt: 2,
      }
    })
    expect(FakeNotification.instances).toEqual([])

    const result = await slots.injection('app-badge').request()
    expect(result).toBe('granted')
    expect(FakeNotification.requestPermission).toHaveBeenCalledTimes(1)
    surface.sessions.update((state) => {
      state.ids = ['a' as SessionId, 'b' as SessionId]
      state.byId['b' as SessionId] = {
        id: 'b' as SessionId, displayTitle: 'Beta', running: false, completed: true, blank: false, updatedAt: 3,
      }
    })
    expect(FakeNotification.instances).toHaveLength(1)
    expect(FakeNotification.instances[0]?.title).toBe(en['notify.title'])
  })

  it('still registers the row and dictionaries on a page with neither surface', async () => {
    const surface = stubCapabilities({ badge: false, permission: 'denied' })
    const { ctx, slots } = await bench(surface)
    surface.sessions.update((state) => {
      state.ids = ['a' as SessionId]
      state.byId['a' as SessionId] = {
        id: 'a' as SessionId, displayTitle: 'Alpha', running: false, completed: true, blank: false, updatedAt: 2,
      }
    })
    expect(FakeNotification.instances).toEqual([])
    // The row is the only surface that can explain the silence, so it stays.
    expect(slots.entry('app-badge')).toBeDefined()
    expect(ctx.locale.bind(NS)('settings.title')).toBe(en['settings.title'])
  })

  it('stays inert without a Notification constructor at all', async () => {
    const surface = stubCapabilities()
    vi.stubGlobal('Notification', undefined)
    const { slots } = await bench(surface)
    const injected = slots.injection('app-badge')
    expect(injected.permission()).toBe('unsupported')
    expect(injected.test()).toBe(false)
    expect(injected.badgeSupported()).toBe(true)
  })
})

describe('app-badge node half', () => {
  it('the node apply is an inert loader seat', () => {
    expect(() => { nodeApply() }).not.toThrow()
  })
})
