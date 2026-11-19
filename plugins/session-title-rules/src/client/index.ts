/**
 * Browser half: the Session title settings section.
 *
 * The registration is gated on `whileServed`: while the Host serves the
 * `session-title-rules` settings namespace the section exists, and when the row
 * is switched off it disappears with it. That gate is also how the section
 * learns a Host Config schema exists to edit at all.
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
// Type-only: the ctx.remote merge and the forwarded-event key face.
import type {} from '@deepseek-ai/dsh-api-remotes/client'
// Type-only: the ctx.configForms merge, the ConfigForm type, and the
// `settings.section` / `settings.section.icon` SlotMap entries.
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import { TitleModelSection, TitleModelSectionIcon } from './TitleModelSection.tsx'
import { TitleModelSectionController, TITLE_MODEL_NS, type TitleModelSettings } from './controller.ts'
import { en, zh } from './locales.ts'
// Text, not a stylesheet link: the ModuleLoader fetches one artifact, so the
// sheet is inlined at build time. See `tsdown.config.ts` and `title-model.css`.
import titleModelCss from './title-model.css?inline'

export type { TitleModelSectionProps } from './TitleModelSection.tsx'
export type {
  TitleModelCandidate, TitleModelEffort, TitleModelRoute, TitleModelSectionFace, TitleModelSectionState,
  TitleModelSettings,
} from './controller.ts'
export type { TitleModelLocaleKey } from './locales.ts'

const NS = TITLE_MODEL_NS

/** Plugin id, stamped onto the injected stylesheet for teardown bookkeeping. */
const PLUGIN_ID = '@banzhe/dsh-session-title-rules'

export const inject = ['configForms', 'locale', 'slots', 'remote', 'remote.session']

export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'session-title-rules: dictionaries')
  // The section's stylesheet rides the plugin's own fiber: unload removes it. It
  // carries the shell's `--dsw-*` token values, which only resolve inside a
  // themed document, so it is a `<style>` tag installed here — not inline
  // declarations on the elements, which beat every stylesheet in the cascade.
  ctx.effect(() => {
    /* v8 ignore next -- needs a documentless run, not constructible under jsdom */
    if (typeof document === 'undefined') return () => {}
    const tag = document.createElement('style')
    tag.dataset.plugin = PLUGIN_ID
    tag.dataset.pluginCss = `${PLUGIN_ID}/title-model.css`
    tag.textContent = titleModelCss
    document.head.appendChild(tag)
    return () => { tag.remove() }
  }, 'session-title-rules: title model stylesheet')

  ctx.effect(() => ctx.configForms.whileServed([NS], () => {
    // The shared form is owned by configForms: repeated `get` returns the same
    // controller, so the section and any other editor of this entry share one
    // write queue and one revision fence.
    const form = ctx.configForms.get<TitleModelSettings>(NS)
    return ctx.slots.inject('settings.section', () => {
      const controller = new TitleModelSectionController(form, ctx)
      const offSection = ctx.slots.register({
        name: 'settings.section',
        id: NS,
        // After Agent presets (20), and before this repo's preset-visibility (30)
        // and Dev Container variants (31) pages: this is a model preference, not a
        // page deciding which presets exist.
        order: 21,
        // A thunk, not a string: the shell re-reads it on every projection, so a
        // language switch relabels the nav row without re-registering it.
        label: () => ctx.locale.bind(NS)('nav'),
        locale: NS,
        inject: () => controller.inject(),
      }, TitleModelSection)
      // The nav row draws its icon from a contribution addressed by section id,
      // so this id has to be the section's: an unmatched one never renders.
      const offIcon = ctx.slots.inject('settings.section.icon', () => ctx.slots.register({
        name: 'settings.section.icon',
        id: NS,
      }, TitleModelSectionIcon))
      // Reverse order: drop the contributions before releasing what renders them.
      return [offSection, offIcon, () => { controller.dispose() }]
    })
  }), 'session-title-rules: title model section')
}
