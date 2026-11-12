/**
 * Test double for the `slots` service.
 *
 * The published `@deepseek-ai/dsh-client-ui-renderer/client` entry is a BROWSER
 * bundle, so this double implements only what this plugin's `apply` uses, to
 * assert WHICH entries were registered, WHAT they carried, and THAT unloading
 * the plugin's fiber removes them.
 *
 * Two lifetime rules are reproduced, and the split matters:
 * - `inject` runs its declaration effect on the CALLER's fiber (cordis's
 *   service proxy rebinds `this.ctx` at call time), exactly like the real
 *   service, so whatever the callback declares — a component, or a keyed
 *   glyph — is withdrawn with the plugin that declared it.
 * - `register` hands back a plain disposer and does NOT own that lifetime, so
 *   a spec can tell a plugin that cleans up after itself from one that leaks.
 *
 * Each registration is recorded as its own entry under the slot `name` plus
 * the keyed `key` (or the list `id`): three keyed glyphs of one slot stay
 * three entries instead of collapsing into a single stored key, so a spec can
 * verify withdrawal entry by entry.
 *
 * Production code never imports this: every cross-package import in `src/` is
 * type-only, so the shipped browser bundle has no runtime imports beyond React.
 */
import { Service, type Context } from '@deepseek-ai/cordis'

export interface SlotRegisterOptions {
  readonly name?: string | undefined
  readonly id?: string | undefined
  readonly key?: string | undefined
  readonly order?: number | undefined
  readonly locale?: string | undefined
  readonly inject?: (() => Record<string, unknown>) | undefined
}

export interface SlotsDoubleEntry {
  readonly name: string | undefined
  readonly key: string | undefined
  readonly id: string | undefined
  readonly order: number | undefined
  readonly locale: string | undefined
  readonly component: unknown
  readonly injected: Record<string, (...args: never[]) => unknown>
  /** The disposer this registration returned; it withdraws this entry alone. */
  readonly dispose: () => void
}

export class SlotsDouble extends Service {
  private readonly entries = new Map<string, SlotsDoubleEntry>()
  private readonly injectedKeys: string[] = []
  private issued = 0

  /** The context whose fiber owns every registration this double records. */
  constructor(ctx: Context) {
    super(ctx, 'slots')
  }

  /**
   * Run the injection callback on the caller's fiber, so plugin unload disposes
   * whatever it declared — including a keyed generator, whose yielded
   * disposers are registered in order.
   */
  inject(key: string, callback: () => () => void): () => void {
    this.injectedKeys.push(key)
    const dispose = this.ctx.effect(callback, `slots.inject(${JSON.stringify(key)})`)
    return () => { void dispose() }
  }

  register(options: SlotRegisterOptions, component: unknown): () => void {
    const token = [options.name ?? '', options.key ?? '', options.id ?? '', String(this.issued++)].join('#')
    const dispose = (): void => { this.entries.delete(token) }
    const record: SlotsDoubleEntry = {
      name: options.name,
      key: options.key,
      id: options.id,
      order: options.order,
      locale: options.locale,
      component,
      injected: (options.inject?.() ?? {}) as unknown as Record<string, (...args: never[]) => unknown>,
      dispose,
    }
    this.entries.set(token, record)
    return dispose
  }

  /** Registrations still live, in registration order. */
  get live(): readonly SlotsDoubleEntry[] {
    return [...this.entries.values()]
  }

  /** Slot keys the plugin declared through `slots.inject`. */
  get injections(): readonly string[] {
    return [...this.injectedKeys]
  }

  /** Live registrations of one slot name. */
  entriesOf(name: string): readonly SlotsDoubleEntry[] {
    return this.live.filter(entry => entry.name === name)
  }

  /** One live registration of a slot by its keyed key (or list id). */
  entryOf(name: string, key: string): SlotsDoubleEntry | undefined {
    return this.live.find(entry => entry.name === name && (entry.key ?? entry.id) === key)
  }
}
