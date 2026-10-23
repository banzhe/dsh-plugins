// @vitest-environment jsdom
/**
 * Badge and notification presentation over a fake capabilities surface: how the
 * LIVE permission (never a startup probe) gates every notification, and how
 * every unsupported or refused capability degrades to a logged no-op.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { SessionSummary } from '@deepseek-ai/dsh-api-session-controller/client'
import type { WorkspaceSnapshot } from '@deepseek-ai/dsh-api-workspace-controller/client'
import {
  AppBadgePresenter, CompletionPresenter, notificationPermission, pickWorkspaceDemoTarget,
  probeCapabilities, requestNotificationPermission,
  type CompletionPresenterOptions,
} from '../src/client/presenter.ts'
import { sessionRow, sessionSources, type SessionRow } from './session-list-double.ts'
import { workspaceSource, workspaceView } from './workspace-source-double.ts'
import { CompletionObserver } from '../src/client/completion.ts'

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

const summary = (id: string, over: Partial<SessionRow> = {}): SessionRow =>
  sessionRow(id, { displayTitle: `Title ${id}`, ...over })

/**
 * Default Session-row reader for the demo pick: every known id resolves to a
 * non-blank row; unknown ids are the host-projected case (undefined). The
 * optional map overrides blankness per id for the pickWorkspaceDemoTarget cases.
 */
function options(
  open = vi.fn(),
  workspaceItems: WorkspaceSnapshot['items'] = [],
  blankIds: ReadonlySet<string> = new Set(),
  workspacesSource: CompletionPresenterOptions['workspaces'] = workspaceSource(workspaceItems).source,
): CompletionPresenterOptions {
  return {
    logger,
    notifyCopy: session => ({ title: 'Session finished', detail: `"${session.displayTitle}" finished.` }),
    testCopy: () => ({ title: 'Test notification', detail: 'If you can read this, it works.' }),
    demoCopy: () => ({ title: 'Jump demo', detail: 'Click to a random Workspace Session.' }),
    open,
    workspaces: workspacesSource,
    sessionSummary: (id) => {
      const row = summary(id)
      return blankIds.has(id) ? { ...row, blank: true } : row
    },
    tag: 'dsh-session-completed',
    testTag: 'dsh-session-completed-test',
    demoTag: 'dsh-session-completed-demo',
  }
}

const workspace = (workspaceId: string, sessionIds: string[]): WorkspaceSnapshot['items'][number] =>
  workspaceView(workspaceId, sessionIds)

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
  /**
   * The two notifications the presenter can raise. Each family of rows below
   * varies only which one is in flight: both carry the same options, and both
   * report a refusal the platform decides on after accepting the construction
   * through the same `error` event.
   */
  const RAISED: ReadonlyArray<readonly [label: string, raise: () => () => void]> = [
    ['a finished Session', () => {
      const sessions = sessionSources([summary('a', { running: true })])
      const detach = new CompletionPresenter(options()).attach(sessions.status, sessions.list)
      sessions.update((state) => { state.byId['a' as SessionId] = summary('a', { completed: true }) })
      return detach
    }],
    ['the settings-row probe', () => {
      expect(new CompletionPresenter(options()).showTest()).toBe(true)
      return () => {}
    }],
  ]

  it('projects the finished count and notifies each newly finished Session', () => {
    const badge = stubCapabilities()
    const sessions = sessionSources([summary('a', { running: true })])
    const open = vi.fn()
    const presenter = new CompletionPresenter(options(open))
    expect(presenter.viable).toBe(true)
    const detach = presenter.attach(sessions.status, sessions.list)

    sessions.update((state) => { state.byId['a' as SessionId] = summary('a', { completed: true }) })
    expect(badge.setAppBadge).toHaveBeenCalledWith(1)
    expect(FakeNotification.instances).toHaveLength(1)
    expect(FakeNotification.instances[0]?.title).toBe('Session finished')
    expect(FakeNotification.instances[0]?.options).toMatchObject({
      body: '"Title a" finished.',
      tag: 'dsh-session-completed',
    })

    // Chromium on Windows does not raise the page on its own, so the click must
    // ask, or the Session switches behind the foreground app.
    const focus = vi.spyOn(window, 'focus')
    FakeNotification.instances[0]?.onclick?.()
    expect(open).toHaveBeenCalledWith('a')
    expect(focus).toHaveBeenCalled()
    expect(FakeNotification.instances[0]?.close).toHaveBeenCalled()
    detach()
  })

  it('asks the Desktop shell to raise the window instead of focusing in place', () => {
    stubCapabilities()
    const sessions = sessionSources([summary('a', { running: true })])
    const reveal = vi.fn(async () => {})
    vi.stubGlobal('dshDesktop', { protocolVersion: 1, window: { reveal } })
    const open = vi.fn()
    const presenter = new CompletionPresenter(options(open))
    const detach = presenter.attach(sessions.status, sessions.list)

    sessions.update((state) => { state.byId['a' as SessionId] = summary('a', { completed: true }) })
    FakeNotification.instances[0]?.onclick?.()

    expect(reveal).toHaveBeenCalledTimes(1)
    expect(open).toHaveBeenCalledWith('a')
    detach()
  })

  it('degrades to focusing in place on a shell without the reveal channel', () => {
    stubCapabilities()
    const sessions = sessionSources([summary('a', { running: true })])
    vi.stubGlobal('dshDesktop', { protocolVersion: 1, updates: {} })
    const open = vi.fn()
    const presenter = new CompletionPresenter(options(open))
    const detach = presenter.attach(sessions.status, sessions.list)

    sessions.update((state) => { state.byId['a' as SessionId] = summary('a', { completed: true }) })
    const focus = vi.spyOn(window, 'focus')
    expect(() => { FakeNotification.instances[0]?.onclick?.() }).not.toThrow()
    expect(focus).toHaveBeenCalled()
    expect(open).toHaveBeenCalledWith('a')
    detach()
  })

  it('survives a refused reveal IPC without an unhandled rejection', async () => {
    stubCapabilities()
    const sessions = sessionSources([summary('a', { running: true })])
    const reveal = vi.fn(() => Promise.reject(new Error('dsh desktop: rejected IPC')))
    vi.stubGlobal('dshDesktop', { protocolVersion: 1, window: { reveal } })
    const open = vi.fn()
    const presenter = new CompletionPresenter(options(open))
    const detach = presenter.attach(sessions.status, sessions.list)

    sessions.update((state) => { state.byId['a' as SessionId] = summary('a', { completed: true }) })
    expect(() => { FakeNotification.instances[0]?.onclick?.() }).not.toThrow()
    await vi.waitFor(() => { expect(reveal).toHaveBeenCalledTimes(1) })
    // The click still navigates: a refused raise is not a refused Session switch.
    expect(open).toHaveBeenCalledWith('a')
    expect(FakeNotification.instances[0]?.close).toHaveBeenCalled()
    detach()
  })

  it.each(RAISED)('re-alerts %s so a same-tag replacement still shows', (_label, raise) => {
    stubCapabilities()
    const detach = raise()
    expect(FakeNotification.instances).toHaveLength(1)
    // Chromium suppresses every same-tag banner after the first unless renotify
    // is set, which would make the count silently stop alerting.
    expect(FakeNotification.instances[0]?.options).toMatchObject({ renotify: true })
    detach()
  })

  it.each(RAISED)('logs a display refusal the platform reports after %s was accepted', (_label, raise) => {
    stubCapabilities()
    const detach = raise()
    expect(FakeNotification.instances).toHaveLength(1)

    const refusal = new Event('error')
    FakeNotification.instances[0]?.onerror?.(refusal)
    expect(logger.warn).toHaveBeenCalledWith(
      'app-badge: the platform refused to display the notification', refusal,
    )
    // A late refusal is reported, not retried.
    expect(FakeNotification.instances).toHaveLength(1)
    detach()
  })

  it('announces nobody for the state a page loads into', () => {
    const badge = stubCapabilities()
    const presenter = new CompletionPresenter(options())
    const loaded = sessionSources([summary('a', { completed: true })])
    const detach = presenter.attach(loaded.status, loaded.list)
    expect(badge.setAppBadge).toHaveBeenCalledWith(1)
    expect(FakeNotification.instances).toEqual([])
    detach()
  })

  it('drives neither surface for a subagent child that finishes', () => {
    const badge = stubCapabilities()
    const sessions = sessionSources([summary('a', { running: true })])
    const presenter = new CompletionPresenter(options())
    const detach = presenter.attach(sessions.status, sessions.list)

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
    const sessions = sessionSources([summary('a', { completed: true })])
    const presenter = new CompletionPresenter(options())
    const detach = presenter.attach(sessions.status, sessions.list)
    detach()
    expect(badge.clearAppBadge).toHaveBeenCalledTimes(1)
    sessions.update((state) => { state.byId['a' as SessionId] = summary('a', { completed: true, updatedAt: 2 }) })
    expect(badge.setAppBadge).toHaveBeenCalledTimes(1)
  })

  it('keeps an archived Session off both surfaces and counts it back on restore', () => {
    const badge = stubCapabilities()
    const workspaces = workspaceSource()
    const sessions = sessionSources([summary('a', { running: true })])
    const presenter = new CompletionPresenter(options(vi.fn(), [], new Set(), workspaces.source))
    const detach = presenter.attach(sessions.status, sessions.list)
    sessions.update((state) => { state.byId['a' as SessionId] = summary('a', { completed: true }) })
    expect(FakeNotification.instances).toHaveLength(1)
    expect(badge.setAppBadge).toHaveBeenCalledTimes(1)

    // Archiving changes only the archive set: neither the status nor the list
    // moves, so the workspace subscription is the only wake-up. A zero count is
    // a retraction, not a `setAppBadge(0)`.
    const retractions = badge.clearAppBadge.mock.calls.length
    workspaces.archive('a' as SessionId)
    expect(badge.clearAppBadge).toHaveBeenCalledTimes(retractions + 1)
    // A restore brings the row back without a second announcement.
    workspaces.unarchive()
    expect(badge.setAppBadge).toHaveBeenCalledTimes(2)
    expect(FakeNotification.instances).toHaveLength(1)
    detach()
  })

  it('never announces a Session that finishes while it is archived', () => {
    const badge = stubCapabilities()
    const workspaces = workspaceSource()
    const sessions = sessionSources([summary('a', { running: true })])
    const presenter = new CompletionPresenter(options(vi.fn(), [], new Set(), workspaces.source))
    const detach = presenter.attach(sessions.status, sessions.list)
    workspaces.archive('a' as SessionId)
    sessions.update((state) => { state.byId['a' as SessionId] = summary('a', { completed: true }) })
    expect(FakeNotification.instances).toEqual([])
    // The count never left zero, so the retraction is the only badge write.
    expect(badge.setAppBadge).not.toHaveBeenCalled()
    expect(badge.clearAppBadge).toHaveBeenCalledTimes(1)
    detach()
  })

  it('subscribes to the archive set for the subscription lifetime only', () => {
    const badge = stubCapabilities()
    const workspaces = workspaceSource()
    const sessions = sessionSources([summary('a', { completed: true })])
    const presenter = new CompletionPresenter(options(vi.fn(), [], new Set(), workspaces.source))
    const detach = presenter.attach(sessions.status, sessions.list)
    expect(badge.setAppBadge).toHaveBeenCalledTimes(1)
    detach()
    // The archive set moved after detach, and nothing may react to it.
    workspaces.archive('a' as SessionId)
    expect(badge.clearAppBadge).toHaveBeenCalledTimes(1)
  })

  it('rebuilds the archive lookup only when the archive array itself moves', () => {
    stubCapabilities()
    const workspaces = workspaceSource()
    const sessions = sessionSources([summary('a', { running: true })])
    const presenter = new CompletionPresenter(options(vi.fn(), [], new Set(), workspaces.source))
    // Capture the lookup `apply` hands the fold, which is what the cache reuses.
    const observe = vi.spyOn(CompletionObserver.prototype, 'observe')
    const setsSeen = (): readonly ReadonlySet<SessionId>[] => observe.mock.calls.map(call => call[2])
    const detach = presenter.attach(sessions.status, sessions.list)

    // Two syncs with an unchanged archive array reuse one set.
    sessions.update((state) => { state.byId['a' as SessionId] = summary('a', { completed: true, updatedAt: 2 }) })
    sessions.update((state) => { state.byId['a' as SessionId] = summary('a', { completed: true, updatedAt: 3 }) })
    const [first, second] = setsSeen().slice(-2)
    expect(first).toBe(second)

    // An archive mutation is a new array, so the next sync rebuilds.
    workspaces.archive('a' as SessionId)
    const rebuilt = setsSeen().at(-1)
    expect(rebuilt).not.toBe(first)
    expect(rebuilt?.has('a' as SessionId)).toBe(true)
    observe.mockRestore()
    detach()
  })

  it('stays inert with neither surface available', () => {
    stubCapabilities({ badge: false, notification: false })
    const presenter = new CompletionPresenter(options())
    expect(presenter.viable).toBe(false)
    expect(presenter.badgeSupported).toBe(false)
  })

  it('drives the badge alone when notifications are unavailable', () => {
    const badge = stubCapabilities({ permission: 'denied' })
    const sessions = sessionSources([summary('a', { running: true })])
    const presenter = new CompletionPresenter(options())
    const detach = presenter.attach(sessions.status, sessions.list)
    sessions.update((state) => { state.byId['a' as SessionId] = summary('a', { completed: true }) })
    expect(badge.setAppBadge).toHaveBeenCalledWith(1)
    expect(FakeNotification.instances).toEqual([])
    detach()
  })

  it('drives notifications alone when only notifications are available', () => {
    vi.stubGlobal('navigator', {})
    vi.stubGlobal('Notification', FakeNotification)
    const sessions = sessionSources([summary('a', { running: true })])
    const presenter = new CompletionPresenter(options())
    expect(presenter.badgeSupported).toBe(false)
    const detach = presenter.attach(sessions.status, sessions.list)
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
    const sessions = sessionSources([summary('a', { running: true })])
    const presenter = new CompletionPresenter(options())
    const detach = presenter.attach(sessions.status, sessions.list)
    expect(() => {
      sessions.update((state) => { state.byId['a' as SessionId] = summary('a', { completed: true }) })
    }).not.toThrow()
    expect(logger.warn).toHaveBeenCalledWith('app-badge: the platform refused the notification', expect.anything())
    detach()
  })

  it('starts announcing the moment a permission is granted, with no reload', () => {
    stubCapabilities({ badge: false, permission: 'default' })
    const sessions = sessionSources([summary('a', { running: true })])
    const presenter = new CompletionPresenter(options())
    // Supported but ungranted: nothing may be announced yet, but the page is
    // still worth subscribing to — the settings row can change this mid-session.
    expect(presenter.viable).toBe(true)
    expect(presenter.permission()).toBe('default')
    const detach = presenter.attach(sessions.status, sessions.list)
    sessions.update((state) => { state.byId['a' as SessionId] = summary('a', { completed: true }) })
    expect(FakeNotification.instances).toEqual([])

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
    const sessions = sessionSources([summary('a', { running: true })])
    const presenter = new CompletionPresenter(options())
    const detach = presenter.attach(sessions.status, sessions.list)
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
    // A test notification has nowhere to go.
    expect(FakeNotification.instances[0]?.onclick).toBeNull()
    expect(open).not.toHaveBeenCalled()
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

  it('showDemo raises a tagged notification whose click lands on the picked Session', () => {
    stubCapabilities()
    const open = vi.fn()
    const presenter = new CompletionPresenter(options(open, [workspace('w1', ['s1', 's2'])]))
    // The deterministic seed picks the second Session.
    expect(presenter.showDemo(() => 0.75)).toBe(true)
    expect(FakeNotification.instances).toHaveLength(1)
    expect(FakeNotification.instances[0]?.title).toBe('Jump demo')
    expect(FakeNotification.instances[0]?.options).toMatchObject({ tag: 'dsh-session-completed-demo' })
    FakeNotification.instances[0]?.onclick?.()
    expect(open).toHaveBeenCalledWith('s2')
  })

  it('showDemo refuses instead of raising when every Sessions is blank', () => {
    stubCapabilities()
    // The options() reader marks 's1' blank; no landing target survives and the
    // refusal happens before construction, so no notification (or retry) exists.
    const open = vi.fn()
    const presenter = new CompletionPresenter(
      options(open, [workspace('w1', ['s1'])], new Set(['s1'])),
    )
    expect(presenter.showDemo(() => 0.75)).toBe(false)
    expect(FakeNotification.instances).toEqual([])
    expect(open).not.toHaveBeenCalled()
  })

  it('showDemo refuses instead of raising when no Workspace holds a Session', () => {
    stubCapabilities()
    expect(new CompletionPresenter(options()).showDemo(() => 0)).toBe(false)
    expect(FakeNotification.instances).toEqual([])
  })

  it('showDemo reports the construction refusal the platform raises', () => {
    stubCapabilities()
    vi.stubGlobal('Notification', class {
      static permission: NotificationPermission = 'granted'
      constructor() { throw new Error('refused') }
    })
    expect(new CompletionPresenter(options(vi.fn(), [workspace('w1', ['s1'])])).showDemo()).toBe(false)
    expect(logger.warn).toHaveBeenCalledWith('app-badge: the platform refused the notification', expect.anything())
  })

  it('showDemo skips a blank Session and lands on the next non-blank row', () => {
    stubCapabilities()
    const open = vi.fn()
    // 's1' is blank and refused; 's2' remains the sole candidate, so either
    // first/second branch lands on the same row.
    const presenter = new CompletionPresenter(
      options(open, [workspace('w1', ['s1', 's2'])], new Set(['s1'])),
    )
    expect(presenter.showDemo(() => 0.75)).toBe(true)
    FakeNotification.instances[0]?.onclick?.()
    expect(open).toHaveBeenCalledWith('s2')
  })

  describe('with the desktop notifications channel', () => {
    function stubDesktopBridge(): {
      show: ReturnType<typeof vi.fn<(request: { id: string; title: string; body: string }) => Promise<boolean>>>
      activations: Array<(activation: { id?: string }) => void>
      emit: (id: string) => void
    } {
      const activations: Array<(activation: { id?: string }) => void> = []
      const show = vi.fn(async () => true)
      vi.stubGlobal('dshDesktop', {
        protocolVersion: 1,
        window: { reveal: vi.fn(async () => {}) },
        notifications: {
          show,
          close: vi.fn(async () => {}),
          onActivate: (listener: (activation: { id?: string }) => void) => {
            activations.push(listener)
            return () => { activations.splice(activations.indexOf(listener), 1) }
          },
        },
      })
      return { show, activations, emit: (id: string) => { for (const listen of activations) listen({ id }) } }
    }

    it('prefers the desktop channel over the HTML5 constructor', () => {
      stubCapabilities()
      const bridge = stubDesktopBridge()
      const sessions = sessionSources([summary('a', { running: true })])
      const open = vi.fn()
      const presenter = new CompletionPresenter(options(open))
      const detach = presenter.attach(sessions.status, sessions.list)
      sessions.update((state) => { state.byId['a' as SessionId] = summary('a', { completed: true }) })
      expect(bridge.show).toHaveBeenCalledOnce()
      expect(bridge.show.mock.calls[0]?.[0]).toMatchObject({ title: 'Session finished', body: '"Title a" finished.' })
      expect(FakeNotification.instances).toEqual([])
      // Activation through the shell lands the same click target.
      const raised = bridge.show.mock.calls[0]?.[0]
      if (raised !== undefined) bridge.emit(raised.id)
      expect(open).toHaveBeenCalledWith('a')
      detach()
      presenter.detach()
    })

    it('activation for a consumed or unknown id runs the target at most once', () => {
      stubCapabilities()
      const bridge = stubDesktopBridge()
      const sessions = sessionSources([summary('a', { running: true })])
      const open = vi.fn()
      const presenter = new CompletionPresenter(options(open))
      const detach = presenter.attach(sessions.status, sessions.list)
      sessions.update((state) => { state.byId['a' as SessionId] = summary('a', { completed: true }) })
      const id = bridge.show.mock.calls[0]?.[0]?.id as string
      bridge.emit(id)
      bridge.emit(id)
      bridge.emit('unknown-id')
      expect(open).toHaveBeenCalledOnce()
      presenter.detach()
      // After dispose the subscription is gone; further activations do nothing.
      bridge.emit(id)
      expect(open).toHaveBeenCalledOnce()
      detach()
    })

    it('releases a pending click target when the shell refuses the request', async () => {
      stubCapabilities()
      const bridge = stubDesktopBridge()
      bridge.show.mockResolvedValue(false)
      const sessions = sessionSources([summary('a', { running: true })])
      const open = vi.fn()
      const presenter = new CompletionPresenter(options(open))
      const detach = presenter.attach(sessions.status, sessions.list)
      sessions.update((state) => { state.byId['a' as SessionId] = summary('a', { completed: true }) })
      await vi.waitFor(() => { expect(bridge.show).toHaveBeenCalledOnce() })
      const id = bridge.show.mock.calls[0]?.[0]?.id as string
      bridge.emit(id)
      await Promise.resolve()
      expect(open).not.toHaveBeenCalled()
      presenter.detach()
      detach()
    })

    it('logs a rejected request and still reports the raise accepted', async () => {
      stubCapabilities()
      const bridge = stubDesktopBridge()
      bridge.show.mockRejectedValue(new Error('dsh desktop: rejected IPC'))
      const sessions = sessionSources([summary('a', { running: true })])
      const presenter = new CompletionPresenter(options())
      const detach = presenter.attach(sessions.status, sessions.list)
      sessions.update((state) => { state.byId['a' as SessionId] = summary('a', { completed: true }) })
      await vi.waitFor(() => { expect(logger.warn).toHaveBeenCalledWith('app-badge: the shell refused the notification', expect.anything()) })
      presenter.detach()
      detach()
    })

    it('still uses HTML5 when the channel predates notifications', () => {
      stubCapabilities()
      vi.stubGlobal('dshDesktop', { protocolVersion: 1, window: { reveal: vi.fn(async () => {}) } })
      const sessions = sessionSources([summary('a', { running: true })])
      const open = vi.fn()
      const presenter = new CompletionPresenter(options(open))
      const detach = presenter.attach(sessions.status, sessions.list)
      sessions.update((state) => { state.byId['a' as SessionId] = summary('a', { completed: true }) })
      expect(FakeNotification.instances).toHaveLength(1)
      presenter.detach()
      detach()
    })
  })
})

describe('pickWorkspaceDemoTarget', () => {
  const snapshot = (items: WorkspaceSnapshot['items'], phase: WorkspaceSnapshot['phase'] = 'ready'): WorkspaceSnapshot =>
    ({ items, archivedSessionIds: [], pinnedSessionIds: [], state: 'idle', phase, error: null })

  const nonBlank = (...blank: readonly string[]) =>
    (id: string): SessionSummary => blank.includes(id)
      ? { ...summary(id), blank: true }
      : summary(id)

  it('takes the first Session of the Workspace the random source selects', () => {
    const target = pickWorkspaceDemoTarget(
      snapshot([workspace('w1', ['s1', 's2']), workspace('w2', ['s3'])]), nonBlank(), () => 0.75,
    )
    expect(target).toBe('s3')
  })

  it('lands on the second Session when the random source picks the branch', () => {
    const target = pickWorkspaceDemoTarget(
      snapshot([workspace('w1', ['s1', 's2', 's3'])]), nonBlank(), () => 0.6,
    )
    expect(target).toBe('s2')
  })

  it('lands on a single-candidate Workspace either way', () => {
    for (const random of [() => 0, () => 0.999]) {
      expect(pickWorkspaceDemoTarget(snapshot([workspace('w1', ['s1'])]), nonBlank(), random)).toBe('s1')
    }
  })

  it('skips Workspaces with no non-blank Sessions', () => {
    const target = pickWorkspaceDemoTarget(
      snapshot([workspace('empty', []), workspace('mixed', ['blank1', 's1']), workspace('filled', ['s2'])]),
      nonBlank('blank1'),
      () => 0.4,
    )
    // After 'mixed' is filtered to ['s1'], the candidates are ['s1'] (from
    // 'mixed') and ['s2'] (from 'filled'); random() = 0.4 lands on the first
    // candidate, and the half-split pick takes its 's1'.
    expect(target).toBe('s1')
  })

  it('refuses a Workspace whose Sessions are all blank or unknown', () => {
    const target = pickWorkspaceDemoTarget(
      snapshot([workspace('w1', ['blank1']), workspace('w2', [])]), nonBlank('blank1'), () => 0,
    )
    expect(target).toBeUndefined()
  })

  it('refuses an id unknown to the Session list; every-blank workspaces leave undefined', () => {
    // The reader is never wired to unknown ids, so an all-unknown workspace is skipped.
    const target = pickWorkspaceDemoTarget(
      snapshot([workspace('w1', ['ghost'])]), () => undefined, () => 0.9,
    )
    expect(target).toBeUndefined()
  })

  it('returns undefined with no candidates or an unsettled list', () => {
    expect(pickWorkspaceDemoTarget(snapshot([]), nonBlank())).toBeUndefined()
    expect(pickWorkspaceDemoTarget(snapshot([], 'pending'), nonBlank())).toBeUndefined()
  })
})
