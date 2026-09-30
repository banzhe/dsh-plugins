/**
 * Test double for the `slots` service.
 *
 * The published `@deepseek-ai/dsh-client-ui-renderer/client` entry is a BROWSER
 * bundle (`window.__ModuleLoader__.load(...)`), and the real registry's behavior
 * is covered by its own suite in the harness. This double implements only what
 * this plugin's apply uses, so the specs can assert WHICH entry was registered,
 * WHAT it was injected with, and THAT unloading the plugin's fiber removes it.
 *
 * The fiber tie is the contract that matters: the real `slots.inject` runs its
 * declaration effect on the CALLER's fiber (cordis's service proxy rebinds
 * `this.ctx` to the caller at call time), so this double extends `Service` to
 * inherit exactly that routing. A double that merely invoked the callback would
 * make disposability untestable.
 *
 * Production code never imports this.
 */
import { Service, type Context } from '@deepseek-ai/cordis'
import type { AttentionInjected } from '../src/client/AttentionOverlay.tsx'

/** One recorded registration. */
export interface SlotsDoubleEntry {
  readonly options: {
    readonly id?: string | undefined
    readonly order?: number | undefined
    readonly locale?: string | undefined
  }
  readonly component: unknown
  /** The business face the registration's `inject` factory returned. */
  readonly injected: Record<string, (...args: never[]) => unknown>
}

/** Recorded registrations keyed by the entry id they registered with. */
export class SlotsDouble extends Service {
  private readonly entries = new Map<string, SlotsDoubleEntry>()

  /** The context whose fiber owns every registration this double records. */
  constructor(ctx: Context) {
    super(ctx, 'slots')
  }

  /**
   * Run the injection callback on the caller's fiber, so plugin unload disposes
   * whatever it registered (mirrors the real `slots.inject` lifetime contract).
   */
  inject(_key: string, callback: () => () => void): () => void {
    const dispose = this.ctx.effect(callback, `slots.inject(${JSON.stringify(_key)})`)
    return () => { void dispose() }
  }

  /** Record one registration; returns the disposer that removes this entry. */
  register(
    options: { id?: string; order?: number; locale?: string; inject?: (...args: never[]) => Record<string, never> },
    component: unknown,
  ): () => void {
    const key = options.id ?? ''
    const record: SlotsDoubleEntry = {
      options: { id: options.id, order: options.order, locale: options.locale },
      component,
      injected: (options.inject?.() ?? {}) as unknown as Record<string, (...args: never[]) => unknown>,
    }
    this.entries.set(key, record)
    return () => { this.entries.delete(key) }
  }

  /** The live registration for one entry id, if any; undefined once disposed. */
  entry(id: string): SlotsDoubleEntry | undefined {
    return this.entries.get(id)
  }

  /**
   * The injected business face of one entry id. Throws when absent, so a spec
   * cannot silently assert against an unregistered entry. Typed as the plugin's
   * own injected face: `Record<string, …>` would make every member
   * `| undefined` under `noUncheckedIndexedAccess`, forcing `?.` at each call.
   */
  injection(id: string): AttentionInjected {
    const found = this.entries.get(id)
    if (found === undefined) throw new Error(`no live slot registration "${id}"`)
    return found.injected as unknown as AttentionInjected
  }
}
