/**
 * Test double for the `locale` service.
 *
 * The published `@deepseek-ai/dsh-client-locale/client` entry is a BROWSER
 * bundle, so this double reproduces the two calls the plugin makes — the
 * single-locale `register` that the dialog's dictionaries ride (one owner per
 * namespace and locale, disposer returned) and `bind` (resolved at call time,
 * `{name}` interpolation, unknown keys falling through as the key). The active
 * locale starts at `zh`: the shipped dialog defaults are the Chinese
 * dictionaries, and the profile this Bundle serves runs `zh`.
 *
 * Production code never imports this.
 */
import { Service, type Context } from '@deepseek-ai/cordis'

/** One namespace's dictionaries by locale id. */
export type LocaleDict = Record<string, string>

export class LocaleDouble extends Service {
  private readonly dicts = new Map<string, Map<string, LocaleDict>>()
  private readonly bound = new Map<string, (key: string, params?: Record<string, unknown>) => string>()
  private active = 'zh'

  /** @param ctx - owning context. */
  constructor(ctx: Context) {
    super(ctx, 'locale')
  }

  /**
   * Register one namespace's copy: the single-locale form the plugin uses.
   * @param ns - namespace.
   * @param locale - locale id.
   * @param dict - the dictionary.
   * @returns disposable withdrawing this exact dictionary.
   */
  register(ns: string, locale: string, dict: LocaleDict): () => void {
    const locales = this.dicts.get(ns) ?? new Map<string, LocaleDict>()
    this.dicts.set(ns, locales)
    if (locales.has(locale)) throw new Error(`locale namespace "${ns}" already has locale "${locale}"`)
    locales.set(locale, dict)
    return () => {
      if (locales.get(locale) === dict) locales.delete(locale)
    }
  }

  /**
   * Bind a namespace to a translate function that reads the active locale at
   * call time.
   * @param ns - namespace.
   * @returns the translate function.
   */
  bind(ns: string): (key: string, params?: Record<string, unknown>) => string {
    const cached = this.bound.get(ns)
    if (cached !== undefined) return cached
    const translate = (key: string, params?: Record<string, unknown>): string => {
      const template = this.dicts.get(ns)?.get(this.active)?.[key] ?? key
      if (params === undefined) return template
      return template.replace(/\{(\w+)\}/g, (match, name: string) => name in params ? String(params[name]) : match)
    }
    this.bound.set(ns, translate)
    return translate
  }

  /**
   * Switch the dictionary the bound translate functions read.
   * @param id - locale id.
   */
  setLocale(id: string): void {
    this.active = id
  }
}
