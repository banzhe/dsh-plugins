/**
 * Doubles for the browser services the client half registers into.
 *
 * The published `/client` entries of the `@deepseek-ai/dsh-client-*` packages are
 * browser bundles, so a Node spec cannot import them. Each double reproduces only
 * the contract this plugin relies on: a registration returns its own disposer, a
 * slot injection runs its declaration on the caller's fiber, and `locale.bind`
 * resolves the active language at call time with `{name}` interpolation.
 */

export type LocaleDicts = Record<string, Record<string, string>>

export class LocaleDouble {
  private readonly dicts = new Map<string, LocaleDicts>()
  private active = 'en'

  register(namespace: string, dicts: LocaleDicts): () => void {
    this.dicts.set(namespace, dicts)
    return () => { this.dicts.delete(namespace) }
  }

  bind(namespace: string): (key: string, params?: Record<string, unknown>) => string {
    return (key, params) => {
      const template = this.dicts.get(namespace)?.[this.active]?.[key] ?? key
      if (params === undefined) return template
      return template.replace(/\{(\w+)\}/g, (match, name: string) => (name in params ? String(params[name]) : match))
    }
  }

  setLocale(id: string): void {
    this.active = id
  }

  get namespaces(): string[] {
    return [...this.dicts.keys()]
  }
}

export interface SlotRegisterOptions {
  readonly name?: string | undefined
  readonly key?: string | undefined
  readonly locale?: string | undefined
}

export interface SlotEntry {
  readonly name: string | undefined
  readonly key: string | undefined
  readonly locale: string | undefined
  readonly component: unknown
  readonly dispose: () => void
}

/** Records slot entries, and the injection keys that declared them. */
export class SlotsDouble {
  readonly entries: SlotEntry[] = []
  readonly injections: string[] = []
  private readonly disposers: Array<() => void> = []

  /** Runs the declaration on the caller's fiber, like the real service does. */
  inject(key: string, callback: () => () => void): () => void {
    this.injections.push(key)
    const dispose = callback()
    this.disposers.push(dispose)
    return dispose
  }

  register(options: SlotRegisterOptions, component: unknown): () => void {
    const entry: SlotEntry = {
      name: options.name,
      key: options.key,
      locale: options.locale,
      component,
      dispose: () => {
        const at = this.entries.indexOf(entry)
        if (at !== -1) this.entries.splice(at, 1)
      },
    }
    this.entries.push(entry)
    return entry.dispose
  }

  /** Withdraw everything a single `inject` declaration registered. */
  disposeAll(): void {
    for (const dispose of this.disposers.splice(0)) dispose()
  }
}

/** Stage one of the tab system: one recorded definition per registration. */
export class TabsDouble {
  readonly definitions: Array<Record<string, unknown>> = []

  register(definition: Record<string, unknown>): () => void {
    this.definitions.push(definition)
    return () => {
      const at = this.definitions.indexOf(definition)
      if (at !== -1) this.definitions.splice(at, 1)
    }
  }
}
