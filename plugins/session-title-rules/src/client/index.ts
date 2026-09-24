/**
 * Browser half: the title-model row-configuration page.
 *
 * The page lives on the Plugins page, not in Settings, because that is where a
 * Loader row's own configuration belongs: the plugin manager declares
 * `plugins.row.config` keyed by `<bundle package name>#<row id>`, and this
 * Bundle's row is `@banzhe/dsh-session-title-rules#session-title-rules`.
 * Registering under that key gives the row a **Configure** control and mounts
 * this card on the page it opens.
 *
 * The registration is gated on `whileServed`: while the Host serves the
 * `session-title-rules` settings namespace the row is configurable, and when
 * the row is switched off the control disappears with it. That gate is also how
 * the page learns a Host Config schema exists to edit at all — a namespace the
 * describe mirror does not carry has no form.
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
// Type-only: the ctx.remote merge and the forwarded-event key face.
import type {} from '@deepseek-ai/dsh-api-remotes/client'
// Type-only: the ctx.configForms merge, the ConfigForm type, and the
// `plugins.row.config` SlotMap entry.
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import { TitleModelCard } from './TitleModelCard.tsx'
import { TitleModelCardController, TITLE_MODEL_NS, type TitleModelSettings } from './controller.ts'
import { en, zh } from './locales.ts'
import { TITLE_MODEL_CSS } from './styles.ts'

export type { TitleModelCardProps } from './TitleModelCard.tsx'
export type {
  TitleModelCandidate, TitleModelCardFace, TitleModelCardState, TitleModelEffort, TitleModelRoute,
  TitleModelSettings,
} from './controller.ts'
export type { TitleModelLocaleKey } from './locales.ts'

/** Dictionary namespace: the settings namespace, which is also the row id. */
const NS = TITLE_MODEL_NS

/** Plugin id, stamped onto the injected stylesheet for teardown bookkeeping. */
const PLUGIN_ID = '@banzhe/dsh-session-title-rules'

/** Required services: settings forms, dictionaries, slots, and the model directory. */
export const inject = ['configForms', 'locale', 'slots', 'remote', 'remote.session']

/**
 * Register this row's configuration page while the Host serves its namespace.
 * @param ctx - the browser plugin context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'session-title-rules: dictionaries')
  // The card's stylesheet rides the plugin's own fiber: unload removes it. It
  // carries the shell's `--dsw-*` token values, which only resolve inside a
  // themed document, so it is installed here rather than baked into the bundle.
  ctx.effect(() => {
    /* v8 ignore next -- needs a documentless run, not constructible under jsdom */
    if (typeof document === 'undefined') return () => {}
    const tag = document.createElement('style')
    tag.dataset.plugin = PLUGIN_ID
    tag.dataset.pluginCss = `${PLUGIN_ID}/title-model.css`
    tag.textContent = TITLE_MODEL_CSS
    document.head.appendChild(tag)
    return () => { tag.remove() }
  }, 'session-title-rules: title model stylesheet')
  // The card's `t` arrives from the renderer through the registration's
  // `locale: NS`, so this plugin binds no translator of its own.

  ctx.effect(() => ctx.configForms.whileServed([NS], () => {
    // The shared form is owned by configForms: repeated `get` returns the same
    // controller, so the card and any other editor of this entry share one
    // write queue and one revision fence.
    const form = ctx.configForms.get<TitleModelSettings>(NS)
    return ctx.slots.inject('plugins.row.config', () => {
      const controller = new TitleModelCardController(form, ctx)
      const offSlot = ctx.slots.register({
        name: 'plugins.row.config',
        key: `@banzhe/dsh-session-title-rules#${NS}`,
        locale: NS,
        inject: () => controller.inject(),
      }, TitleModelCard)
      // Reverse order: drop the registration before releasing what renders it.
      return [offSlot, () => { controller.dispose() }]
    })
  }), 'session-title-rules: title model page')
}
