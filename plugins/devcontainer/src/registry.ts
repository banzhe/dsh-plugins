/**
 * The state each composition shares between the Bundle's three Loader rows: the
 * discovery cache, and the sandbox image the Host row configures.
 *
 * The rows are separate Cordis plugins (one service each) but they must agree on
 * what "this repository's container" means, and the rows that create sandboxes
 * must see the image the settings page writes into the Host row. Keying both by
 * the composition root gives them one answer without letting two DSH instances in
 * the same process — or a reloaded plugin — inherit another's.
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

/** The live sandbox image one row publishes, per composition root. */
const SANDBOX_TEMPLATES = new WeakMap<object, () => string | undefined>()

/**
 * Publish the image the Host row configures right now to the composition's other
 * rows.
 *
 * `sbxTemplate` belongs to the Host row alone — the row the settings page writes,
 * because a page writes its own namespace — while the rows that run commands and
 * files are the ones that create a sandbox. The reader is registered once and
 * called at the moment a specification is built, so a settings write is answered
 * by the very next command instead of the next reload; nothing is copied at mount
 * time, when the profile patch may not have landed yet.
 * @param scope - the registering row's context.
 * @param read - the reader; returning undefined means "no image configured".
 * @returns the disposer that withdraws the reader.
 */
export function registerSandboxTemplate(
  scope: Context | object, read: () => string | undefined,
): () => void {
  const key = rootOf(scope)
  SANDBOX_TEMPLATES.set(key, read)
  return () => {
    if (SANDBOX_TEMPLATES.get(key) === read) SANDBOX_TEMPLATES.delete(key)
  }
}

/**
 * The image this composition's Host row configures right now.
 * @param scope - the calling row's context.
 * @returns the image, or undefined when that row configured none or is not loaded.
 */
export function liveSandboxTemplate(scope?: Context | object): string | undefined {
  return scope === undefined ? undefined : SANDBOX_TEMPLATES.get(rootOf(scope))?.()
}
