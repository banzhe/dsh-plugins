/**
 * Test double for the `slots` service.
 *
 * The published `@deepseek-ai/dsh-client-ui-renderer/client` entry is a BROWSER
 * bundle, and the real registry's behavior is covered by its own suite in the
 * harness. This double implements only what this plugin's apply uses, so the
 * spec can assert WHICH entry was registered into WHICH slot and hand its
 * component the standard props itself.
 *
 * Entries are filed under their list `id` or, for a keyed slot, their `key`:
 * this plugin contributes one keyed icon renderer (the menu rows' application
 * image) and nothing else.
 *
 * Extending `Service` keeps `inject` running its callback on the CALLER's
 * fiber, exactly as the real `slots.inject` does.
 *
 * Production code never imports this.
 */
import { Service, type Context } from '@deepseek-ai/cordis'

export interface SlotsDoubleEntry {
  readonly options: {
    readonly name?: string | undefined
    readonly id?: string | undefined
    readonly key?: string | undefined
    readonly order?: number | undefined
    readonly locale?: string | undefined
  }
  readonly component: unknown
}

export class SlotsDouble extends Service {
  private readonly entries = new Map<string, SlotsDoubleEntry>()
  private readonly injections: string[] = []

  constructor(ctx: Context) {
    super(ctx, 'slots')
  }

  inject(key: string, callback: () => () => void): () => void {
    this.injections.push(key)
    const dispose = this.ctx.effect(callback, `slots.inject(${JSON.stringify(key)})`)
    return () => { void dispose() }
  }

  register(
    options: SlotsDoubleEntry['options'],
    component: unknown,
  ): () => void {
    const cell = options.id ?? options.key ?? options.name ?? ''
    this.entries.set(cell, {
      options: {
        name: options.name, id: options.id, key: options.key,
        order: options.order, locale: options.locale,
      },
      component,
    })
    return () => { this.entries.delete(cell) }
  }

  /** Throws when absent, so a spec cannot silently assert against a missing entry. */
  entry(cell: string): SlotsDoubleEntry {
    const found = this.entries.get(cell)
    if (found === undefined) throw new Error(`no live slot registration "${cell}"`)
    return found
  }

  /** Slot keys this plugin asked to be injected into, in call order. */
  injectKeys(): readonly string[] {
    return [...this.injections]
  }
}
