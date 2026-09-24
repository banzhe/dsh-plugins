/**
 * Test double for the `locale` service.
 *
 * The published `@deepseek-ai/dsh-client-locale/client` entry is a BROWSER
 * bundle (`window.__ModuleLoader__.load(...)`, resolved from
 * `exports["./client"]`), so a Node test cannot import it. This double
 * implements only the two methods the plugin actually calls — `register` and
 * `bind` — with the same contract: `register` returns the disposer, and `bind`
 * resolves the active locale at call time with `{name}` interpolation
 * (`String(params[name])` for each `{name}` where `name in params`; unknown
 * keys fall through as the literal `{name}`; a missing key returns the key
 * itself). The default active locale is `'en'` and `setLocale(id)` switches it.
 *
 * Production code never imports this: every cross-package import in `src/` is
 * type-only, so the shipped browser bundle has no runtime imports at all.
 */

/** Per-namespace dictionaries keyed by locale id. */
export type LocaleDicts = Record<string, Record<string, string>>

/** The slice of `ctx.locale` the plugin binds. */
export class LocaleDouble {
  private readonly dicts = new Map<string, LocaleDicts>()
  private active = 'en'

  /**
   * Register one namespace's dictionaries.
   * @param ns - namespace.
   * @param dicts - locale id to flat dictionary.
   * @returns the disposer that removes exactly this registration.
   */
  register(ns: string, dicts: LocaleDicts): () => void {
    this.dicts.set(ns, dicts)
    return () => { this.dicts.delete(ns) }
  }

  /**
   * Bind a namespace to a translate function reading the active locale at call time.
   * @param ns - namespace.
   * @returns the translate function.
   */
  bind(ns: string): (key: string, params?: Record<string, unknown>) => string {
    return (key, params) => {
      const template = this.dicts.get(ns)?.[this.active]?.[key] ?? key
      if (params === undefined) return template
      return template.replace(/\{(\w+)\}/g, (match, name: string) =>
        name in params ? String(params[name]) : match)
    }
  }

  /**
   * Switch the active locale.
   * @param id - locale id.
   */
  setLocale(id: string): void {
    this.active = id
  }
}
