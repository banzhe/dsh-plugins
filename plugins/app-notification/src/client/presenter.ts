/**
 * Browser presentation of the finished-unread Session count: the installed-PWA
 * icon badge (`navigator.setAppBadge`) and one system notification per Session
 * that finishes while the page is open.
 *
 * Both APIs are optional and platform-dependent, so the presenter never throws
 * and never retries: it reads the capability once per apply, reports a refusal
 * through the Cordis logger, and leaves the in-app surfaces (the sidebar's green
 * dot) as the authority. Pure browser-API writes with no React involvement, so
 * disposal is the single `unsubscribe` the caller owns.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { SessionListState, SessionSummary } from '@deepseek-ai/dsh-api-session-controller/client'
import type { WorkspaceSnapshot } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { SessionStatusSnapshot } from '@deepseek-ai/dsh-client-ui-session/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { CompletionObserver } from './completion.ts'

/** Capability slice of `navigator` this presenter uses. */
interface AppBadgeNavigator {
  setAppBadge?: (contents?: number) => Promise<void>
  clearAppBadge?: () => Promise<void>
}

/**
 * Read the badging slice of the live `navigator`. The lib.dom `Navigator` type
 * declares both methods required, so reading them through this interface alone
 * is what keeps them optional for the capability guards below.
 */
function appBadgeNavigator(): AppBadgeNavigator {
  return navigator
}

/**
 * `NotificationOptions` as Chromium implements it: the lib.dom type this package
 * compiles against stops at `tag`, but the Windows bridge reads one option past
 * it — `renotify`, the only switch that lets a same-`tag` replacement re-alert.
 */
interface RealertingNotificationOptions extends NotificationOptions {
  renotify?: boolean
}

/**
 * The Desktop shell's window bridge, as the Web UI sees it. `dshDesktop` is the
 * shell's fixed preload whitelist, so this slice is the capability probe: a page
 * loaded in a browser has no `dshDesktop` at all, and a shell predating the
 * channel has one without `window`.
 */
interface DesktopWindowBridge {
  readonly dshDesktop?: {
    readonly window?: {
      readonly reveal?: () => Promise<void>
    }
    readonly notifications?: {
      readonly show?: (request: { readonly id: string; readonly title: string; readonly body: string }) => Promise<boolean>
      readonly close?: (id: string) => Promise<void>
      readonly onActivate?: (listener: (activation: { readonly id?: string }) => void) => (() => void)
    }
  }
}

/**
 * Read the shell's notification bridge, or undefined where the page cannot use
 * it: a browser, or a shell whose whitelist predates the channel. The bridge is
 * preferred over the HTML5 constructor because its activations reach the
 * renderer from the Windows notification center, which Chromium's own
 * notifications cannot.
 */
function desktopNotifications(): NonNullable<DesktopWindowBridge['dshDesktop']>['notifications'] | undefined {
  const bridge = (globalThis as DesktopWindowBridge).dshDesktop?.notifications
  return bridge !== undefined && typeof bridge.show === 'function' && typeof bridge.onActivate === 'function'
    ? bridge
    : undefined
}

/**
 * Read the shell's window-reveal operation, or undefined when this page cannot
 * raise its own window. Absence is the version probe, so the plugin never has to
 * compare protocol versions; it is also why the caller must swallow the
 * rejection a refused IPC produces.
 */
function desktopWindowReveal(): (() => Promise<void>) | undefined {
  const reveal = (globalThis as DesktopWindowBridge).dshDesktop?.window?.reveal
  return typeof reveal === 'function' ? reveal : undefined
}

/** Locale-resolved strings one notification carries. */
export interface NotificationCopy {
  /** Notification heading. */
  readonly title: string
  /** Notification body, with the Session label already interpolated. */
  readonly detail: string
}

/** Inputs the presenter needs from its owning plugin. */
export interface CompletionPresenterOptions {
  /** Cordis logger for the one-shot capability refusals. */
  readonly logger: Context['logger']
  /** Resolve one Session row's notification copy in the active locale. */
  readonly notifyCopy: (session: SessionSummary) => NotificationCopy
  /** Resolve the settings row's test-notification copy in the active locale. */
  readonly testCopy: () => NotificationCopy
  /** Resolve the demo-notification copy in the active locale. */
  readonly demoCopy: () => NotificationCopy
  /** Open the Session a notification was clicked for. */
  readonly open: (id: SessionId) => void
  /**
   * The live Workspace Controller source. Its registry-global archive set is
   * what gates a finished Session out of both surfaces — a Session the user
   * filed away is not work waiting for a look — and its rows are what the demo
   * pick chooses from (`phase: 'pending'` means the demo refuses).
   *
   * It is a source, not a reader: archiving a finished Session changes neither
   * the status nor the list, so a subscription to this one is the only wake-up
   * that lets the badge stop counting it.
   */
  readonly workspaces: ObservableSnapshot<WorkspaceSnapshot>
  /**
   * Read one Session's list row for the demo pick, or undefined when the
   * Session Controller has not projected the id yet. Blank rows (a Session
   * with no accepted prompt) are refused as demo landing targets: clicking
   * the notification would only open an empty conversation.
   */
  readonly sessionSummary: (id: SessionId) => SessionSummary | undefined
  /** Notification tag; one tag replaces the previous notification, and each replacement re-alerts. */
  readonly tag: string
  /** Test-notification tag; distinct from {@link tag} so a probe never displaces a real announcement. */
  readonly testTag: string
  /** Demo-notification tag; distinct so a demo never displaces a real announcement either. */
  readonly demoTag: string
}

/**
 * Permission as the settings row needs to display it: the platform's own
 * answer, plus the one state the platform has no word for (no constructor).
 */
export type NotificationPermissionState = NotificationPermission | 'unsupported'

/**
 * Support and permission stay separate members on purpose: the permission is
 * granted and revoked at runtime, so it can never be folded into a one-shot
 * capability.
 */
export interface CompletionCapabilities {
  /** Both `navigator.setAppBadge` and `navigator.clearAppBadge` exist. */
  readonly badge: boolean
  /** The `Notification` constructor exists, whatever the current permission is. */
  readonly notificationSupported: boolean
  /** Supported AND currently granted — the only state a notification may be built in. */
  readonly notificationGranted: boolean
}

/** Which surfaces this page can use; all false outside a capable browser. */
export function probeCapabilities(): CompletionCapabilities {
  if (typeof navigator === 'undefined') {
    return { badge: false, notificationSupported: false, notificationGranted: false }
  }
  const badge = appBadgeNavigator()
  const supported = typeof Notification === 'function'
  return {
    badge: typeof badge.setAppBadge === 'function'
      && typeof badge.clearAppBadge === 'function',
    notificationSupported: supported,
    // The permission is the gate, not the constructor: a `default` permission
    // would make every construction throw, and `denied` would discard it
    // silently. Neither is a state this presenter may turn into a notification.
    notificationGranted: supported && Notification.permission === 'granted',
  }
}

/**
 * Read the current notification permission without narrowing it to a boolean:
 * the settings row distinguishes `denied` from `default`, and `unsupported` is
 * the one state the platform cannot report about itself.
 */
export function notificationPermission(): NotificationPermissionState {
  return typeof Notification === 'function' ? Notification.permission : 'unsupported'
}

/** Ask the browser for notification permission. Must run inside a user gesture:
 * every browser discards the request otherwise, which is why the settings row's
 * button — and never plugin activation — is the only caller.
 */
export async function requestNotificationPermission(): Promise<NotificationPermissionState> {
  if (typeof Notification !== 'function') return 'unsupported'
  return await Notification.requestPermission()
}

/**
 * Pick the demo notification's landing Session: a uniformly random Workspace,
 * then its first or second non-blank Session. A Workspace whose Sessions are
 * all blank (no accepted prompt yet) is skipped, as is one with no Sessions;
 * a Workspace reduced to a single candidate always lands on it.
 * @param snapshot - the Workspace Controller snapshot.
 * @param summary - one Session's list row; undefined or `blank` rows are
 *   refused as landing targets, so a click never opens an empty conversation.
 * @param random - the randomness source, injectable for tests.
 * @returns the picked Session id, or undefined when no Workspace holds any.
 */
export function pickWorkspaceDemoTarget(
  snapshot: WorkspaceSnapshot,
  summary: (id: SessionId) => SessionSummary | undefined,
  random: () => number = Math.random,
): SessionId | undefined {
  if (snapshot.phase !== 'ready') return undefined
  const sessionsOf = (workspace: WorkspaceSnapshot['items'][number]): readonly SessionId[] =>
    workspace.sessionIds
      .filter(id => {
        const row = summary(id)
        return row !== undefined && !row.blank
      })
  const candidates = snapshot.items
    .map(workspace => ({ workspace, sessions: sessionsOf(workspace) }))
    .filter((entry): entry is { workspace: WorkspaceSnapshot['items'][number]; sessions: readonly SessionId[] } =>
      entry.sessions.length > 0)
  if (candidates.length === 0) return undefined
  const picked = candidates.at(Math.floor(random() * candidates.length))
  // The filter just proved a surviving entry, so only a broken `random()`
  // (beyond [0, 1)) can miss; degrade to the first candidate rather than
  // raising an empty notification.
  if (picked === undefined) return candidates[0]?.sessions[0]
  const first = random() < 0.5
  const index = first || picked.sessions.length === 1 ? 0 : 1
  return picked.sessions[index]
}

/** Project the finished-unread count onto the installed-PWA icon badge. */
export class AppBadgePresenter {
  /** Count written by the last successful projection; undefined before the first. */
  private applied: number | undefined
  private readonly write: ((contents?: number) => Promise<void>) | undefined
  private readonly retract: (() => Promise<void>) | undefined

  constructor(private readonly logger: Context['logger']) {
    const badge = appBadgeNavigator()
    this.write = badge.setAppBadge?.bind(badge)
    this.retract = badge.clearAppBadge?.bind(badge)
  }

  /**
   * Set or clear the badge to match `count` (0 clears). A repeated count is a
   * no-op, so unrelated list updates do not re-issue the same platform call.
   */
  project(count: number): void {
    if (this.applied === count) return
    this.applied = count
    const call = count === 0 ? this.retract : this.write
    // A rejected promise is the documented shape of an unsupported platform
    // (notably the Windows taskbar); logging keeps it from becoming an
    // unhandled rejection without pretending the badge worked.
    void call?.call(navigator, count === 0 ? undefined : count).catch((error: unknown) => {
      this.logger.warn('app-badge: the platform refused the icon badge', error)
    })
  }

  /** Retract the badge so a disposed plugin leaves no stale count behind. */
  clear(): void {
    this.applied = undefined
    void this.retract?.call(navigator).catch((error: unknown) => {
      this.logger.warn('app-badge: the platform refused to clear the icon badge', error)
    })
  }
}

/** Drives both surfaces from the Session list. Owns one subscription; the caller disposes it. */
export class CompletionPresenter {
  private readonly observer = new CompletionObserver()
  private readonly capabilities = probeCapabilities()
  private readonly badge: AppBadgePresenter | undefined
  /** Live desktop notifications channel, probed once; a browser has none. */
  private readonly desktop: NonNullable<DesktopWindowBridge['dshDesktop']>['notifications'] | undefined
  /** Monotonic id source for desktop notifications; one per raised notification. */
  private desktopSequence = 0
  /** Click targets by desktop-notification id, keyed for the activation callback. */
  private readonly pendingClicks = new Map<string, () => void>()
  private readonly disposeActivation: (() => void) | undefined
  /** The last archive set handed to the observer, keyed by the array it came from. */
  private archivedCache: { readonly ids: readonly SessionId[]; readonly set: ReadonlySet<SessionId> } | undefined

  constructor(private readonly options: CompletionPresenterOptions) {
    // Only badging is probed once: the API's presence cannot change during a
    // page's life. Notification permission CAN, so it is read per use.
    this.badge = this.capabilities.badge ? new AppBadgePresenter(options.logger) : undefined
    this.desktop = desktopNotifications()
    const onActivate = this.desktop?.onActivate
    this.disposeActivation = onActivate === undefined
      ? undefined
      : onActivate(({ id }) => {
        if (id === undefined) return
        const onClick = this.pendingClicks.get(id)
        if (onClick === undefined) return
        this.pendingClicks.delete(id)
        onClick()
      })
  }

  /**
   * Whether this page could EVER show a surface — the subscription test. True
   * while a notification permission is merely ungranted (or even denied),
   * because the settings row can still change that: subscribing now is what
   * makes the very next completion after a grant land, with no reload.
   */
  get viable(): boolean {
    return this.badge !== undefined || this.capabilities.notificationSupported
  }

  get badgeSupported(): boolean {
    return this.badge !== undefined
  }

  /** Read the live notification permission (never a cached probe result). */
  permission(): NotificationPermissionState {
    return notificationPermission()
  }

  /** Ask for notification permission; must be called from a user gesture. */
  async request(): Promise<NotificationPermissionState> {
    return await requestNotificationPermission()
  }

  /**
   * Install the status, list, and archive subscriptions and publish the current
   * state once. Call exactly once per presenter — the caller owns the lifetime
   * decision. The disposer unsubscribes and retracts the badge.
   * @param status - per-Session status source (`ctx.uiSession.sessionStatus`).
   * @param list - Session catalog source (`ctx.sessions.list`).
   */
  attach(status: ObservableSnapshot<SessionStatusSnapshot>, list: ObservableSnapshot<SessionListState>): () => void {
    const sync = (): void => {
      this.apply(status.getSnapshot(), list.getSnapshot(), this.options.workspaces.getSnapshot())
    }
    const unsubscribeStatus = status.subscribe(sync)
    const unsubscribeList = list.subscribe(sync)
    // Archiving a finished Session moves neither the status nor the list, so
    // without this subscription the badge would keep counting a row the user
    // just filed away.
    const unsubscribeWorkspaces = this.options.workspaces.subscribe(sync)
    sync()
    return () => {
      unsubscribeStatus()
      unsubscribeList()
      unsubscribeWorkspaces()
      this.badge?.clear()
    }
  }

  /**
   * Show the settings row's test notification. A distinct tag keeps the probe
   * from replacing (or being replaced by) a real completion announcement.
   */
  showTest(): boolean {
    return this.notify(this.options.testCopy(), this.options.testTag)
  }

  /**
   * Show the demo notification: clicking it jumps to one random Workspace's
   * first or second non-blank Session. Refused, without raising, when no
   * Workspace holds one — the click target must exist beforehand, because a
   * notification click has no retry.
   */
  showDemo(random: () => number = Math.random): boolean {
    const target = pickWorkspaceDemoTarget(
      this.options.workspaces.getSnapshot(), this.options.sessionSummary, random,
    )
    if (target === undefined) return false
    return this.notify(this.options.demoCopy(), this.options.demoTag, () => {
      this.options.open(target)
    })
  }

  /** Fold one observation onto the badge and the notification stream. */
  private apply(
    status: SessionStatusSnapshot,
    list: SessionListState,
    workspaces: WorkspaceSnapshot,
  ): void {
    const observation = this.observer.observe(
      status, list, this.archivedSet(workspaces.archivedSessionIds),
    )
    this.badge?.project(observation.completed.length)
    for (const session of observation.newlyCompleted) {
      this.notify(this.options.notifyCopy(session), this.options.tag, () => {
        this.options.open(session.id)
      })
    }
  }

  /**
   * The archive set as a lookup, rebuilt only when the array it came from moves.
   *
   * `apply` runs on every status and list change, but the archive set rarely
   * changes: the controller hands the same array out until an archive mutation
   * replaces it, so an identity check turns a per-sync rebuild of a set that can
   * hold every archived Session in the account into a reference comparison.
   */
  private archivedSet(ids: readonly SessionId[]): ReadonlySet<SessionId> {
    if (this.archivedCache?.ids === ids) return this.archivedCache.set
    const set: ReadonlySet<SessionId> = new Set(ids)
    this.archivedCache = { ids, set }
    return set
  }

  /**
   * Build one notification, reporting whether the platform accepted the
   * request. The shell's desktop channel is preferred when present: its
   * activations reach the renderer from the Windows notification center, which
   * the HTML5 constructor cannot. Both refusal shapes are reported rather than
   * thrown: a construction that fails synchronously warns here, and a display
   * the platform rejects afterwards arrives on the notification's `error` event
   * (HTML5) or a false answer (desktop).
   */
  private notify(copy: NotificationCopy, tag: string, onClick?: () => void): boolean {
    if (this.desktop !== undefined) return this.notifyDesktop(copy, tag, onClick)
    // Read live: an ungranted or revoked permission makes construction throw,
    // and this is the only guard that stays correct after a grant.
    if (notificationPermission() !== 'granted') return false
    try {
      // `renotify` is what makes a replacement re-alert. Without it Chromium on
      // Windows *suppresses the banner* of every same-`tag` notification after the
      // first (`SuppressPopup`), so a run of completions would be written silently
      // into the notification center behind one stale entry and the user would
      // never be told the second Session finished.
      const options: RealertingNotificationOptions = { body: copy.detail, tag, renotify: true }
      const notification = new Notification(copy.title, options)
      // The failure that survives construction: an ungranted or revoked
      // permission, or a non-secure context. The platform reports it here, long
      // after `notify` returned, so this is the only place it can be recorded.
      notification.onerror = (event: Event) => {
        this.options.logger.warn('app-badge: the platform refused to display the notification', event)
      }
      if (onClick !== undefined) {
        notification.onclick = () => {
          // Chromium on Windows activates the notification, not the page: the
          // session would switch behind whichever app is in front. The Desktop
          // shell owns the only working answer, because a renderer cannot make a
          // hidden or minimized window visible — Electron implements no window
          // activation policy, so this page cannot raise itself. Where that
          // bridge is absent (a browser, or a shell that predates the channel)
          // `window.focus()` is what a browser honors, and is a no-op on Desktop.
          const reveal = desktopWindowReveal()
          if (reveal === undefined) window.focus()
          // A refused sender guard rejects the invoke; nothing here can act on it.
          else void reveal().catch(() => {})
          onClick()
          notification.close()
        }
      }
      return true
    } catch (error) {
      this.options.logger.warn('app-badge: the platform refused the notification', error)
      return false
    }
  }

  /**
   * Raise one notification through the shell's desktop channel. The tag stays
   * renderer-local (the shell owns replacement closing per id), so the id is
   * derived from it and a sequence; the click target is keyed by id and
   * dispatched from the activation subscription. A refused request resolves the
   * target away, keeping the pending-click map from ever growing.
   */
  private notifyDesktop(copy: NotificationCopy, tag: string, onClick?: () => void): boolean {
    const desktop = this.desktop
    const show = desktop?.show
    if (desktop === undefined || show === undefined) return false
    const id = `${tag}-${++this.desktopSequence}`
    const settle = (raised: boolean): void => {
      if (raised || onClick === undefined) return
      this.pendingClicks.delete(id)
    }
    const shown = show.call(desktop, { id, title: copy.title, body: copy.detail })
    if (shown instanceof Promise) {
      void shown.then(settle).catch((error: unknown) => {
        this.options.logger.warn('app-badge: the shell refused the notification', error)
        this.pendingClicks.delete(id)
      })
    } else {
      settle(shown)
    }
    if (onClick !== undefined) this.pendingClicks.set(id, onClick)
    return true
  }

  /** Release the activation subscription the constructor installed. */
  detach(): void {
    this.disposeActivation?.()
    this.pendingClicks.clear()
  }
}
