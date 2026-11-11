/**
 * The extra read-only host paths a Docker Sandbox mounts beside the workspace.
 *
 * A `(sbx)` session's filesystem fence ends at the workspace mount, so the host's
 * global agent configuration — its `AGENTS.md` and its skill trees — is invisible
 * from inside the sandbox. `sbx create` takes further host paths as positional
 * arguments (`PATH[:TARGET][:ro]`), which is the one place they can be added: a
 * single file must carry `:ro`, and a source that does not exist is a hard CLI
 * failure, so this module decides what may be mounted before the argv is built.
 * @module @banzhe/dsh-devcontainer/host-mounts
 */

import { access } from 'node:fs/promises'
import { posix } from 'node:path'
import { resolveAgentsHome, resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { isPosixAbsolute, isWindowsPath, joinHostRoot, normalizeHostRoot, toPosixSlashes } from './paths.ts'
import type { HostMount, HostMountsConfig } from './types.ts'

/** What a row that configures nothing mounts: every default path that exists. */
export const HOST_MOUNT_DEFAULTS = 'auto'

/** The two user roots the default mount set is read from. */
export interface HostMountHomes {
  /** The DeepSeek Harness home (`$DSH_HOME`, `~/.dsh` by default). */
  readonly dshHome: string
  /** The shared agent configuration root (`$DSH_AGENTS_HOME`, `~/.agents` by default). */
  readonly agentsHome: string
}

/**
 * Resolve the two user roots through DSH's own home rules, so an override the
 * harness honours is the directory the sandbox mounts.
 * @returns both roots, resolved and normalized.
 */
export function hostMountHomes(): HostMountHomes {
  return {
    dshHome: normalizeHostRoot(resolveDshHome()),
    agentsHome: normalizeHostRoot(resolveAgentsHome()),
  }
}

/** The optional mode token a mount expression ends with. */
const MODE_SUFFIX = /:(ro|rw)$/i

/**
 * Strip the mode token a mount expression or a listing entry ends with.
 *
 * `sbx` reports a read-only mount as `host:sandbox:ro`, so the token has to come
 * off before the two paths are split — otherwise it stays on the sandbox side and
 * names a path no sandbox has. One implementation serves the row's own entries and
 * the listing, so the two cannot drift apart.
 * @param entry - one mount expression, or one entry of a row's `mounts`/`workspaces` array.
 * @returns the entry without its mode token, and whether it asked for read-only.
 */
export function splitMountMode(entry: string): { readonly text: string, readonly readOnly: boolean } {
  const match = MODE_SUFFIX.exec(entry)
  if (match === null) return { text: entry, readOnly: false }
  return { text: entry.slice(0, match.index), readOnly: match[1]?.toLowerCase() === 'ro' }
}

/** A drive letter left dangling at the end of a path, as a split would leave it. */
const TRAILING_DRIVE = /:[A-Za-z]$/

/**
 * Split a `PATH[:/TARGET]` body into its host path and the sandbox path it asks for.
 *
 * The split point is the last `:/` whose left side is an absolute host path, so a
 * drive colon stays part of the path however the drive is spelled: `D:\data\x`
 * and `D:/data/x` both name no target, while `D:/data/x:/mnt/x` names `/mnt/x`.
 * A body that splits nowhere names its tail as the target, which lets the reader
 * reject the entry instead of mistaking a second path for part of the first.
 * @param text - the expression with its mode token already removed.
 * @returns the host path as written, and the target when the entry names one.
 */
export function splitHostTarget(text: string): { readonly host: string, readonly target?: string } {
  let separator = text.lastIndexOf(':/')
  while (separator > 0) {
    const candidate = text.slice(0, separator)
    // A candidate ending in a bare drive letter is the tail of a second drive path,
    // not a host path: `C:/a/b.md:D:/c.md` must not be read as host `C:/a/b.md:D`.
    if ((isWindowsPath(candidate) || isPosixAbsolute(candidate)) && !TRAILING_DRIVE.test(candidate)) {
      return { host: candidate, target: text.slice(separator + 1) }
    }
    separator = text.lastIndexOf(':/', separator - 1)
  }
  // Nothing splits into an absolute host path and a sandbox path, so the entry is
  // malformed: name the tail after the host path, which is what a diagnostic about
  // an unusable target has to show.
  const colon = text.indexOf(':', 2)
  return colon === -1 ? { host: text } : { host: text.slice(0, colon), target: text.slice(colon + 1) }
}

/** One configured entry, read into what the argv can carry — or rejected with the reason. */
interface MountEntry {
  /** The mount the entry names, when it names a usable one. */
  readonly mount?: HostMount
  /** The sentence to report instead, when it does not. */
  readonly rejection?: string
}

/**
 * The sentence one entry with an unusable target is reported with.
 * @param expression - the entry as the row configured it.
 * @param target - the sandbox path it named.
 * @returns the diagnostic, naming the entry and the rule it breaks.
 */
function targetRejection(expression: string, target: string): string {
  return 'devcontainer: the host mount "' + expression.trim() + '" names the sandbox path "' + target
    + '", which is not an absolute path inside the sandbox; a target must start with "/" (for example'
    + ' "/mnt/x.md"), so this mount is skipped'
}

/**
 * The sentence one entry whose target IS the sandbox root is reported with.
 *
 * Mounting a host directory at `/` would put it over everything the sandbox has,
 * including the workspace, so the entry is refused rather than obeyed.
 * @param expression - the entry as the row configured it.
 * @param target - the sandbox path it named.
 * @returns the diagnostic, naming the entry and the rule it breaks.
 */
function rootTargetRejection(expression: string, target: string): string {
  return 'devcontainer: the host mount "' + expression.trim() + '" names the sandbox path "' + target
    + '", which is the sandbox root; a target must name a path inside the sandbox (for example'
    + ' "/mnt/x.md"), so this mount is skipped'
}

/**
 * Read one entry of the row's list.
 *
 * The mode token goes first because only it is at the very end. A path in neither
 * host style is kept as written: it cannot be mounted, and the diagnostic that
 * names it should show what was typed. A target that is not POSIX-absolute — a
 * second drive path, say — or that names the sandbox root makes the whole entry
 * unusable: it is reported as such rather than re-read as part of the host path,
 * which would turn a spelling mistake into a misleading "the source does not exist".
 * @param expression - one entry of the row's `hostMounts` list.
 * @returns the entry, or undefined for a blank one.
 */
function readEntry(expression: string): MountEntry | undefined {
  const text = expression.trim().replace(MODE_SUFFIX, '').trim()
  if (text === '') return undefined
  const { host: spelled, target } = splitHostTarget(text)
  const host = isWindowsPath(spelled) || isPosixAbsolute(spelled) ? normalizeHostRoot(spelled) : spelled
  if (target === undefined) return { mount: { host } }
  if (!isPosixAbsolute(target)) return { rejection: targetRejection(expression, target) }
  if (posix.normalize(toPosixSlashes(target)) === '/') return { rejection: rootTargetRejection(expression, target) }
  return { mount: { host, target } }
}

/**
 * Read one `PATH[:TARGET][:ro]` expression.
 * @param expression - one entry of the row's `hostMounts` list.
 * @returns the mount, or undefined for a blank entry or one naming an unusable target.
 */
export function parseHostMount(expression: string): HostMount | undefined {
  return readEntry(expression)?.mount
}

/**
 * The configured entries that cannot be mounted as written.
 * @param value - the row's `hostMounts` value.
 * @returns one diagnostic per entry whose target is not a sandbox path.
 */
export function hostMountRejections(value: HostMountsConfig | undefined): string[] {
  const configured = value ?? HOST_MOUNT_DEFAULTS
  if (configured === 'off' || configured === 'auto') return []
  return configured.flatMap((expression) => {
    const rejection = readEntry(expression)?.rejection
    return rejection === undefined ? [] : [rejection]
  })
}

/**
 * Expand one configured value into the mounts a created sandbox asks for.
 *
 * `auto` is the host's shared agent configuration: the `AGENTS.md` each root may
 * carry and the skill tree each may carry. `off` asks for nothing. A list is
 * taken as written, in order, with the read-only token the CLI needs added by
 * {@link hostMountArgument}. Nothing here looks at the host: whether a source
 * exists is decided in {@link hostMountSourceExists}, at the moment a sandbox is
 * created or started.
 * @param value - the row's `hostMounts` value; omitted means {@link HOST_MOUNT_DEFAULTS}.
 * @param homes - the two user roots, resolved by {@link hostMountHomes} by default.
 * @returns the declared mounts, in the order the argv carries them.
 */
export function hostMountPlan(
  value: HostMountsConfig | undefined,
  homes: HostMountHomes = hostMountHomes(),
): HostMount[] {
  const configured = value ?? HOST_MOUNT_DEFAULTS
  if (configured === 'off') return []
  if (configured === 'auto') {
    return [
      { host: joinHostRoot(homes.dshHome, 'AGENTS.md') },
      { host: joinHostRoot(homes.agentsHome, 'AGENTS.md') },
      { host: joinHostRoot(homes.dshHome, 'skills') },
      { host: joinHostRoot(homes.agentsHome, 'skills') },
    ]
  }
  return configured.flatMap((expression) => {
    const mount = readEntry(expression)?.mount
    return mount === undefined ? [] : [mount]
  })
}

/**
 * The positional argument one mount becomes.
 *
 * Always read-only: the token is what lets `sbx` mount a single file at all, and
 * a session that could write the host's skills or `AGENTS.md` would be editing
 * configuration the container is not supposed to own.
 * @param mount - the declared mount.
 * @returns `host` or `host:target`, followed by `:ro`.
 */
export function hostMountArgument(mount: HostMount): string {
  const target = mount.target === undefined ? '' : `:${mount.target}`
  return `${mount.host}${target}:ro`
}

/**
 * Whether the host path one mount names exists right now.
 *
 * `sbx` fails the whole `create` — or, once the sandbox exists, the automatic
 * start behind `exec` — when a mount source is gone, and an interactive CLI may
 * offer to create it. Neither is acceptable here: the source is the user's, so a
 * missing one is reported and the mount is dropped instead.
 * @param mount - the declared mount.
 * @returns true when the host path is present.
 */
export async function hostMountSourceExists(mount: HostMount): Promise<boolean> {
  try {
    await access(mount.host)
    return true
  } catch {
    return false
  }
}

/**
 * Normalize a configured value a settings write or a Loader row may hand over.
 *
 * The field is volatile, so what a row holds is the live reference rather than the
 * value inside it, and a write may land between two reads: it is unwrapped here,
 * at the moment of use. A value the schema never validated — an absent row, a
 * programmatic `apply` — reads as {@link HOST_MOUNT_DEFAULTS}, which is what the
 * field defaults to.
 * @param value - the configured value, in any state.
 * @returns the value as {@link HostMountsConfig}.
 */
export function hostMountsConfig(value: unknown): HostMountsConfig {
  const held: unknown = typeof (value as { get?: unknown } | undefined)?.get === 'function'
    ? (value as { get(): unknown }).get()
    : value
  if (held === 'auto' || held === 'off') return held
  if (Array.isArray(held)) {
    return held.filter((entry): entry is string => typeof entry === 'string')
  }
  return HOST_MOUNT_DEFAULTS
}
