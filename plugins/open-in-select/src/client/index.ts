/**
 * Open-in-select browser half: the Session header's "open in…" control, plus the
 * notice surface its failures land on.
 *
 * The control is a compact split button in
 * `conversation.session.header.utilities` (session scope, `order: -10`, so it
 * leads the right-aligned utilities). Its left half opens the Session's
 * directory in the application it names; its chevron opens the applications the
 * Host resolved, where a pick both launches and is remembered.
 *
 * The control composes shipped primitives — buttons, tooltip, menu, glyphs, the
 * failure banner — inside one inline shell (`control.module.css`) that draws the
 * shared stroke and keeps both halves reading as one control; the dictionaries
 * are this Bundle's own namespace.
 */
import { createElement } from 'react'
import type { ReactNode } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: pulls the SlotRegistry service merge (ctx.slots).
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
// Type-only: the session-scope standard seat (sessionId, useSessions).
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
// Type-only: the `conversation.session.header.utilities` SlotMap declaration.
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { loadApps, launchApp } from './api.ts'
import { en, NS, zh, type OpenInSelectKey } from './locales.ts'
import { createNoticeStore } from './noticeStore.ts'
import { NoticeToast, type NoticeToastInjected } from './NoticeToast.tsx'
import { OpenInSelect, type OpenInSelectInjected, type OpenInSelectProps } from './OpenInSelect.tsx'
import { ICON_ROUTE_PREFIX } from './routes.ts'
import { createOpenInSelectState } from './state.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    'open-in-select': OpenInSelectKey
  }
}

export const inject = ['locale', 'slots']

/**
 * The slot hands the entry the Session's identity but not its directory, so the
 * entry resolves the directory and the control stays a pure props component.
 */
type SessionOpenInSelectProps = Omit<OpenInSelectProps, 'absolutePath'>

/**
 * The Session header entry: render the control for the Session's directory, or
 * nothing while the Session has none.
 * @param props - the entry's composed props.
 * @returns the control, or null while the Session has no directory.
 */
function SessionOpenInSelect(props: SessionOpenInSelectProps): ReactNode {
  const { sessionId, useSessions } = props
  const cwd = useSessions(state => state.byId[sessionId]?.cwd)
  if (cwd === undefined || cwd === '') return null
  return createElement(OpenInSelect, { ...props, absolutePath: cwd })
}

/**
 * Client plugin body: read the Host's application list once, register the
 * dictionaries and the notice overlay, then contribute the header control.
 * @param ctx - client root context.
 */
export function apply(ctx: Context): void {
  const state = createOpenInSelectState()
  // One availability read per page.
  void loadApps().then((apps) => { state.apps.set(apps) })
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'open-in-select: dictionaries')
  const notices = createNoticeStore()
  const noticeSource = {
    getSnapshot: () => notices.snapshot(),
    subscribe: (listener: () => void) => notices.subscribe(listener),
  }

  // The notice surface is the shell's overlay seat, registered unconditionally:
  // with no notice pending the entry renders nothing at all.
  ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay',
    id: 'open-in-select.notice',
    locale: NS,
    inject: (): NoticeToastInjected => ({
      hooks: { notice: noticeSource },
      dismiss: (seq: number) => { notices.dismiss(seq) },
    }),
  }, NoticeToast))

  const injected = (): OpenInSelectInjected => ({
    hooks: {
      openInSelectApps: state.apps,
      openInSelectChoice: state.choice,
    },
    launch: (appId, path) => launchApp(appId, path),
    choose: (appId) => { state.choice.set(appId) },
    report: (text) => { notices.show(text) },
    iconUrl: appId => `${ICON_ROUTE_PREFIX}/${encodeURIComponent(appId)}`,
  })

  ctx.slots.inject('conversation.session.header.utilities', () => ctx.slots.register({
    name: 'conversation.session.header.utilities',
    id: 'open-in-select',
    order: -10,
    locale: NS,
    inject: injected,
  }, SessionOpenInSelect))
}
