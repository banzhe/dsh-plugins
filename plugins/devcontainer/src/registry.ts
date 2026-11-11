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
import { HOST_MOUNT_DEFAULTS, hostMountRejections } from './host-mounts.ts'
import type { ContainerOptions, HostMountsConfig } from './types.ts'

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

/** The live extra-host-mount configuration one row publishes, per composition root. */
const HOST_MOUNTS = new WeakMap<object, () => HostMountsConfig>()

/**
 * Publish the extra host mounts the Host row configures right now.
 *
 * `hostMounts` belongs to the Host row alone, while the rows that create a sandbox
 * are the shell, filesystem, and subprocess ones — the same split `sbxTemplate`
 * has, and it is answered the same way: the reader is called when a specification
 * is built, never copied at mount time.
 * @param scope - the registering row's context.
 * @param read - the reader; it answers the value in force at this moment.
 * @returns the disposer that withdraws the reader.
 */
export function registerHostMounts(scope: Context | object, read: () => HostMountsConfig): () => void {
  const key = rootOf(scope)
  HOST_MOUNTS.set(key, read)
  return () => {
    if (HOST_MOUNTS.get(key) === read) HOST_MOUNTS.delete(key)
  }
}

/**
 * The extra host mounts this composition's Host row configures right now.
 * @param scope - the calling row's context.
 * @returns the configured value, or the schema default when no row published one.
 */
export function liveHostMounts(scope?: Context | object): HostMountsConfig {
  return scope === undefined ? HOST_MOUNT_DEFAULTS : HOST_MOUNTS.get(rootOf(scope))?.() ?? HOST_MOUNT_DEFAULTS
}

/** The specification-builder options every sandbox seam passes: the row's defaults plus the Host row's live values. */
export interface SandboxSpecOptions extends ContainerOptions {
  /** Image a created sandbox runs, or undefined for the CLI's own template. */
  readonly sbxTemplate?: string | undefined
  /** The extra read-only host paths a created sandbox mounts beside the workspace. */
  readonly hostMounts?: HostMountsConfig | undefined
}

/** The diagnostics one composition already reported, so a row cannot repeat another's. */
const REPORTED = new WeakMap<object, Set<string>>()

/**
 * Report one diagnostic once per composition.
 *
 * The shell, filesystem, and subprocess rows each resolve the same sandbox from
 * their own cache, so the same configuration mistake reaches several of them: a
 * person should read it once. The message carries the setting it is about, so a
 * changed setting is a new message and is reported again.
 * @param scope - the reporting row's context.
 * @param warn - where the message goes; nothing happens without one.
 * @param message - the diagnostic.
 */
export function warnOnce(
  scope: Context | object | undefined, warn: ((message: string) => void) | undefined, message: string,
): void {
  if (warn === undefined) return
  if (scope === undefined) {
    warn(message)
    return
  }
  const key = rootOf(scope)
  let reported = REPORTED.get(key)
  if (reported === undefined) {
    reported = new Set()
    REPORTED.set(key, reported)
  }
  if (reported.has(message)) return
  reported.add(message)
  warn(message)
}

/**
 * The entries this composition's Host row configures that no argv can carry.
 * @param scope - the calling row's context.
 * @returns one diagnostic per unusable entry, empty when every entry is usable.
 */
export function liveHostMountRejections(scope?: Context | object): readonly string[] {
  return hostMountRejections(liveHostMounts(scope))
}

/**
 * Read the live sandbox settings once, for one specification.
 * @param scope - the calling row's context.
 * @param options - the row's own container defaults.
 * @returns the builder options, carrying whatever the Host row configures right now.
 */
export function liveSbxOptions(scope: Context | object, options: ContainerOptions): SandboxSpecOptions {
  const template = liveSandboxTemplate(scope)
  return {
    ...options,
    ...template === undefined ? {} : { sbxTemplate: template },
    hostMounts: liveHostMounts(scope),
  }
}
