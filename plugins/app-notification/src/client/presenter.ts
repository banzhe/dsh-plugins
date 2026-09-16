/**
 * Browser presentation of the finished-unread Session count: the installed-PWA
 * icon badge (`navigator.setAppBadge`) and one system notification per Session
 * that finishes while the page is open.
 *
 * Both APIs are optional and platform-dependent — the badge is unsupported in
 * every non-Chromium browser and currently unreliable on the Windows taskbar,
 * and notifications need a permission the user grants through a gesture. The
 * presenter therefore never throws and never retries: it reads the capability
 * once per apply, reports a refusal through the Cordis logger, and leaves the
 * in-app surfaces (the sidebar's green dot) as the authority.
 *
 * Pure browser-API writes with no React involvement, so disposal is the single
 * `unsubscribe` the caller owns.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { SessionListState, SessionSummary } from '@deepseek-ai/dsh-api-session-controller/client'
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
 * is what keeps them optional for the capability guards below; the intersection
 * with `Navigator` would erase that and make every guard look unnecessary.
 * @returns the possibly-absent badging methods.
 */
function appBadgeNavigator(): AppBadgeNavigator {
  return navigator
}

/**
 * `NotificationOptions` as Chromium implements it. The lib.dom type this package
 * compiles against stops at `tag`, but the Windows bridge reads one option past
 * it: `renotify`, the only switch that lets a same-`tag` replacement re-alert
 * instead of being suppressed into the notification center.
 */
interface RealertingNotificationOptions extends NotificationOptions {
  renotify?: boolean
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
  /** Open the Session a notification was clicked for. */
  readonly open: (id: SessionId) => void
  /** Notification tag; one tag replaces the previous notification, and each replacement re-alerts. */
  readonly tag: string
  /** Test-notification tag; distinct from {@link tag} so a probe never displaces a real announcement. */
  readonly testTag: string
}

/**
 * Permission as the settings row needs to display it: the platform's own
 * answer, plus the one state the platform has no word for (no constructor).
 */
export type NotificationPermissionState = NotificationPermission | 'unsupported'

/**
 * How the browser answered the capability probes. Support and permission stay
 * separate members on purpose: the permission is granted and revoked at
 * runtime, so it can never be folded into a one-shot capability.
 */
export interface CompletionCapabilities {
  /** Both `navigator.setAppBadge` and `navigator.clearAppBadge` exist. */
  readonly badge: boolean
  /** The `Notification` constructor exists, whatever the current permission is. */
  readonly notificationSupported: boolean
  /** Supported AND currently granted — the only state a notification may be built in. */
  readonly notificationGranted: boolean
}

/**
 * Read the capability probes.
 * @returns which surfaces this page can use; all false outside a capable browser.
 */
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
 * @returns the live permission, or `unsupported` without a constructor.
 */
export function notificationPermission(): NotificationPermissionState {
  return typeof Notification === 'function' ? Notification.permission : 'unsupported'
}

/**
 * Ask the browser for notification permission. Must run inside a user gesture:
 * every browser discards the request otherwise, which is exactly why the
 * settings row's button — and never plugin activation — is the only caller.
 * @returns the permission the user granted or left unset; `unsupported` without a constructor.
 */
export async function requestNotificationPermission(): Promise<NotificationPermissionState> {
  if (typeof Notification !== 'function') return 'unsupported'
  return await Notification.requestPermission()
}

/** Project the finished-unread count onto the installed-PWA icon badge. */
export class AppBadgePresenter {
  /** Count written by the last successful projection; undefined before the first. */
  private applied: number | undefined
  /** Bound platform writer, resolved once so the capability probe stays the only guard. */
  private readonly write: ((contents?: number) => Promise<void>) | undefined
  /** Bound platform retractor, resolved once alongside {@link write}. */
  private readonly retract: (() => Promise<void>) | undefined

  /**
   * @param logger - Cordis logger for a refused badge write.
   */
  constructor(private readonly logger: Context['logger']) {
    const badge = appBadgeNavigator()
    this.write = badge.setAppBadge?.bind(badge)
    this.retract = badge.clearAppBadge?.bind(badge)
  }

  /**
   * Set or clear the badge to match `count`. A repeated count is a no-op, so
   * unrelated list updates do not re-issue the same platform call.
   * @param count - finished-unread Sessions; 0 clears the badge.
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

  /**
   * @param options - logger, per-Session copy, test copy, click target, and tag.
   */
  constructor(private readonly options: CompletionPresenterOptions) {
    // Only badging is probed once: the API's presence cannot change during a
    // page's life. Notification permission CAN, so it is read per use.
    this.badge = this.capabilities.badge ? new AppBadgePresenter(options.logger) : undefined
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

  /** Whether this page supports the installed-PWA icon badge at all. */
  get badgeSupported(): boolean {
    return this.badge !== undefined
  }

  /**
   * Read the live notification permission (never a cached probe result).
   * @returns the platform's current answer, or `unsupported` without a constructor.
   */
  permission(): NotificationPermissionState {
    return notificationPermission()
  }

  /**
   * Ask for notification permission. Must be called from a user gesture (the
   * settings row's button), never from activation.
   * @returns the resulting permission.
   */
  async request(): Promise<NotificationPermissionState> {
    return await requestNotificationPermission()
  }

  /**
   * Install the list subscription and publish the current state once. Call
   * exactly once per presenter — the caller owns the lifetime decision (this
   * plugin subscribes once, at activation, whenever the page is `viable`).
   * @param list - the sessions list snapshot source (`ctx.sessions.list`).
   * @returns the disposer that unsubscribes and retracts the badge.
   */
  attach(list: ObservableSnapshot<SessionListState>): () => void {
    const sync = (): void => { this.apply(list.getSnapshot()) }
    const unsubscribe = list.subscribe(sync)
    sync()
    return () => {
      unsubscribe()
      this.badge?.clear()
    }
  }

  /**
   * Show the settings row's test notification. A distinct tag keeps the probe
   * from replacing (or being replaced by) a real completion announcement.
   * @returns whether the platform accepted the notification.
   */
  showTest(): boolean {
    return this.notify(this.options.testCopy(), this.options.testTag)
  }

  /** Fold one observation onto the badge and the notification stream. */
  private apply(list: SessionListState): void {
    const observation = this.observer.observe(list)
    this.badge?.project(observation.completed.length)
    for (const session of observation.newlyCompleted) {
      this.notify(this.options.notifyCopy(session), this.options.tag, () => {
        this.options.open(session.id)
      })
    }
  }

  /**
   * Build one notification. Both refusal shapes are reported rather than thrown:
   * a construction that fails synchronously is a warning here, and a display the
   * platform rejects afterwards arrives on the notification's `error` event.
   * @param copy - resolved title and body.
   * @param tag - aggregation tag (same tag replaces the previous notification).
   * @param onClick - optional click behavior; omitted for the test probe.
   * @returns whether the platform accepted the construction.
   */
  private notify(copy: NotificationCopy, tag: string, onClick?: () => void): boolean {
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
}
