/**
 * The specs' translator: one dictionary lookup with the plugin body's `{name}`
 * interpolation, so a spec asserts against the copy the dictionary actually
 * ships instead of a second, hand-kept copy of the strings.
 *
 * Both exports are typed as the `t` seat a `menu-actions` slot component
 * receives (`TranslateNS<'menu-actions'>`), so a spec passes one straight into
 * composed props and a mistyped key is a compile error.
 */
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { en, zh, type MenuActionsKey } from '../src/client/locales.ts'

/**
 * The `t` seat also types the shell's shared `common` vocabulary, which these
 * dictionaries do not own: such a key misses and falls back to the key itself.
 */
function resolve(template: string | undefined, key: string, params?: Record<string, unknown>): string {
  const text = template ?? key
  if (params === undefined) return text
  return text.replace(/\{(\w+)\}/g, (match, name: string) =>
    name in params ? String(params[name]) : match)
}

export const translateEn: TranslateNS<'menu-actions'> = (key, params) =>
  resolve(en[key as MenuActionsKey], key, params)

export const translateZh: TranslateNS<'menu-actions'> = (key, params) =>
  resolve(zh[key as MenuActionsKey], key, params)
