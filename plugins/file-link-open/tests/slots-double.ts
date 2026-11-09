/**
 * Test double for the `slots` service.
 *
 * The published `@deepseek-ai/dsh-client-ui-renderer/client` entry is a BROWSER
 * bundle, and the real registry's behavior is covered by its own suite in the
 * harness. This double implements only what this plugin's apply uses, so the
 * spec can assert WHICH entry was registered and hand its component the
 * standard Session props itself.
 *
 * Extending `Service` keeps `inject` running its callback on the CALLER's
 * fiber, exactly as the real `slots.inject` does.
 *
 * Production code never imports this.
 */
import { Service, type Context } from '@deepseek-ai/cordis'

export interface SlotsDoubleEntry {
  readonly options: {
    readonly id?: string | undefined
    readonly order?: number | undefined
    readonly locale?: string | undefined
  }
  readonly component: unknown
}

export class SlotsDouble extends Service {
  private readonly entries = new Map<string, SlotsDoubleEntry>()

  constructor(ctx: Context) {
    super(ctx, 'slots')
  }

  inject(_key: string, callback: () => () => void): () => void {
    const dispose = this.ctx.effect(callback, `slots.inject(${JSON.stringify(_key)})`)
    return () => { void dispose() }
  }

  register(
    options: SlotsDoubleEntry['options'] & { readonly name?: string },
    component: unknown,
  ): () => void {
    const key = options.id ?? ''
    this.entries.set(key, { options: { id: options.id, order: options.order, locale: options.locale }, component })
    return () => { this.entries.delete(key) }
  }

  /** Throws when absent, so a spec cannot silently assert against a missing entry. */
  entry(id: string): SlotsDoubleEntry {
    const found = this.entries.get(id)
    if (found === undefined) throw new Error(`no live slot registration "${id}"`)
    return found
  }
}
