/**
 * Rescue stranded sessions whose recorded agent preset no longer exists, by
 * wrapping the preset registry singleton's own `resolve`/`retain` so a missing
 * or broken identity falls back to the deployment default.
 *
 * See `docs/adr/0011-agent-preset-fallback.md`.
 *
 * @module @banzhe/dsh-agent-preset-fallback
 */

import type { Context } from '@deepseek-ai/cordis'
// Type-only: the `agentPresets` service augmentation.
import type {} from '@deepseek-ai/dsh-agent-preset-registry'

export const name = 'agent-preset-fallback'

export const inject = ['agentPresets']

/** `retain` is class-private; the patch targets it structurally, by name. */
interface PatchableRegistry {
  defaultId: string
  resolve(wanted?: string): Promise<{ id: string }>
  retain(wanted?: string): Promise<{ id: string }>
}

/** RemoteError codes a rescue covers; everything else propagates untouched. */
const RESCUED_CODES = new Set(['agent-preset/not-found', 'agent-preset/invalid'])

/** The patch must land on an untouched instance: refuse any pre-existing own property. */
function guarded(registry: PatchableRegistry, method: 'resolve' | 'retain'): boolean {
  const descriptor = Object.getOwnPropertyDescriptor(registry, method)
  if (descriptor === undefined) return true
  return descriptor.value === (registry as unknown as Record<string, unknown>)[`original${method}`]
}

/** `RemoteError` carries no name/class link across packages; discriminate on `code`. */
function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string'
    ? error.code
    : undefined
}

export function apply(ctx: Context): void {
  const registry = ctx.agentPresets as unknown as PatchableRegistry

  /**
   * The registry supplies exactly one provider, so the service instance cannot
   * be re-provided; and `mount` reaches `retain` through `this.retain`, which
   * only an own property on the same instance intercepts — replacing the
   * prototype methods or wrapping a whole new service would miss internal
   * dispatch. Own properties also leave `defaultId` untouched and uninstall
   * cleanly.
   */
  if (!guarded(registry, 'resolve') || !guarded(registry, 'retain')) return

  const originalResolve = registry.resolve.bind(registry)
  const originalRetain = registry.retain.bind(registry)

  /** The current default can never rescue itself; wrap non-default ids only. */
  const shouldRescue = (wanted: string | undefined) => wanted !== undefined && wanted !== registry.defaultId

  registry.resolve = async (wanted?: string) => {
    try {
      return await originalResolve(wanted)
    } catch (error) {
      if (!shouldRescue(wanted) || !RESCUED_CODES.has(errorCode(error) ?? '')) throw error
      const broken = errorCode(error) === 'agent-preset/invalid'
      ctx.logger.warn(`${name}: preset "${wanted}" is ${broken ? 'broken' : 'gone'}; falling back to default "${registry.defaultId}"`)
      return originalResolve(registry.defaultId)
    }
  }

  registry.retain = async (wanted?: string) => {
    try {
      return await originalRetain(wanted)
    } catch (error) {
      if (!shouldRescue(wanted) || !RESCUED_CODES.has(errorCode(error) ?? '')) throw error
      const broken = errorCode(error) === 'agent-preset/invalid'
      ctx.logger.warn(`${name}: preset "${wanted}" is ${broken ? 'broken' : 'gone'}; falling back to default "${registry.defaultId}"`)
      return originalRetain(registry.defaultId)
    }
  }

  ctx.effect(() => () => {
    delete (registry as unknown as { resolve?: unknown }).resolve
    delete (registry as unknown as { retain?: unknown }).retain
  }, `${name}.unpatch`)
}