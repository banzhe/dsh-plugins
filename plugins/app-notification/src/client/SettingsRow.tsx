/**
 * The Completion-attention settings row, registered into the General section's
 * item slot. It owns three things and nothing else:
 *
 * - a readout of the two live capabilities (notification permission, icon-badge
 *   support), because a silent plugin is indistinguishable from a broken one;
 * - **Request permission** — the user gesture `Notification.requestPermission()`
 *   requires, which is the whole reason this row exists: without a settings
 *   surface the plugin could never legitimately ask;
 * - **Send test notification** — proves the notification path end to end
 *   without waiting for a real Session to finish.
 *
 * The readout follows the platform, never a cached startup probe: the injected
 * `permission()` is the live read, taken once at mount and again after every
 * action. Permission is granted and revoked behind the page's back, and a stale
 * grant is exactly the bug that makes "why is nothing popping up?" unexplainable.
 */
import { useCallback, useState, type ReactNode } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsRuntime, PropsLocale, InjectFace } from '@deepseek-ai/dsh-client-ui-slots'
import type { NotificationPermissionState } from './presenter.ts'
import type { AppBadgeKey } from './locales.ts'

/** Business face the plugin injects into the row (framework binds it to props). */
export interface CompletionSettingsInjected {
  /** Read the live notification permission. */
  permission: () => NotificationPermissionState
  /** Whether this page can drive the icon badge at all. */
  badgeSupported: () => boolean
  /** Ask for notification permission; must be called from a user gesture. */
  request: () => Promise<NotificationPermissionState>
  /** Raise the test notification. @returns whether the platform accepted it. */
  test: () => boolean
}

/** Full component props: runtime share + locale seat + injected business face. */
export type CompletionSettingsRowProps =
  PropsRuntime<'settings.general.item'>
  & PropsLocale<'app-badge'>
  & InjectFace<CompletionSettingsInjected>

/** Locale key naming each permission state (exhaustive over the union). */
const PERMISSION_KEYS = {
  granted: 'settings.permission.granted',
  denied: 'settings.permission.denied',
  default: 'settings.permission.default',
  unsupported: 'settings.permission.unsupported',
} as const satisfies Record<NotificationPermissionState, AppBadgeKey>

/** Locale key naming each badge-support state. */
const BADGE_KEYS = {
  true: 'settings.badge.supported',
  false: 'settings.badge.unsupported',
} as const

/** One labeled readout line. */
function Fact({ label, value }: { readonly label: string; readonly value: string }): ReactNode {
  return (
    <div className="ab-fact">
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  )
}

/**
 * Render the Completion-attention preference row.
 * @param props - composed slot props (contract in ui-settings/client).
 * @returns the row element tree.
 */
export function CompletionSettingsRow({
  t, permission, badgeSupported, request, test,
}: CompletionSettingsRowProps): ReactNode {
  // Seeded from the live platform read, then refreshed after every action:
  // React state here is an action echo, never the source of truth.
  const [state, setState] = useState<NotificationPermissionState>(() => permission())
  const [pending, setPending] = useState(false)
  const [note, setNote] = useState<{ key: AppBadgeKey; ok: boolean } | undefined>(undefined)

  const onRequest = useCallback((): void => {
    setPending(true)
    setNote(undefined)
    void request().then((result) => {
      setState(result)
      setPending(false)
    }, () => {
      // A rejected request (an insecure context, a browser-level refusal) must
      // leave the readout truthful rather than stuck on "Requesting…".
      setState(permission())
      setPending(false)
    })
  }, [request, permission])

  const onTest = useCallback((): void => {
    const accepted = test()
    setNote({
      key: accepted ? 'settings.test.sent' : 'settings.test.failed',
      ok: accepted,
    })
    setState(permission())
  }, [test, permission])

  const badge = badgeSupported()
  const canTest = state === 'granted'
  return (
    <div className="ab-row">
      <div className="ab-head">
        <div className="ab-title">{t('settings.title')}</div>
        <div className="ab-desc">{t('settings.description')}</div>
      </div>
      <dl className="ab-facts">
        <Fact label={t('settings.permissionLabel')} value={t(PERMISSION_KEYS[state])} />
        <Fact label={t('settings.badgeLabel')} value={t(BADGE_KEYS[badge ? 'true' : 'false'])} />
      </dl>
      <div className="ab-actions">
        <Button
          variant="primary"
          // A browser only honors the request from a user gesture, and asking
          // again after a grant or a denial is a no-op — so the button retires
          // exactly when there is nothing left for it to ask.
          disabled={pending || state === 'granted' || state === 'unsupported'}
          onClick={onRequest}
        >
          {t(pending ? 'settings.requesting' : 'settings.request')}
        </Button>
        <Button variant="outline" disabled={!canTest} onClick={onTest}>
          {t('settings.test')}
        </Button>
        {note === undefined
          ? null
          : (
            <span
              className="ab-status"
              role="status"
              data-success={note.ok ? 'true' : undefined}
              data-failed={note.ok ? undefined : 'true'}
            >
              {t(note.key)}
            </span>
          )}
      </div>
    </div>
  )
}
