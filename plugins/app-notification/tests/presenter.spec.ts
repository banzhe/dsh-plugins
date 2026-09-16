// @vitest-environment jsdom
/**
 * Badge and notification presentation over a fake capabilities surface: which
 * platform calls the finished-unread count produces, how a repeated count is
 * deduplicated, how the LIVE permission (never a startup probe) gates every
 * notification, and how every unsupported or refused capability degrades to a
 * logged no-op instead of a thrown error.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { SessionListState, SessionSummary } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import {
  AppBadgePresenter, CompletionPresenter, notificationPermission, probeCapabilities,
  requestNotificationPermission,
  type CompletionPresenterOptions,
} from '../src/client/presenter.ts'

/** A `Notification` stand-in recording every construction and click handler. */
class FakeNotification {
  static permission: NotificationPermission = 'granted'
  static requestResult: NotificationPermission = 'granted'
  static requestPermission = vi.fn(async () => {
    FakeNotification.permission = FakeNotification.requestResult
    return FakeNotification.requestResult
  })

  static instances: FakeNotification[] = []
  onclick: (() => void) | null = null
  onerror: ((event: Event) => void) | null = null
  readonly close = vi.fn()

  constructor(readonly title: string, readonly options?: NotificationOptions) {
    FakeNotification.instances.push(this)
  }
}

/** Install the badging + notification capability surface. */
function stubCapabilities(options: {
  badge?: boolean
  permission?: NotificationPermission
  notification?: boolean
} = {}): { setAppBadge: ReturnType<typeof vi.fn>; clearAppBadge: ReturnType<typeof vi.fn> } {
  const setAppBadge = vi.fn(async () => {})
  const clearAppBadge = vi.fn(async () => {})
  if (options.badge !== false) {
    vi.stubGlobal('navigator', { setAppBadge, clearAppBadge })
  } else {
    vi.stubGlobal('navigator', {})
  }
  FakeNotification.permission = options.permission ?? 'granted'
  if (options.notification === false) vi.stubGlobal('Notification', undefined)
  else vi.stubGlobal('Notification', FakeNotification)
  return { setAppBadge, clearAppBadge }
}

const logger = { warn: vi.fn() } as unknown as Context['logger']

function summary(id: string, over: Partial<SessionSummary> = {}): SessionSummary {
  return {
    id: id as SessionId, displayTitle: `Title ${id}`, running: false, blank: false, updatedAt: 1, ...over,
  }
}

function store(rows: readonly SessionSummary[]): ReturnType<typeof createSnapshotStore<SessionListState>> {
  return createSnapshotStore<SessionListState>({
    ids: rows.map(row => row.id),
    byId: Object.fromEntries(rows.map(row => [row.id, row])),
    current: undefined,
    phase: 'ready',
    subagentsByParent: {},
    jobsBySession: {},
    currentAddress: undefined,
  })
}

function options(open = vi.fn()): CompletionPresenterOptions {
  return {
    logger,
    notifyCopy: session => ({ title: 'Session finished', detail: `"${session.displayTitle}" finished.` }),
    testCopy: () => ({ title: 'Test notification', detail: 'If you can read this, it works.' }),
    open,
    tag: 'dsh-session-completed',
    testTag: 'dsh-session-completed-test',
  }
}

afterEach(() => {
  FakeNotification.instances = []
  FakeNotification.permission = 'granted'
  FakeNotification.requestResult = 'granted'
  FakeNotification.requestPermission.mockClear()
  vi.unstubAllGlobals()
  vi.clearAllMocks()
  vi.useRealTimers()
})

describe('probeCapabilities', () => {
  it('reports both surfaces available on a capable page', () => {
    stubCapabilities()
    expect(probeCapabilities()).toEqual({
      badge: true, notificationSupported: true, notificationGranted: true,
    })
  })

  it('requires BOTH badge methods, not just the setter', () => {
    vi.stubGlobal('navigator', { setAppBadge: vi.fn(async () => {}) })
    vi.stubGlobal('Notification', FakeNotification)
    expect(probeCapabilities().badge).toBe(false)
  })

  it('keeps support and permission independent for a non-granted permission', () => {
    stubCapabilities({ permission: 'default' })
    expect(probeCapabilities()).toMatchObject({ notificationSupported: true, notificationGranted: false })
  })

  it('treats a missing Notification constructor as unsupported', () => {
    stubCapabilities({ notification: false })
    expect(probeCapabilities()).toMatchObject({ notificationSupported: false, notificationGranted: false })
  })

  it('reports nothing available without a navigator', () => {
    vi.stubGlobal('navigator', undefined)
    expect(probeCapabilities()).toEqual({
      badge: false, notificationSupported: false, notificationGranted: false,
    })
  })
})

describe('notificationPermission', () => {
  it('reads the live permission rather than a cached probe', () => {
    stubCapabilities({ permission: 'default' })
    expect(notificationPermission()).toBe('default')
    FakeNotification.permission = 'granted'
    expect(notificationPermission()).toBe('granted')
  })

  it('reports unsupported without a constructor', () => {
    stubCapabilities({ notification: false })
    expect(notificationPermission()).toBe('unsupported')
  })
})

describe('requestNotificationPermission', () => {
  it('asks the platform and reports what the user chose', async () => {
    stubCapabilities({ permission: 'default' })
    FakeNotification.requestResult = 'granted'
    await expect(requestNotificationPermission()).resolves.toBe('granted')
    expect(FakeNotification.requestPermission).toHaveBeenCalledTimes(1)
  })

  it('reports unsupported without a constructor, without asking', async () => {
    stubCapabilities({ notification: false })
    await expect(requestNotificationPermission()).resolves.toBe('unsupported')
    expect(FakeNotification.requestPermission).not.toHaveBeenCalled()
  })
})

describe('AppBadgePresenter', () => {
  it('sets the count and clears on zero', async () => {
    const badge = stubCapabilities()
    const presenter = new AppBadgePresenter(logger)
    presenter.project(2)
    expect(badge.setAppBadge).toHaveBeenCalledWith(2)
    presenter.project(0)
    expect(badge.clearAppBadge).toHaveBeenCalledTimes(1)
    await Promise.resolve()
  })

  it('skips a repeated count so unrelated list updates issue no platform call', () => {
    const badge = stubCapabilities()
    const presenter = new AppBadgePresenter(logger)
    presenter.project(3)
    presenter.project(3)
    expect(badge.setAppBadge).toHaveBeenCalledTimes(1)
  })

  it('logs a refused badge write instead of rejecting', async () => {
    const badge = stubCapabilities()
    badge.setAppBadge.mockRejectedValueOnce(new Error('unsupported'))
    new AppBadgePresenter(logger).project(1)
    await vi.waitFor(() => { expect(logger.warn).toHaveBeenCalled() })
  })

  it('clear() retracts the badge and logs a refusal', async () => {
    const badge = stubCapabilities()
    const presenter = new AppBadgePresenter(logger)
    presenter.project(4)
    presenter.clear()
    expect(badge.clearAppBadge).toHaveBeenCalledTimes(1)
    badge.clearAppBadge.mockRejectedValueOnce(new Error('unsupported'))
    presenter.clear()
    await vi.waitFor(() => { expect(logger.warn).toHaveBeenCalled() })
  })

  it('a missing method is a silent no-op (capability probed elsewhere)', () => {
    vi.stubGlobal('navigator', {})
    expect(() => { new AppBadgePresenter(logger).project(1) }).not.toThrow()
    expect(logger.warn).not.toHaveBeenCalled()
  })
})

describe('CompletionPresenter', () => {
  it('projects the finished count and notifies each newly finished Session', () => {
    const badge = stubCapabilities()
    const sessions = store([summary('a', { running: true })])
    const open = vi.fn()
    const presenter = new CompletionPresenter(options(open))
    expect(presenter.viable).toBe(true)
    const detach = presenter.attach(sessions)

    sessions.update((state) => { state.byId['a' as SessionId] = summary('a', { completed: true }) })
    expect(badge.setAppBadge).toHaveBeenCalledWith(1)
    expect(FakeNotification.instances).toHaveLength(1)
    expect(FakeNotification.instances[0]?.title).toBe('Session finished')
    expect(FakeNotification.instances[0]?.options).toMatchObject({
      body: '"Title a" finished.',
      tag: 'dsh-session-completed',
    })

    FakeNotification.instances[0]?.onclick?.()
    expect(open).toHaveBeenCalledWith('a')
    expect(FakeNotification.instances[0]?.close).toHaveBeenCalled()
    detach()
  })

  it('re-alerts a completion that reuses the constant Session tag', () => {
    stubCapabilities()
    const sessions = store([summary('a', { running: true })])
    const presenter = new CompletionPresenter(options())
    const detach = presenter.attach(sessions)

    sessions.update((state) => { state.byId['a' as SessionId] = summary('a', { completed: true }) })
    expect(FakeNotification.instances).toHaveLength(1)
    // Chromium suppresses every same-tag banner after the first unless renotify
    // is set, so the completion count would visibly stop alerting without it.
    expect(FakeNotification.instances[0]?.options).toMatchObject({ renotify: true })
    detach()
  })

  it('logs a display refusal the platform reports after the completion was built', () => {
    stubCapabilities()
    const sessions = store([summary('a', { running: true })])
    const presenter = new CompletionPresenter(options())
    const detach = presenter.attach(sessions)

    sessions.update((state) => { state.byId['a' as SessionId] = summary('a', { completed: true }) })
    expect(FakeNotification.instances).toHaveLength(1)

    const refusal = new Event('error')
    FakeNotification.instances[0]?.onerror?.(refusal)
    expect(logger.warn).toHaveBeenCalledWith(
      'app-badge: the platform refused to display the notification', refusal,
    )
    // A late refusal is reported, not retried: acceptance never changed.
    expect(FakeNotification.instances).toHaveLength(1)
    detach()
  })

  it('announces nobody for the state a page loads into', () => {
    const badge = stubCapabilities()
    const presenter = new CompletionPresenter(options())
    const detach = presenter.attach(store([summary('a', { completed: true })]))
    expect(badge.setAppBadge).toHaveBeenCalledWith(1)
    expect(FakeNotification.instances).toEqual([])
    detach()
  })

  it('drives neither surface for a subagent child that finishes', () => {
    const badge = stubCapabilities()
    const sessions = store([summary('a', { running: true })])
    const presenter = new CompletionPresenter(options())
    const detach = presenter.attach(sessions)

    sessions.update((state) => {
      state.ids.push('child' as SessionId)
      state.byId['child' as SessionId] = summary('child', {
        origin: 'subagent', parentId: 'a' as SessionId, completed: true,
      })
    })
    expect(badge.setAppBadge).not.toHaveBeenCalled()
    expect(FakeNotification.instances).toEqual([])
    detach()
  })

  it('clears the badge and unsubscribes on detach', () => {
    const badge = stubCapabilities()
    const sessions = store([summary('a', { completed: true })])
    const presenter = new CompletionPresenter(options())
    const detach = presenter.attach(sessions)
    detach()
    expect(badge.clearAppBadge).toHaveBeenCalledTimes(1)
    sessions.update((state) => { state.byId['a' as SessionId] = summary('a', { completed: true, updatedAt: 2 }) })
    expect(badge.setAppBadge).toHaveBeenCalledTimes(1)
  })

  it('stays inert with neither surface available', () => {
    stubCapabilities({ badge: false, notification: false })
    const presenter = new CompletionPresenter(options())
    expect(presenter.viable).toBe(false)
    expect(presenter.badgeSupported).toBe(false)
  })

  it('drives the badge alone when notifications are unavailable', () => {
    const badge = stubCapabilities({ permission: 'denied' })
    const sessions = store([summary('a', { running: true })])
    const presenter = new CompletionPresenter(options())
    const detach = presenter.attach(sessions)
    sessions.update((state) => { state.byId['a' as SessionId] = summary('a', { completed: true }) })
    expect(badge.setAppBadge).toHaveBeenCalledWith(1)
    expect(FakeNotification.instances).toEqual([])
    detach()
  })

  it('drives notifications alone when only notifications are available', () => {
    vi.stubGlobal('navigator', {})
    vi.stubGlobal('Notification', FakeNotification)
    const sessions = store([summary('a', { running: true })])
    const presenter = new CompletionPresenter(options())
    expect(presenter.badgeSupported).toBe(false)
    const detach = presenter.attach(sessions)
    sessions.update((state) => { state.byId['a' as SessionId] = summary('a', { completed: true }) })
    expect(FakeNotification.instances).toHaveLength(1)
    detach()
  })

  it('logs a refused notification construction instead of throwing', () => {
    vi.stubGlobal('navigator', {})
    vi.stubGlobal('Notification', class {
      static permission: NotificationPermission = 'granted'
      constructor() { throw new Error('refused') }
    })
    const sessions = store([summary('a', { running: true })])
    const presenter = new CompletionPresenter(options())
    const detach = presenter.attach(sessions)
    expect(() => {
      sessions.update((state) => { state.byId['a' as SessionId] = summary('a', { completed: true }) })
    }).not.toThrow()
    expect(logger.warn).toHaveBeenCalledWith('app-badge: the platform refused the notification', expect.anything())
    detach()
  })

  it('starts announcing the moment a permission is granted, with no reload', () => {
    stubCapabilities({ badge: false, permission: 'default' })
    const sessions = store([summary('a', { running: true })])
    const presenter = new CompletionPresenter(options())
    // Supported but ungranted: nothing may be announced yet, but the page is
    // still worth subscribing to — the settings row can change this.
    expect(presenter.viable).toBe(true)
    expect(presenter.permission()).toBe('default')
    const detach = presenter.attach(sessions)
    sessions.update((state) => { state.byId['a' as SessionId] = summary('a', { completed: true }) })
    expect(FakeNotification.instances).toEqual([])

    // The user grants through the settings row; nothing about the page reloads.
    FakeNotification.permission = 'granted'
    sessions.update((state) => {
      state.ids = ['a' as SessionId, 'b' as SessionId]
      state.byId['b' as SessionId] = summary('b', { completed: true })
    })
    expect(FakeNotification.instances).toHaveLength(1)
    detach()
  })

  it('stops notifying if the permission is revoked mid-session', () => {
    stubCapabilities()
    const sessions = store([summary('a', { running: true })])
    const presenter = new CompletionPresenter(options())
    const detach = presenter.attach(sessions)
    sessions.update((state) => { state.byId['a' as SessionId] = summary('a', { completed: true }) })
    expect(FakeNotification.instances).toHaveLength(1)

    FakeNotification.permission = 'denied'
    sessions.update((state) => {
      state.ids = ['a' as SessionId, 'b' as SessionId]
      state.byId['b' as SessionId] = summary('b', { completed: true })
    })
    expect(FakeNotification.instances).toHaveLength(1)
    detach()
  })

  it('request() delegates to the platform', async () => {
    stubCapabilities({ permission: 'default' })
    FakeNotification.requestResult = 'denied'
    const presenter = new CompletionPresenter(options())
    await expect(presenter.request()).resolves.toBe('denied')
  })

  it('showTest raises a tagged probe that carries no click target', () => {
    stubCapabilities()
    const open = vi.fn()
    const presenter = new CompletionPresenter(options(open))
    expect(presenter.showTest()).toBe(true)
    expect(FakeNotification.instances).toHaveLength(1)
    expect(FakeNotification.instances[0]?.title).toBe('Test notification')
    expect(FakeNotification.instances[0]?.options).toMatchObject({
      body: 'If you can read this, it works.',
      tag: 'dsh-session-completed-test',
    })
    // A test notification has nowhere to go, so it carries no click handler.
    expect(FakeNotification.instances[0]?.onclick).toBeNull()
    expect(open).not.toHaveBeenCalled()
  })

  it('re-alerts the settings-row probe so a repeated test still shows', () => {
    stubCapabilities()
    const presenter = new CompletionPresenter(options())
    expect(presenter.showTest()).toBe(true)
    expect(FakeNotification.instances).toHaveLength(1)
    expect(FakeNotification.instances[0]?.options).toMatchObject({ renotify: true })
  })

  it('logs a display refusal the platform reports after the probe was accepted', () => {
    stubCapabilities()
    const presenter = new CompletionPresenter(options())
    // The error handler is attached to the notification the probe accepted.
    expect(presenter.showTest()).toBe(true)
    expect(FakeNotification.instances).toHaveLength(1)

    const refusal = new Event('error')
    FakeNotification.instances[0]?.onerror?.(refusal)
    expect(logger.warn).toHaveBeenCalledWith(
      'app-badge: the platform refused to display the notification', refusal,
    )
  })

  it('showTest reports failure instead of throwing while the permission is missing', () => {
    stubCapabilities({ permission: 'default' })
    expect(new CompletionPresenter(options()).showTest()).toBe(false)
    expect(FakeNotification.instances).toEqual([])
  })

  it('showTest reports failure when the platform refuses the construction', () => {
    vi.stubGlobal('Notification', class {
      static permission: NotificationPermission = 'granted'
      constructor() { throw new Error('refused') }
    })
    expect(new CompletionPresenter(options()).showTest()).toBe(false)
    expect(logger.warn).toHaveBeenCalledWith('app-badge: the platform refused the notification', expect.anything())
  })
})
