/**
 * The discovery cache each composition shares between the Bundle's three Loader
 * rows, and nothing else.
 *
 * The rows are separate Cordis plugins (one service each) but they must agree on
 * what "this repository's container" means. Keying the cache by the composition
 * root gives them one answer without letting two DSH instances in the same
 * process — or a reloaded plugin — inherit another's discoveries.
 * @module @banzhe/dsh-devcontainer/registry
 */
import type { Context } from '@deepseek-ai/cordis'
import { RepoContainerRegistry } from './config-loader.ts'

const REGISTRIES = new WeakMap<object, RepoContainerRegistry>()
const DEFAULT = new RepoContainerRegistry()

/** The composition root one context belongs to. */
function rootOf(scope: Context | object): object {
  const root: unknown = (scope as { root?: unknown }).root
  return typeof root === 'object' && root !== null ? root : scope
}

/**
 * The discovery cache for one composition.
 * @param scope - a row's context, or the composition root; omitted for a bare cache.
 * @returns the registry shared by every row of that composition.
 */
export function repoRegistry(scope?: Context | object): RepoContainerRegistry {
  if (scope === undefined) return DEFAULT
  const key = rootOf(scope)
  const cached = REGISTRIES.get(key)
  if (cached !== undefined) return cached
  const registry = new RepoContainerRegistry()
  REGISTRIES.set(key, registry)
  return registry
}
