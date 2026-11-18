/**
 * Test double for the `slots` service.
 *
 * The published `@deepseek-ai/dsh-client-ui-renderer/client` entry is a BROWSER
 * bundle, so this double reproduces the three contracts the plugin's `apply`
 * depends on and nothing else:
 *
 * - `inject` runs the callback on the CALLER's fiber, synchronously when the
 *   slot is already declared and on the declaration otherwise; a deferred
 *   setup failure reaches the fail-loud channel instead of the caller's stack.
 * - `register` refuses a second occupant of one slot name, and its returned
 *   disposer withdraws exactly that entry.
 * - an iterable callback installs transactionally: a throw part-way disposes
 *   what it already installed.
 *
 * Production code never imports this: every cross-package import in `src/` is
 * type-only, so the shipped browser bundle carries no runtime imports beyond
 * React, clsx, and the shell's module table.
 */
import { Service, type Context } from '@deepseek-ai/cordis'

/** One live registration: the slot it occupies and the inject factory the spec calls. */
export interface SlotsDoubleEntry {
  readonly name: string
  readonly inject: ((...args: never[]) => Record<string, unknown>) | undefined
}

/** What one `inject` subscription is waiting for (and what it installed). */
interface Subscription {
  readonly callback: () => (() => void) | Iterable<() => void>
  active: (() => void) | undefined
  stopped: boolean
}

export class SlotsDouble extends Service {
  private readonly declaredNames = new Set<string>()
  private readonly records = new Map<number, SlotsDoubleEntry>()
  private readonly subscriptions = new Map<string, Set<Subscription>>()
  private issued = 0

  /** @param ctx - owning context; every effect rides the caller's fiber through the service proxy. */
  constructor(ctx: Context) {
    super(ctx, 'slots')
  }

  /**
   * Declare slot names, as a parent entry does through its `children` map.
   * @param names - slot names this declaration opens.
   */
  declare(names: readonly string[]): void {
    for (const name of names) {
      if (this.declaredNames.has(name)) continue
      this.declaredNames.add(name)
      for (const subscription of this.subscriptions.get(name) ?? []) this.reconcile(name, subscription, 'loud')
    }
  }

  /**
   * Run one callback per declaration lifetime of a slot, on the caller's fiber.
   * @param key - slot name to depend on.
   * @param callback - creates one disposer or an iterable of disposers.
   * @returns idempotent disposer for the wait and the active effect.
   */
  inject(key: string, callback: () => (() => void) | Iterable<() => void>): () => void {
    const subscription: Subscription = { callback, active: undefined, stopped: false }
    const pending = this.subscriptions.get(key) ?? new Set<Subscription>()
    this.subscriptions.set(key, pending)
    pending.add(subscription)
    const retire = (): void => {
      this.stop(subscription)
      pending.delete(subscription)
      if (pending.size === 0) this.subscriptions.delete(key)
    }
    const disposeController = this.ctx.effect(() => retire, `slots.inject(${JSON.stringify(key)})`)
    // The FIRST attempt runs in the caller's stack, exactly as the registry
    // documents: a setup failure rejects the caller's own fiber.
    try {
      this.reconcile(key, subscription, 'throw')
    } catch (error) {
      retire()
      void disposeController()
      throw error
    }
    return () => { void disposeController() }
  }

  /**
   * Record one registration under the caller's fiber. The component itself is
   * not kept: no spec reads it back, and every assertion here goes through the
   * inject face or the entry count.
   * @param options - slot name plus the inject factory the spec reads back.
   * @param _component - the registered component (unused).
   * @returns disposer withdrawing this entry alone.
   */
  register(
    options: { name?: string | undefined; inject?: ((...args: never[]) => Record<string, unknown>) | undefined },
    _component: unknown,
  ): () => void {
    const name = options.name
    if (name === undefined) throw new Error('slots-double: a registration needs a slot name')
    const occupant = [...this.records.values()].find(record => record.name === name)
    if (occupant !== undefined) throw new Error(`single slot "${name}" already has a registration`)
    const token = this.issued++
    const record: SlotsDoubleEntry = { name, inject: options.inject }
    this.records.set(token, record)
    const dispose = this.ctx.effect(() => () => { this.records.delete(token) }, `slots.register(${JSON.stringify(name)})`)
    return () => { void dispose() }
  }

  /** Live registrations of one slot name, in registration order. */
  entries(name: string): readonly SlotsDoubleEntry[] {
    return [...this.records.values()].filter(record => record.name === name)
  }

  /**
   * Run one subscription against the current declaration state.
   * @param key - slot name the subscription waits on.
   * @param subscription - the wait and whatever it installed.
   * @param failure - whether a setup failure returns to the caller (`throw`) or
   * rides the fail-loud channel (`loud`), as a late declaration notification does.
   */
  private reconcile(key: string, subscription: Subscription, failure: 'throw' | 'loud'): void {
    if (subscription.stopped || subscription.active !== undefined) return
    if (!this.declaredNames.has(key)) return
    try {
      const dispose = this.ctx.effect(subscription.callback, `slots.inject(${JSON.stringify(key)}): declaration`)
      subscription.active = () => { void dispose() }
    } catch (error) {
      // The registry retires a failed injection permanently: a delayed setup
      // failure never retries on a later declaration.
      this.stop(subscription)
      if (failure === 'throw') throw error
      const loud = error instanceof Error ? error : new Error(String(error))
      queueMicrotask(() => { throw loud })
    }
  }

  /** Retire one subscription and whatever it installed. */
  private stop(subscription: Subscription): void {
    if (subscription.stopped) return
    subscription.stopped = true
    const dispose = subscription.active
    subscription.active = undefined
    dispose?.()
  }
}
