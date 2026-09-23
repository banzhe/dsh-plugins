/**
 * Browser half: project the finished-unread Session count onto the installed
 * PWA's icon badge and announce each Session that finishes while the page is
 * open through one system notification. It also owns this feature's settings
 * row, which is where the notification permission is legitimately requested:
 * the browser only honors `Notification.requestPermission()` inside a user
 * gesture, and the row's button is that gesture.
 *
 * Inert where it can do nothing: a page whose browser offers neither badging
 * nor a notification constructor still registers its dictionaries and its
 * settings row — so the readout can say *why* nothing happens — and never
 * subscribes to the Session list. The in-app surfaces (the sidebar's green
 * completion dot) remain the authoritative reminder.
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type { SessionSummary } from '@deepseek-ai/dsh-api-session-controller/client'
// Type-only: the `ctx.uiSession` status source merge the presenter subscribes to.
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
// Type-only: the `ctx.uiWorkspace` service a notification click navigates through.
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
// Type-only: pulls the SlotRegistry service merge (ctx.slots).
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
// Type-only: the `settings.general.item` slot declaration this plugin registers into.
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import { CompletionPresenter } from './presenter.ts'
import { SETTINGS_ROW_CSS } from './styles.ts'
import { CompletionSettingsRow, type CompletionSettingsInjected } from './SettingsRow.tsx'
import { en, NS, zh, type AppBadgeKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Completion notification and settings-row copy. */
    'app-badge': AppBadgeKey
  }
}

/** Required services: Session list, completion status, workspace navigation, dictionaries, and the settings slot registry. */
export const inject = ['sessions', 'uiSession', 'uiWorkspace', 'locale', 'slots']

/** Plugin id, stamped onto the injected stylesheet for HMR bookkeeping. */
const PLUGIN_ID = '@banzhe/dsh-app-notification'

/**
 * Notification tag making a run of completions replace one another instead of
 * stacking. The presenter pairs this with `renotify`, so every replacement
 * re-alerts instead of being suppressed into the notification center.
 */
const TAG = 'dsh-session-completed'

/** Test-notification tag; distinct from {@link TAG} so a probe never displaces a real announcement. */
const TEST_TAG = 'dsh-session-completed-test'

/**
 * Client plugin body: register the dictionaries and the settings row, then
 * drive the two surfaces from the Session list.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'app-badge: dictionaries')
  // The row's stylesheet rides the plugin's own fiber: unload removes it.
  ctx.effect(() => {
    /* v8 ignore next -- needs a documentless run, not constructible under jsdom */
    if (typeof document === 'undefined') return () => {}
    const tag = document.createElement('style')
    tag.dataset.plugin = PLUGIN_ID
    tag.dataset.pluginCss = `${PLUGIN_ID}/settings-row.css`
    tag.textContent = SETTINGS_ROW_CSS
    document.head.appendChild(tag)
    return () => { tag.remove() }
  }, 'app-badge: settings row stylesheet')

  const t = ctx.locale.bind(NS)
  const notifyCopy = (session: SessionSummary) => ({
    title: t('notify.title'),
    // The label is user-facing Session data, not copy: it passes through the
    // template's {title} placeholder verbatim.
    detail: t('notify.body', { title: session.displayTitle }),
  })
  // A click navigates through the workspace owner: `retain` alone only counts a
  // reference, and ui-session promotes a Session to the main view only while a
  // `mainView` reference is held — which `openSession` takes and hands over.
  const presenter = new CompletionPresenter({
    logger: ctx.logger,
    notifyCopy,
    testCopy: () => ({ title: t('test.title'), detail: t('test.body') }),
    open: (id) => { ctx.uiWorkspace.openSession(id) },
    tag: TAG,
    testTag: TEST_TAG,
  })

  // One subscription for the plugin's lifetime; installed lazily and only for a
  // page that could ever show a surface. A browser with neither costs one probe.
  let subscribed = false
  const subscribe = (): void => {
    if (subscribed || !presenter.viable) return
    subscribed = true
    ctx.effect(
      () => presenter.attach(ctx.uiSession.sessionStatus, ctx.sessions.list),
      'app-badge: finished-unread projection',
    )
  }

  // The row is registered whatever the capabilities: on an incapable page it is
  // the only place that can explain the silence, and on a capable one it hosts
  // the gesture that grants the permission.
  const injected = (): CompletionSettingsInjected => ({
    permission: () => presenter.permission(),
    badgeSupported: () => presenter.badgeSupported,
    request: async () => {
      const result = await presenter.request()
      // A grant must take effect without a reload: a page that was inert at
      // load had subscribed to nothing, so activation is re-asserted here.
      subscribe()
      return result
    },
    test: () => presenter.showTest(),
  })
  ctx.slots.inject('settings.general.item', () => ctx.slots.register({
    name: 'settings.general.item',
    id: 'app-badge',
    order: 20,
    locale: NS,
    inject: injected,
  }, CompletionSettingsRow))

  subscribe()
}
