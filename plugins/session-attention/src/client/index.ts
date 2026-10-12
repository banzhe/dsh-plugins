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
import type { SessionId } from '@deepseek-ai/dsh-session/types'
// Type-only: the ctx.uiSession status source merge the store subscribes to.
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
// Type-only: the ctx.uiWorkspace service a row jumps through.
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import { AttentionOverlay, type AttentionInjected } from './AttentionOverlay.tsx'
import { createAttentionStore, type AttentionModel } from './attention.ts'
import { en, NS, zh } from './locales.ts'
// Text, not a stylesheet link: the ModuleLoader fetches one artifact, so the
// sheet is inlined at build time. See `tsdown.config.ts` and `overlay.css`.
import overlayCss from './overlay.css?inline'

export const inject = ['sessions', 'uiSession', 'uiWorkspace', 'locale', 'slots']

/** Plugin id, stamped onto the injected stylesheet for HMR bookkeeping. */
const PLUGIN_ID = '@banzhe/dsh-session-attention'

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

  // The run-duration column counts from `lastPromptAt`, which the list
  // carries only after a projection read. One read per listed Session version
  // (`updatedAt`, which advances when the user prompts again). The read itself
  // republishes this list before the metadata key exists — `refreshProjections`
  // marks the list dirty on the way out — so "key absent" cannot mean "not yet
  // read", or the effect would refresh every publication forever.
  ctx.effect(() => {
    // `updatedAt` already read, or claimed by a call still in flight. A failed
    // read leaves no entry, so the one retry below is not mistaken for a duplicate.
    const readAt = new Map<SessionId, number>()
    let disposed = false
    const read = (id: SessionId, updatedAt: number, retry: boolean): void => {
      if ((readAt.get(id) ?? -1) >= updatedAt) return
      readAt.set(id, updatedAt)
      void ctx.sessions.refreshProjections(id).then(() => {
        if (disposed) return
        const current = ctx.sessions.list.getSnapshot().byId[id]
        // A prompt that landed while this read was in flight is a newer
        // version than the value just fetched. The claim above keeps a
        // duplicate publication from stacking calls.
        if (current !== undefined && current.updatedAt > updatedAt) read(id, current.updatedAt, true)
      }, () => {
        if (disposed) return
        if (readAt.get(id) !== updatedAt) return
        const current = ctx.sessions.list.getSnapshot().byId[id]
        const same = current !== undefined && current.updatedAt === updatedAt
        // One retry for this version. The failed read already republished
        // the list, so waiting for a later publication would never run; a
        // second failure keeps the claim, or a dead host would refresh on
        // every later publication of the same version. A newer `updatedAt`
        // still reads, because the claim compares by version.
        if (!retry || !same) return
        readAt.delete(id)
        read(id, updatedAt, false)
      })
    }
    const pull = (): void => {
      const { ids, byId } = ctx.sessions.list.getSnapshot()
      ids.forEach((id) => {
        const row = byId[id]
        if (row === undefined || row.origin === 'subagent' || row.blank) return
        read(id, row.updatedAt, true)
      })
    }
    pull()
    const unsubscribe = ctx.sessions.list.subscribe(pull)
    return () => {
      disposed = true
      unsubscribe()
    }
  }, 'session-attention: lastPromptAt projection reads')

  /**
   * The store's members read as unbound methods to the linter, so the pair is
   * wrapped once here instead of inline at the call site. It must keep this
   * identity across renders: `useSyncExternalStore` resubscribes whenever
   * `subscribe` changes.
   */
  const subscribeAttention = (listener: () => void): (() => void) => store.subscribe(listener)
  const snapshotAttention = (): AttentionModel => store.getSnapshot()

  const injected = (): AttentionInjected => ({
    // Bound to the plugin's store during render; the plugin owns the lifetime.
    useAttention: () => useSyncExternalStore(subscribeAttention, snapshotAttention),
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
