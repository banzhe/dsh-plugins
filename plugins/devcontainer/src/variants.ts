/**
 * The live registration set of derived presets.
 *
 * The settings page can add or remove a source at any moment, so a derived
 * preset is not a startup artefact: this class owns the difference between what
 * is registered right now and what the stored source list asks for, and applies
 * it one operation at a time. `register`/dispose are awaited in queue order, so a
 * person toggling two rows quickly cannot leave a half-applied set behind.
 *
 * @module @banzhe/dsh-devcontainer/variants
 */

import type { PresetDefinition } from '@deepseek-ai/dsh-agent-preset-registry'
import { planVariants } from './presets.ts'
import type { PresetDeclaration, PlannedVariant } from './presets.ts'

/** The registry slice this class calls. */
export interface VariantRegistryLike {
  /** Register one derived preset; resolves to its disposer. */
  register(definition: PresetDefinition): Promise<() => Promise<void>>
}

/** The logging slice this class calls. */
export interface VariantLogLike {
  warn(message: string): void
}

/** How the derived set is built. */
export interface VariantSyncOptions {
  /** The Host preset registry. */
  readonly registry: VariantRegistryLike
  /** Reports a variant that could not be registered. */
  readonly logger: VariantLogLike
  /** Reads the raw declarations of the current composition. */
  readonly declarations: () => ReadonlyMap<string, PresetDeclaration>
  /** Added to each source order. */
  readonly orderOffset: number
  /** Route-following depth cap. */
  readonly maxDepth?: number
}

/**
 * Keeps the registered variant set equal to the two stored source lists.
 *
 * Every call is idempotent: `sync` registers what is missing, disposes what is
 * no longer asked for, and touches nothing that is already correct. A variant
 * that fails to register is dropped from the bookkeeping and logged, so the rest
 * of the set still applies.
 */
export class VariantSync {
  /** Registered variant ids, in registration order, with their disposers. */
  private readonly registered = new Map<string, () => Promise<void>>()

  /** Serializes overlapping syncs so a later list cannot observe a half-applied one. */
  private queue: Promise<void> = Promise.resolve()

  /** Set once the row unloads: a queued sync then registers nothing. */
  private stopped = false

  constructor(private readonly options: VariantSyncOptions) {}

  /** The ids registered right now, in dependency order. */
  ids(): string[] {
    return [...this.registered.keys()]
  }

  /**
   * Apply both source lists.
   * @param sources - the preset ids to derive `… (devContainer)` variants from.
   * @param sbxSources - the preset ids to derive `… (sbx)` variants from.
   * @returns the settled application, in queue order.
   */
  sync(sources: readonly string[], sbxSources: readonly string[] = []): Promise<void> {
    return this.enqueue(async () => {
      if (this.stopped) return
      const planned = planVariants({
        declarations: this.options.declarations(),
        sources,
        sbxSources,
        orderOffset: this.options.orderOffset,
        ...this.options.maxDepth === undefined ? {} : { maxDepth: this.options.maxDepth },
      })
      await this.withdraw(planned)
      await this.add(planned)
    })
  }

  /**
   * Dispose every registered variant.
   * @returns the settled teardown, in queue order.
   */
  clear(): Promise<void> {
    return this.enqueue(async () => {
      await this.withdraw([])
    })
  }

  /**
   * Stop for good: queued work is skipped and nothing new registers.
   * @returns the settled teardown, in queue order.
   */
  stop(): Promise<void> {
    this.stopped = true
    return this.clear()
  }

  private enqueue(work: () => Promise<void>): Promise<void> {
    const next = this.queue.then(work, work)
    // A rejected step must not poison the queue: the next toggle still applies.
    this.queue = next.catch(() => {})
    return next
  }

  /** Dispose the registered variants the plan no longer contains, dependants first. */
  private async withdraw(planned: readonly PlannedVariant[]): Promise<void> {
    const keep = new Set(planned.map(variant => variant.id))
    const order = [...this.registered.keys()].reverse()
    for (const id of order) {
      if (keep.has(id)) continue
      const dispose = this.registered.get(id)
      this.registered.delete(id)
      if (dispose === undefined) continue
      try {
        await dispose()
      } catch (error) {
        this.options.logger.warn(`devcontainer: preset variant ${id} did not unregister cleanly: ${String(error)}`)
      }
    }
  }

  /** Register the planned variants that are not registered yet, dependencies first. */
  private async add(planned: readonly PlannedVariant[]): Promise<void> {
    for (const variant of planned) {
      if (this.registered.has(variant.id)) continue
      if (this.stopped) return
      try {
        const dispose = await this.options.registry.register({
          id: variant.id,
          name: variant.name,
          description: variant.description,
          order: variant.order,
          plugins: variant.plugins as unknown as PresetDefinition['plugins'],
        })
        this.registered.set(variant.id, dispose)
      } catch (error) {
        // One unavailable variant leaves its route on the original target.
        this.options.logger.warn(`devcontainer: preset variant ${variant.id} unavailable: ${String(error)}`)
      }
    }
  }
}
