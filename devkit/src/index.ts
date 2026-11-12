/**
 * Build-time helpers shared by this workspace's Bundles. Everything here runs in
 * a `tsdown.config.ts` and ships in no plugin artifact.
 *
 * - {@link clientBundle} — the two-half Bundle recipe (Node ESM + wrapped browser
 *   factory), the DSH Web platform-module baseline it resolves against, and the
 *   per-package overrides those rules allow.
 * - {@link cssPlugins} — the three stylesheet import forms a client half may use.
 */
export { PLATFORM_MODULES, clientBundle, type ClientBundleOptions, type NodeBundleOptions } from './tsdown-client.ts'
export { cssPlugins, type CssPluginOptions } from './tsdown-css.ts'
