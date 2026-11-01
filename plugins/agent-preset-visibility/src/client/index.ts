/**
 * Browser half: keep hidden presets out of the roster, and edit the hidden list.
 *
 * The filter is installed on the Remote namespace rather than on the Host
 * service on purpose: three surfaces read one listing, and replacing that
 * listing is the only edit that reaches all three without touching any of them.
 * The Host keeps serving the full roster, so `agentPresets.select`/`resolve`/`mount`
 * and subagent delegation are unaffected — see `./remote.ts`.
 *
 * The page is a `settings.section` of its own rather than a `plugins.row.config`
 * card: this preference is about the preset picker, not about this Loader row,
 * and it has to stay reachable while the row is what is being configured.
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
// Type-only: the ctx.remote merge and the agentPresets namespace it carries.
import type {} from '@deepseek-ai/dsh-api-remotes/client'
// Type-only: the ctx.configForms merge, the ConfigForm type, and the
// `settings.section` SlotMap entry.
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import { PresetVisibilityController, PRESET_VISIBILITY_NS, type PresetVisibilitySettings } from './controller.ts'
import { PresetVisibilitySection } from './PresetVisibilitySection.tsx'
import { en, zh } from './locales.ts'
import { presetRosterFilter } from './remote.ts'
import { hiddenIds } from './visibility.ts'
// Text, not a stylesheet link: the ModuleLoader fetches one artifact, so the
// sheet is inlined at build time. See `tsdown.config.ts` and `visibility.css`.
import visibilityCss from './visibility.css?inline'

export type {
  PresetVisibilityFace, PresetVisibilityFailure, PresetVisibilityRow, PresetVisibilitySettings, PresetVisibilityState,
} from './controller.ts'
export type { PresetVisibilityKey } from './locales.ts'
export type { PresetListing, PresetRosterFilter } from './remote.ts'

/** Plugin id, stamped onto the injected stylesheet for teardown bookkeeping. */
const PLUGIN_ID = '@banzhe/dsh-agent-preset-visibility'

const NS = PRESET_VISIBILITY_NS

export const inject = ['configForms', 'locale', 'remote', 'remote.agentPresets', 'slots']

export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'agent-preset-visibility: dictionaries')
  // The page's stylesheet rides the plugin's own fiber: unload removes it. It
  // carries the shell's `--dsw-*` token values, which only resolve inside a themed
  // document, so it is a `<style>` tag installed here — not inline declarations on
  // the elements, which beat every stylesheet in the cascade.
  ctx.effect(() => {
    if (typeof document === 'undefined') return () => {}
    const tag = document.createElement('style')
    tag.dataset.plugin = PLUGIN_ID
    tag.dataset.pluginCss = `${PLUGIN_ID}/visibility.css`
    tag.textContent = visibilityCss
    document.head.appendChild(tag)
    return () => { tag.remove() }
  }, 'agent-preset-visibility: stylesheet')

  const form = ctx.configForms.get<PresetVisibilitySettings>(NS)
  const roster = presetRosterFilter(ctx)
  if (roster === undefined) {
    ctx.logger.warn(`${PLUGIN_ID}: the agentPresets listing is not replaceable in this build; every preset stays visible`)
    return
  }

  // One install for the whole page lifetime: the hidden set is read per call, so
  // an edit reaches the next roster read without reinstalling anything.
  ctx.effect(() => roster.install(() => hiddenIds(form.getSnapshot().value)),
    'agent-preset-visibility: roster filter')

  ctx.effect(() => ctx.configForms.whileServed([NS], () => ctx.slots.inject('settings.section', () => {
    // The shared form is owned by configForms: repeated `get` returns the same
    // controller, so this page and any other editor of the entry share one write
    // queue and one revision fence.
    const controller = new PresetVisibilityController(form, roster)
    const offSlot = ctx.slots.register({
      name: 'settings.section',
      id: NS,
      // After the Agent presets section (order 20): this page adjusts the roster
      // that section shows.
      order: 30,
      label: () => ctx.locale.bind(NS)('nav'),
      locale: NS,
      inject: () => controller.inject(),
    }, PresetVisibilitySection)
    // Reverse order: drop the registration before releasing what renders it.
    return [offSlot, () => { controller.dispose() }]
  })), 'agent-preset-visibility: preset visibility page')
}
