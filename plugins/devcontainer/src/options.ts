/**
 * The configuration fields every row of this Bundle shares. The three rows are
 * separate Cordis plugins (one service each), and a repository's own file may
 * override each of these per repository — the row's value is only the default
 * discovery applies.
 * @module @banzhe/dsh-devcontainer/options
 */

import z from '@deepseek-ai/schemastery'
import type { ContainerOptions } from './types.ts'

/** Defaults for {@link ContainerOptions}. */
export const CONTAINER_OPTION_DEFAULTS: ContainerOptions = {
  shell: '/bin/bash',
  cli: 'auto',
  ensureUp: true,
  containerTimeoutMs: 300_000,
  requireContainer: false,
}

/**
 * Apply {@link CONTAINER_OPTION_DEFAULTS} to a possibly-partial configuration, so
 * a programmatic `apply()` behaves like a Loader row whose schema already filled
 * the defaults in.
 * @param config - the row's configuration, or nothing.
 * @returns the complete container options.
 */
export function containerOptions(config: Partial<ContainerOptions> = {}): ContainerOptions {
  return {
    shell: config.shell ?? CONTAINER_OPTION_DEFAULTS.shell,
    cli: config.cli ?? CONTAINER_OPTION_DEFAULTS.cli,
    ensureUp: config.ensureUp ?? CONTAINER_OPTION_DEFAULTS.ensureUp,
    containerTimeoutMs: config.containerTimeoutMs ?? CONTAINER_OPTION_DEFAULTS.containerTimeoutMs,
    requireContainer: config.requireContainer ?? CONTAINER_OPTION_DEFAULTS.requireContainer,
  }
}

/**
 * The shared Schemastery fields, spread into each row's `Config` so the three
 * rows cannot drift apart. `cli` is `auto`: an explicit container wins, the
 * running-container label lookup comes next, and the Dev Container CLI is the
 * fallback that can start the container. `sbx` selects the Docker Sandbox
 * driver, which mounts the host workspace instead of reading a declaration.
 * @returns schemastery fields for {@link ContainerOptions}.
 */
export function containerOptionFields() {
  return {
    shell: z.string().default(CONTAINER_OPTION_DEFAULTS.shell),
    cli: z.union(['auto', 'devcontainer', 'docker', 'sbx'] as const).default(CONTAINER_OPTION_DEFAULTS.cli),
    ensureUp: z.boolean().default(CONTAINER_OPTION_DEFAULTS.ensureUp),
    containerTimeoutMs: z.number().default(CONTAINER_OPTION_DEFAULTS.containerTimeoutMs),
    requireContainer: z.boolean().default(CONTAINER_OPTION_DEFAULTS.requireContainer),
  }
}

/** The two preset-source lists, which only the Host row owns. */
export interface PresetSourceOptions {
  /** Preset ids to derive a `… (devContainer)` variant from. */
  sources: readonly string[]
  /** Preset ids to derive a `… (sbx)` variant from. */
  sbxSources: readonly string[]
}

/** Defaults for {@link PresetSourceOptions}: nothing is derived until asked for. */
export const PRESET_SOURCE_DEFAULTS: PresetSourceOptions = {
  sources: [],
  sbxSources: [],
}

/**
 * The two preset-source fields as the Loader validates them.
 *
 * They are `volatile`, so a settings write lands in the live reference the Host
 * row reads on its next sync instead of needing a reload, and they are defaults
 * of the Host row only: the shell and filesystem rows have no preset set.
 * @returns schemastery fields for {@link PresetSourceOptions}.
 */
export function presetSourceFields() {
  return {
    sources: z.array(z.string()).default([]).volatile(),
    sbxSources: z.array(z.string()).default([]).volatile(),
  }
}
