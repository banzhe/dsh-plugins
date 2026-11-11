/**
 * The configuration fields every row of this Bundle shares. The three rows are
 * separate Cordis plugins (one service each), and a repository's own file may
 * override each of these per repository — the row's value is only the default
 * discovery applies.
 * @module @banzhe/dsh-devcontainer/options
 */

import z from '@deepseek-ai/schemastery'
import { HOST_MOUNT_DEFAULTS } from './host-mounts.ts'
import { SANDBOX_TEMPLATE_PATTERN } from './sbx-template.ts'
import type { ContainerOptions, HostMountsConfig } from './types.ts'

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

/** Defaults for {@link SandboxTemplateOptions}: no image, so the CLI template stands. */
export const SANDBOX_TEMPLATE_DEFAULTS: SandboxTemplateOptions = {
  sbxTemplate: '',
}

/** The sandbox image a created Docker Sandbox runs, owned by the Host row. */
export interface SandboxTemplateOptions {
  /** Image `sbx create --template` takes; blank keeps Docker's `shell` template. */
  sbxTemplate: string
}

/**
 * The image field as the Loader validates it.
 *
 * It is `volatile`, so the settings page writes it into the live reference the
 * rows read on their next command instead of needing a reload, and it is a default
 * of the Host row only: the shell and filesystem rows have no settings page, and
 * two more copies would be two more values to keep in step.
 * @returns schemastery fields for {@link SandboxTemplateOptions}.
 */
export function sandboxTemplateFields() {
  return {
    sbxTemplate: z.string().default(SANDBOX_TEMPLATE_DEFAULTS.sbxTemplate).pattern(SANDBOX_TEMPLATE_PATTERN).volatile(),
  }
}

/** The extra read-only host paths a created Docker Sandbox mounts, owned by the Host row. */
export interface HostMountOptions {
  /**
   * `auto` mounts the host's `AGENTS.md` and skill trees when they exist, `off`
   * mounts none, and a list names the `PATH[:TARGET][:ro]` entries to mount. Every
   * entry is mounted read-only and skipped when its source is missing.
   */
  hostMounts: HostMountsConfig
}

/**
 * The extra-mount field as the Loader validates it.
 *
 * A default of the Host row only, like the image: the rows that create a sandbox
 * read it through the registry reader, so the value has one owner and one shape. It
 * is `volatile` for the same reason the image is, so a settings write lands in the
 * live reference the rows read on their next command.
 * @returns schemastery fields for {@link HostMountOptions}.
 */
export function hostMountFields() {
  return {
    hostMounts: z
      .union([z.const('auto'), z.const('off'), z.array(z.string())])
      .default(HOST_MOUNT_DEFAULTS)
      .volatile(),
  }
}
