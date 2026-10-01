/**
 * Browser half: one `shell.overlay` entry that lists the Sessions needing
 * attention (running, and finished-unread) behind a toggle, plus the store that
 * keeps that list in step with the Session list and status sources.
 *
 * The entry is registered unconditionally: the toggle is the only way in, so it
 * must exist even when the list is empty. Navigation goes through the Workspace
 * owner — `openSession` takes the `mainView` reference and hands it over, which
 * is what promotes the Session and clears its unread reminder.
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import { useSyncExternalStore } from 'react'
// Type-only: the ctx.locale service merge (register/bind).
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: the ctx.slots SlotRegistry service merge.
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
// Type-only: Context.sessions (ISessions) — the list source and its row type.
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
// Type-only: the ctx.uiSession status source merge the store subscribes to.
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
// Type-only: the ctx.uiWorkspace service a row jumps through.
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import { AttentionOverlay, type AttentionInjected } from './AttentionOverlay.tsx'
import { createAttentionStore } from './attention.ts'
import { en, NS, zh } from './locales.ts'
// Text, not a stylesheet link: the ModuleLoader fetches one artifact, so the
// sheet is inlined at build time. See `tsdown.config.ts` and `overlay.css`.
import overlayCss from './overlay.css?inline'

/** Required services: Session list, Session status, Workspace navigation, dictionaries, slot registry. */
export const inject = ['sessions', 'uiSession', 'uiWorkspace', 'locale', 'slots']

/** Plugin id, stamped onto the injected stylesheet for HMR bookkeeping. */
const PLUGIN_ID = '@banzhe/dsh-session-attention'

/** Client plugin body: dictionaries, stylesheet, attention store, overlay entry. */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'session-attention: dictionaries')
  // The panel's stylesheet rides the plugin's own fiber: unload removes it.
  ctx.effect(() => {
    /* v8 ignore next -- needs a documentless run, not constructible under jsdom */
    if (typeof document === 'undefined') return () => {}
    const tag = document.createElement('style')
    tag.dataset.plugin = PLUGIN_ID
    tag.dataset.pluginCss = `${PLUGIN_ID}/overlay.css`
    tag.textContent = overlayCss
    document.head.appendChild(tag)
    return () => { tag.remove() }
  }, 'session-attention: overlay stylesheet')

  const store = createAttentionStore(ctx.sessions.list, ctx.uiSession.sessionStatus)
  ctx.effect(() => () => { store.dispose() }, 'session-attention: attention store lifetime')

  const injected = (): AttentionInjected => ({
    // Bound to the plugin's store during render; the plugin owns the lifetime.
    useAttention: () => useSyncExternalStore(store.subscribe, store.getSnapshot),
    open: (id) => { ctx.uiWorkspace.openSession(id) },
  })

  // Slot registration waits for ui-layout's declaration; the entry leaves with it.
  ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay',
    id: 'session-attention.panel',
    order: 100,
    locale: NS,
    inject: injected,
  }, AttentionOverlay))
}
