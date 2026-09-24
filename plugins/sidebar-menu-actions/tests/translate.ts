/**
 * The specs' translator: one dictionary lookup with the plugin body's `{name}`
 * interpolation, so a spec asserts against the copy the dictionary actually
 * ships instead of a second, hand-kept copy of the strings.
 *
 * Both exports are typed as the `t` seat a `menu-actions` slot component
 * receives (`TranslateNS<'menu-actions'>`), so a spec passes one straight into
 * composed props and a mistyped key is a compile error. `translateZh` reads the
 * Chinese dictionary — the key-set source of truth — and `translateEn` the
 * English one the shell falls back to when the browser names no registered
 * language.
 */
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { en, zh, type MenuActionsKey } from '../src/client/locales.ts'

/**
 * Resolve one dictionary entry, replacing every `{name}` present in `params`.
 * @param template - the entry, or undefined when the dictionary misses the key.
 * @param key - the key as the seat types it; the seat also carries the shell's
 * shared `common` vocabulary, which this package's dictionaries do not own.
 * @param params - interpolation values; a name absent from them stays literal.
 * @returns the resolved string, or the key itself on a dictionary miss.
 */
function resolve(template: string | undefined, key: string, params?: Record<string, unknown>): string {
  const text = template ?? key
  if (params === undefined) return text
  return text.replace(/\{(\w+)\}/g, (match, name: string) =>
    name in params ? String(params[name]) : match)
}

/** Translate a key through the English dictionary. */
export const translateEn: TranslateNS<'menu-actions'> = (key, params) =>
  resolve(en[key as MenuActionsKey], key, params)

/** Translate a key through the Chinese dictionary. */
export const translateZh: TranslateNS<'menu-actions'> = (key, params) =>
  resolve(zh[key as MenuActionsKey], key, params)
