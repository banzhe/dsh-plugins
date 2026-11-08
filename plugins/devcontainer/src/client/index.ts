/**
 * Browser half: the Dev Container variants page.
 *
 * The page is a `settings.section` of its own rather than a `plugins.row.config`
 * card: this preference decides which `(devContainer)` presets exist, not how
 * this Loader row is configured, and it has to stay reachable while the row is
 * what is being configured.
 *
 * Writes go through `configForms`, so the stored list lands in the profile patch
 * and in the Host's live reference in one step; the Host row follows the same
 * namespace and re-derives its variant set on the resulting
 * `settings/document-updated` event.
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
// Type-only: the ctx.remote merge and the agentPresets namespace it carries.
import type {} from '@deepseek-ai/dsh-api-remotes/client'
// Type-only: the ctx.configForms merge, the ConfigForm type, and the
// `settings.section` SlotMap entry.
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import { DEVCONTAINER_NS, VariantsController, type DevcontainerVariantsSettings } from './controller.ts'
import { DevcontainerVariantsSection } from './VariantsSection.tsx'
import { en, zh } from './locales.ts'
// Text, not a stylesheet link: the ModuleLoader fetches one artifact, so the
// sheet is inlined at build time. See `tsdown.config.ts`.
import styles from './styles.css?inline'

export type {
  DevcontainerVariantsSettings, VariantRow, VariantsFace, VariantsFailure, VariantsState,
} from './controller.ts'
export type { DevcontainerVariantsKey } from './locales.ts'
export type { SelectablePreset } from './variants.ts'

/** Plugin id, stamped onto the injected stylesheet for teardown bookkeeping. */
const PLUGIN_ID = '@banzhe/dsh-devcontainer'

const NS = DEVCONTAINER_NS

export const inject = ['configForms', 'locale', 'remote', 'remote.agentPresets', 'slots']

// Type-only: the roster read this page performs.
import type { RosterListing } from './controller.ts'

export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'devcontainer: dictionaries')
  // The page's stylesheet rides the plugin's own fiber: unload removes it. It
  // carries the shell's `--dsw-*` token values, which only resolve inside a
  // themed document, so it is a `<style>` tag installed here — not inline
  // declarations on the elements, which beat every stylesheet in the cascade.
  ctx.effect(() => {
    if (typeof document === 'undefined') return () => {}
    const tag = document.createElement('style')
    tag.dataset.plugin = PLUGIN_ID
    tag.dataset.pluginCss = `${PLUGIN_ID}/styles.css`
    tag.textContent = styles
    document.head.appendChild(tag)
    return () => { tag.remove() }
  }, 'devcontainer: stylesheet')

  const form = ctx.configForms.get<DevcontainerVariantsSettings>(NS)
  ctx.effect(() => ctx.configForms.whileServed([NS], () => ctx.slots.inject('settings.section', () => {
    // The shared form is owned by configForms: repeated `get` returns the same
    // controller, so this page and any other editor of the entry share one write
    // queue and one revision fence.
    const controller = new VariantsController(form, async () => {
      // A build that serves no `agentPresets` namespace reports the page as
      // unreadable instead of throwing during plugin activation.
      const namespace = ctx.remote.agentPresets as { list?: RosterListing }
      if (typeof namespace.list !== 'function') return { ok: false }
      return namespace.list()
    })
    const offSlot = ctx.slots.register({
      name: 'settings.section',
      id: NS,
      // After the visibility page (order 30): this one decides what exists at all.
      order: 31,
      label: () => ctx.locale.bind(NS)('nav'),
      locale: NS,
      inject: () => controller.inject(),
    }, DevcontainerVariantsSection)
    // Reverse order: drop the registration before releasing what renders it.
    return [offSlot, () => { controller.dispose() }]
  })), 'devcontainer: variants page')
}
