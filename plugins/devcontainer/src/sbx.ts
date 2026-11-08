/**
 * Docker Sandbox (`sbx`) target discovery.
 *
 * A sandbox is not a Dev Container: a `(sbx)` preset needs no
 * `.devcontainer/devcontainer.json` at all. This module therefore answers two
 * questions the Dev Container driver answers from a declaration: which sandbox
 * belongs to a host directory (a naming convention makes it deterministic), and
 * where commands run inside it (the sandbox's own mount of that directory).
 *
 * That second answer is not the host spelling. A Linux or macOS sandbox mounts a
 * workspace at the same absolute path it has on the host, while a Windows host's
 * MicroVM maps `F:\personal\repo` to `/f/personal/repo`. `sbx ls --json` reports
 * the mounts, so the listing decides the folder; a sandbox whose mounts say
 * nothing about the workspace keeps the host path as its fallback.
 *
 * The CLI surface used here is the documented one: `sbx ls --json` lists
 * sandboxes, `sbx create --name <name> shell <path>` creates one around a host
 * directory without attaching, and `sbx run -d --name <name>` starts an existing
 * sandbox detached. `sbx exec` reports a missing sandbox with exit code 125.
 * @module @banzhe/dsh-devcontainer/sbx
 */

import { createHash } from 'node:crypto'
import { posix, win32 } from 'node:path'
import type { ContainerTarget } from './container.ts'
import type { ContainerRun } from './exec.ts'
import {
  containerRemainder,
  hostPathStyle,
  isPosixAbsolute,
  isWindowsPath,
  joinHostRoot,
  normalizeHostRoot,
  relativeWithinHostRoot,
  toPosixSlashes,
} from './paths.ts'
import type { ContainerOptions, RepoContainerSpec } from './types.ts'

/** Prefix every sandbox this Bundle creates carries, so it is recognizable on a host. */
export const SANDBOX_NAME_PREFIX = 'dsh-'

/** The template a created sandbox runs: Docker's agent-less shell template. */
export const SANDBOX_TEMPLATE = 'shell'

/**
 * What a missing `sbx` CLI means for the person reading the diagnostic.
 *
 * The name is deliberately long-form: `command not found: sbx` says nothing
 * about what to install, and a `(sbx)` preset otherwise looks like a broken
 * shell tool.
 */
export const SBX_INSTALL_HINT = 'Install the Docker Sandbox CLI ("sbx", shipped with Docker Desktop) so it is on PATH, '
  + 'sign in with "sbx login", or switch to a preset without the (sbx) suffix.'

/** One host directory a sandbox mounts, with the path it has inside the sandbox. */
export interface SandboxMount {
  /** The host directory the mount originates from, in the host's own path style. */
  readonly host: string
  /** Absolute POSIX path the same directory has inside the sandbox. */
  readonly sandbox: string
}

/** One sandbox as `sbx ls` reports it. */
export interface ListedSandbox {
  /** The sandbox name. */
  readonly name: string
  /** Whether it is running right now. */
  readonly running: boolean
  /** The mounts it reported; empty when the row carried none this module can read. */
  readonly mounts: readonly SandboxMount[]
}

/**
 * The deterministic sandbox name of one host workspace.
 *
 * `dsh-<repo>-<hash>`: the readable part so a person recognizes the project in
 * `sbx ls`, the digest so two repositories with the same directory name never
 * share a sandbox. The digest folds case only for a Windows-rooted path, because
 * that host reports one directory with either spelling; a case-sensitive host
 * keeps the spelling it was given, where `Repo` and `repo` are two directories
 * that must not share a sandbox.
 * @param hostWorkspaceRoot - absolute host path of the workspace.
 * @returns the sandbox name.
 */
export function sandboxNameFor(hostWorkspaceRoot: string): string {
  const root = normalizeHostRoot(hostWorkspaceRoot)
  const windows = hostPathStyle(root) === 'win32'
  const base = windows ? win32.basename(root) : posix.basename(root)
  const slug = (base === '' ? 'workspace' : base)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  const spelled = root.replaceAll('\\', '/')
  const digest = createHash('sha256')
    .update(windows ? spelled.toLowerCase() : spelled)
    .digest('hex')
    .slice(0, 8)
  return `${SANDBOX_NAME_PREFIX}${slug === '' ? 'workspace' : slug}-${digest}`
}

/** The state names a listed sandbox may report while it is running. */
const RUNNING_STATES: ReadonlySet<string> = new Set(['running', 'ready', 'up', 'started'])

/**
 * Read one mount entry a listing reports.
 *
 * The separator is the LAST `:/` of the entry: a Windows host directory carries a
 * drive colon of its own, while the sandbox side of a mount is always
 * POSIX-absolute. An entry that does not split into two absolute paths is
 * dropped rather than guessed at, which leaves its sandbox on the host-path
 * fallback instead of a path that exists nowhere.
 * @param value - one entry of a row's `mounts` array.
 * @returns the mount, or undefined when the entry names none.
 */
function sandboxMount(value: unknown): SandboxMount | undefined {
  if (typeof value !== 'string') return undefined
  const separator = value.lastIndexOf(':/')
  if (separator <= 0) return undefined
  const host = value.slice(0, separator).trim()
  const sandbox = value.slice(separator + 1).trim()
  if (!isWindowsPath(host) && !isPosixAbsolute(host)) return undefined
  if (!isPosixAbsolute(sandbox)) return undefined
  return { host, sandbox }
}

/** The mounts one row reports, in the order it reports them. */
function mountsOf(row: Record<string, unknown>): SandboxMount[] {
  const listed = row['mounts']
  if (!Array.isArray(listed)) return []
  return listed.map(sandboxMount).filter((mount): mount is SandboxMount => mount !== undefined)
}

/**
 * Read one listed sandbox, tolerating the field names the CLI has used across
 * releases (snake_case JSON, a `detached` flag, or a plain `running` boolean).
 *
 * A row that says nothing about its state is reported as NOT running: starting an
 * existing sandbox again is harmless, while treating a stopped sandbox as running
 * would make every later `sbx exec` fail with exit code 125 and never recover.
 * @param value - one row of the listing.
 * @returns the sandbox, or undefined when the row names none.
 */
function listedSandbox(value: unknown): ListedSandbox | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const row = value as Record<string, unknown>
  const name = row['name']
  if (typeof name !== 'string' || name.trim() === '') return undefined
  const mounts = mountsOf(row)
  if (row['running'] === true || row['detached'] === true) return { name: name.trim(), running: true, mounts }
  for (const field of ['status', 'state']) {
    const state = row[field]
    if (typeof state === 'string') {
      return { name: name.trim(), running: RUNNING_STATES.has(state.trim().toLowerCase()), mounts }
    }
  }
  return { name: name.trim(), running: false, mounts }
}

/**
 * Parse `sbx ls --json`.
 *
 * Both the current array form and the older `{ "sandboxes": [...] }` envelope are
 * accepted, and anything unparsable yields no sandboxes rather than throwing: a
 * listing this module cannot read must fall through to "create or start it", not
 * fail the command.
 * @param stdout - the CLI's standard output.
 * @returns the listed sandboxes.
 */
export function parseSandboxList(stdout: string): ListedSandbox[] {
  const text = stdout.trim()
  if (text === '') return []
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return []
  }
  const rows = Array.isArray(parsed)
    ? parsed
    : typeof parsed === 'object' && parsed !== null && Array.isArray((parsed as { sandboxes?: unknown }).sandboxes)
      ? (parsed as { sandboxes: unknown[] }).sandboxes
      : []
  return rows.map(listedSandbox).filter((row): row is ListedSandbox => row !== undefined)
}

/** One listing attempt: whether the CLI answered at all, and what it listed. */
export interface SandboxListing {
  /** False when the CLI is missing (exit code `null`), which no retry can fix. */
  readonly available: boolean
  /** The sandboxes it reported; empty when the listing failed. */
  readonly sandboxes: readonly ListedSandbox[]
}

/**
 * Ask the CLI which sandboxes exist.
 *
 * The mounts of a successful listing are remembered, because the specification
 * builders below are synchronous and have no CLI in reach.
 * @param run - the CLI runner.
 * @param timeoutMs - budget for the call.
 * @param signal - cancellation.
 * @returns the listing, with `available: false` when `sbx` could not be started.
 */
export async function listSandboxes(
  run: ContainerRun,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<SandboxListing> {
  const result = await run(
    ['sbx', 'ls', '--json'],
    { ...signal === undefined ? {} : { signal }, timeoutMs },
  )
  if (result.exitCode === null) return { available: false, sandboxes: [] }
  if (result.exitCode !== 0) return { available: true, sandboxes: [] }
  const sandboxes = parseSandboxList(result.stdout)
  recordMounts(sandboxes)
  return { available: true, sandboxes }
}

/** Whether this host spells directories the Windows way. */
const WINDOWS_HOST = process.platform === 'win32'

/**
 * The host directory a `(sbx)` session mounts.
 *
 * A declaration wins, because the sandbox mounts the repository the declaration
 * was found in. Without one, the row's configured cwd is the workspace — that is
 * the directory the session was started in, and the only one a sandbox may
 * claim. The path a call names is the last resort, and only when it is an
 * absolute HOST path: a POSIX-absolute path is a host path on a POSIX host only,
 * since on Windows `/workspaces/<repo>` is the Dev Container spelling.
 * @param workdir - the directory the call named.
 * @param cwd - the directory the row was configured with.
 * @param declared - the specification a declaration produced, when one exists.
 * @returns the absolute host path to mount, or undefined when none can be named.
 */
export function sbxWorkspaceRootFor(
  workdir: string,
  cwd: string | undefined,
  declared?: RepoContainerSpec,
): string | undefined {
  if (declared !== undefined) return declared.hostWorkspaceRoot
  if (cwd !== undefined && cwd !== '') return cwd
  if (isWindowsPath(workdir) || (!WINDOWS_HOST && isPosixAbsolute(workdir))) return workdir
  return undefined
}

/**
 * The path a sandbox has for one host workspace, from the host convention alone.
 *
 * A sandbox is a Linux machine, so it cannot mount a Windows drive path: its
 * MicroVM maps the directory without the drive colon, which turns
 * `F:\personal\asmr-manager` into `/f/personal/asmr-manager`. A Linux or macOS
 * sandbox mounts a directory at the absolute path it already has.
 *
 * This answers the attribution question a call must settle before the listing
 * has run or when the listing reported no mounts; mounts a listing did report
 * always win over it.
 * @param hostWorkspaceRoot - absolute host path of the workspace.
 * @returns the absolute POSIX path the sandbox has for it, or undefined for a UNC path no convention maps.
 */
export function sandboxWorkspacePath(hostWorkspaceRoot: string): string | undefined {
  const root = normalizeHostRoot(hostWorkspaceRoot)
  if (hostPathStyle(root) !== 'win32') return toPosixSlashes(root)
  // A UNC share has no drive letter a sandbox could reproduce.
  if (root.startsWith('\\\\')) return undefined
  const slashed = toPosixSlashes(root)
  // `posix.normalize` keeps the trailing slash of a drive root, which no mount
  // point carries.
  return posix.normalize(`/${slashed.slice(0, 1).toLowerCase()}${slashed.slice(2)}`).replace(/\/+$/, '') || '/'
}

/**
 * The path one host workspace has inside a sandbox, from the mounts it reported.
 *
 * The deepest mount containing the workspace wins, so a sandbox created around a
 * parent directory still maps the repository inside it. A host whose sandbox
 * mounts directories at their own absolute path — Linux and macOS both do —
 * yields that same path, which is the fallback anyway.
 * @param hostWorkspaceRoot - absolute host path of the workspace.
 * @param mounts - the mounts a listing reported.
 * @returns the absolute POSIX sandbox path, or undefined when no mount covers the workspace.
 */
export function sandboxMountFor(
  hostWorkspaceRoot: string,
  mounts: readonly SandboxMount[],
): string | undefined {
  const root = normalizeHostRoot(hostWorkspaceRoot)
  let found: { readonly hostLength: number, readonly path: string } | undefined
  for (const mount of mounts) {
    if (!isPosixAbsolute(mount.sandbox)) continue
    const relative = relativeWithinHostRoot(root, mount.host)
    if (relative === undefined) continue
    if (found !== undefined && found.hostLength >= mount.host.length) continue
    const base = posix.normalize(mount.sandbox)
    found = { hostLength: mount.host.length, path: relative === '' ? base : posix.join(base, relative) }
  }
  return found?.path
}

/**
 * The mounts the last listing reported, per sandbox name.
 *
 * {@link sbxSpecFor} and {@link asSbxSpec} are synchronous — the preset builder,
 * the filesystem route, and the spawn-cwd mapping all build a specification on a
 * path that a listing has already answered for — so the listing leaves its mounts
 * here for them. Mounts handed to those functions explicitly always win.
 */
const reportedMounts = new Map<string, readonly SandboxMount[]>()

/**
 * Remember one listing's mounts.
 * @param sandboxes - the sandboxes the listing reported.
 */
function recordMounts(sandboxes: readonly ListedSandbox[]): void {
  for (const sandbox of sandboxes) reportedMounts.set(sandbox.name, sandbox.mounts)
}

/** Where a sandbox-spelled path really is, as far as the host can tell. */
export interface SandboxHostAttribution {
  /** Absolute host path the sandbox path stands for. */
  readonly host: string
  /**
   * The host directory the sandbox mounts that path from — present only when a
   * listing reported the mount, because only a mount says which directory a
   * sandbox has, while the host convention says just what the path is called.
   */
  readonly workspaceRoot?: string
}

/**
 * The host directory a path inside a sandbox names.
 *
 * This is the inverse of {@link sandboxWorkspacePath} and {@link sandboxMountFor},
 * and a `(sbx)` session's filesystem calls need it: the paths such a session names
 * exist only inside its sandbox, so walking their ancestors on the host finds no
 * repository — on a Windows host `/f/personal/repo` is `F:\personal\repo`, one
 * namespace away from the directory that declares the container.
 *
 * A mount the last listing reported is direct evidence and wins, deepest first, so
 * a sandbox that mounts its workspace somewhere of its own is attributed correctly
 * — and only a mount says which host directory the sandbox has, which is the
 * workspace root a caller needs. Without one, only the host convention can answer:
 * a Windows host maps `F:\personal\repo` to `/f/personal/repo`, so a path whose
 * first segment is a single letter spells a drive. Anything else —
 * `/workspaces/repo`, `/etc` — names no host directory, and the caller keeps
 * whatever it had.
 * @param sandboxPath - absolute POSIX path inside a sandbox.
 * @returns the host path it stands for, or undefined when nothing attributes it.
 */
export function sandboxHostPathFor(sandboxPath: string): SandboxHostAttribution | undefined {
  const normalized = posix.normalize(toPosixSlashes(sandboxPath))
  if (!isPosixAbsolute(normalized)) return undefined
  const mounted = mountedHostFor(normalized)
  if (mounted !== undefined) {
    return { host: mounted.host, workspaceRoot: normalizeHostRoot(mounted.root) }
  }
  const drive = driveHostFor(normalized)
  return drive === undefined ? undefined : { host: drive }
}

/** The host directory and workspace a reported mount covers, the deepest mount winning. */
function mountedHostFor(sandboxPath: string): { readonly host: string, readonly root: string } | undefined {
  let found: { readonly depth: number, readonly host: string, readonly root: string } | undefined
  for (const mounts of reportedMounts.values()) {
    for (const mount of mounts) {
      const relative = containerRemainder(sandboxPath, mount.sandbox)
      if (relative === undefined) continue
      const depth = posix.normalize(mount.sandbox).length
      if (found !== undefined && found.depth >= depth) continue
      found = {
        depth,
        root: mount.host,
        host: relative === '' ? normalizeHostRoot(mount.host) : joinHostRoot(mount.host, relative),
      }
    }
  }
  return found === undefined ? undefined : { host: found.host, root: found.root }
}

/** The drive-letter directory a sandbox path spells on a Windows host, when its first segment is a letter. */
function driveHostFor(sandboxPath: string): string | undefined {
  const match = /^\/([A-Za-z])(?:\/|$)/.exec(sandboxPath)
  if (match === null) return undefined
  const drive = (match[1] ?? '').toUpperCase()
  const rest = sandboxPath.slice(2).replaceAll('/', '\\')
  return rest === '' ? `${drive}:\\` : win32.resolve(`${drive}:${rest}`)
}

/**
 * The sandbox one specification runs in.
 * @param spec - the repository container specification.
 * @returns the declared sandbox name, or the deterministic name of the host root.
 */
function sandboxNameOf(spec: RepoContainerSpec): string {
  return spec.sandbox ?? sandboxNameFor(spec.hostWorkspaceRoot)
}

/**
 * The path a specification's workspace has inside its sandbox, as last listed.
 * @param spec - the repository container specification.
 * @returns the absolute sandbox path, or undefined when no listing covered the workspace.
 */
export function sbxMountOf(spec: RepoContainerSpec): string | undefined {
  const mounts = reportedMounts.get(sandboxNameOf(spec))
  return mounts === undefined ? undefined : sandboxMountFor(spec.hostWorkspaceRoot, mounts)
}

/**
 * The target one specification's sandbox becomes.
 * @param spec - the repository container specification.
 * @param mounts - the mounts of a fresh listing; when absent, the mounts the last one reported are used.
 * @returns the sandbox target, with the folder the sandbox really has for this workspace.
 */
export function sbxTargetOf(spec: RepoContainerSpec, mounts?: readonly SandboxMount[]): ContainerTarget {
  const mounted = mounts === undefined
    ? sbxMountOf(spec)
    : sandboxMountFor(spec.hostWorkspaceRoot, mounts)
  return {
    kind: 'sbx',
    sandboxName: sandboxNameOf(spec),
    workspaceFolder: mounted ?? spec.containerWorkspaceFolder,
  }
}

/**
 * The sandbox view of a declared repository.
 *
 * A Dev Container declaration's `/workspaces/<repo>` describes a directory a
 * sandbox may not have, so the mount takes its place: the folder a listing
 * reported for this workspace, else {@link sandboxWorkspacePath} — the same path
 * on a Linux or macOS host, and the drive-letter spelling (`/f/…` for `F:\…`) on
 * a Windows one. The one exception is a declaration that names `cli: "sbx"`
 * itself — that repository opted into the sandbox driver, so its own
 * `workspaceFolder` is the fallback when no mount was reported.
 * @param spec - the declared specification.
 * @param mounts - the mounts of a fresh listing; when absent, the mounts the last one reported are used.
 * @returns the same repository, reachable through `sbx`.
 */
export function asSbxSpec(spec: RepoContainerSpec, mounts?: readonly SandboxMount[]): RepoContainerSpec {
  const root = normalizeHostRoot(spec.hostWorkspaceRoot)
  const declared = spec.cli === 'sbx' ? spec.containerWorkspaceFolder : sandboxWorkspacePath(root) ?? root
  const mounted = mounts === undefined ? sbxMountOf(spec) : sandboxMountFor(root, mounts)
  return { ...spec, hostWorkspaceRoot: root, containerWorkspaceFolder: mounted ?? declared, cli: 'sbx' }
}

/**
 * The sandbox specification of one host directory, declared or not.
 * @param hostWorkspaceRoot - absolute host path of the workspace.
 * @param options - the row's container defaults.
 * @param declared - the specification a declaration produced, when one exists.
 * @param mounts - the mounts of a fresh listing; when absent, the mounts the last one reported are used.
 * @returns the specification a `(sbx)` session runs under.
 */
export function sbxSpecFor(
  hostWorkspaceRoot: string,
  options: ContainerOptions,
  declared?: RepoContainerSpec,
  mounts?: readonly SandboxMount[],
): RepoContainerSpec {
  const root = normalizeHostRoot(hostWorkspaceRoot)
  if (declared !== undefined && normalizeHostRoot(declared.hostWorkspaceRoot) === root) {
    return asSbxSpec(declared, mounts)
  }
  return asSbxSpec({
    hostWorkspaceRoot: root,
    containerWorkspaceFolder: sandboxWorkspacePath(root) ?? root,
    configPath: '',
    shell: options.shell,
    cli: 'sbx',
    ensureUp: options.ensureUp,
    containerTimeoutMs: options.containerTimeoutMs,
  }, mounts)
}

/**
 * Align a specification with the mount its resolved target reports.
 *
 * A specification is built on a path alone, while the folder a sandbox really has
 * arrives with the listing the resolver performs. Only a sandbox target carries a
 * different folder; a container the Dev Container CLI declared keeps its own.
 * @param spec - the specification the caller built.
 * @param target - the resolved target.
 * @returns the specification whose mount point is the target's folder.
 */
export function bindSbxMount(spec: RepoContainerSpec, target: ContainerTarget): RepoContainerSpec {
  return target.kind === 'sbx' && target.workspaceFolder !== spec.containerWorkspaceFolder
    ? { ...spec, containerWorkspaceFolder: target.workspaceFolder }
    : spec
}

/** The last lines of a CLI failure, for a diagnostic that fits in one sentence. */
function failureDetail(result: { stdout: string; stderr: string }): string {
  return (result.stderr.trim() || result.stdout.trim() || 'no output').split('\n').slice(-3).join(' ')
}

/**
 * Create one sandbox around a host workspace, without attaching to it.
 * @param spec - the sandbox specification.
 * @param sandboxName - the name to create.
 * @param run - the CLI runner.
 * @param signal - cancellation.
 * @throws Error when `sbx` is missing or the creation failed.
 */
export async function createSandbox(
  spec: RepoContainerSpec,
  sandboxName: string,
  run: ContainerRun,
  signal?: AbortSignal,
): Promise<void> {
  const result = await run(
    // The documented core form: the template (an agent-less shell) then the host
    // directory to mount. Progress output goes to the captured stream and is not
    // shown, so no suppression flag is needed — and no flag this CLI may not have.
    ['sbx', 'create', '--name', sandboxName, SANDBOX_TEMPLATE, spec.hostWorkspaceRoot],
    { ...signal === undefined ? {} : { signal }, timeoutMs: spec.containerTimeoutMs },
  )
  if (result.exitCode === null) throw new Error(`sbx: the CLI could not be started. ${SBX_INSTALL_HINT}`)
  if (result.exitCode !== 0) {
    throw new Error(`sbx: "sbx create" failed for ${spec.hostWorkspaceRoot} (sandbox "${sandboxName}"): ${failureDetail(result)}`)
  }
}

/**
 * Start one existing sandbox detached, so it survives the command that needed it.
 * @param spec - the sandbox specification.
 * @param sandboxName - the sandbox to start.
 * @param run - the CLI runner.
 * @param signal - cancellation.
 * @throws Error when `sbx` is missing or the start failed.
 */
export async function startSandbox(
  spec: RepoContainerSpec,
  sandboxName: string,
  run: ContainerRun,
  signal?: AbortSignal,
): Promise<void> {
  const result = await run(
    ['sbx', 'run', '--detach', '--name', sandboxName],
    { ...signal === undefined ? {} : { signal }, timeoutMs: spec.containerTimeoutMs },
  )
  if (result.exitCode === null) throw new Error(`sbx: the CLI could not be started. ${SBX_INSTALL_HINT}`)
  if (result.exitCode !== 0) {
    throw new Error(`sbx: "sbx run" could not start sandbox "${sandboxName}": ${failureDetail(result)}`)
  }
}

/**
 * Confirm the sandbox can run the filesystem helper.
 *
 * The helper is a `.mjs` program the sandbox starts with its own `node`, so a
 * sandbox image without one answers that exec with prose on the helper's pipe
 * instead of frames. Probing first turns that into a diagnostic that names the
 * missing runtime and the sandbox that lacks it.
 * @param spec - the sandbox specification, for its time budget.
 * @param sandboxName - the running sandbox to probe.
 * @param run - the CLI runner.
 * @param signal - cancellation.
 * @throws Error when the sandbox has no `node` on PATH.
 */
export async function assertSandboxNode(
  spec: RepoContainerSpec,
  sandboxName: string,
  run: ContainerRun,
  signal?: AbortSignal,
): Promise<void> {
  const result = await run(
    ['sbx', 'exec', sandboxName, '--', 'which', 'node'],
    { ...signal === undefined ? {} : { signal }, timeoutMs: spec.containerTimeoutMs },
  )
  if (result.exitCode === 0 && result.stdout.trim() !== '') return
  throw new Error(
    `sbx: Docker Sandbox "${sandboxName}" does not have Node.js installed, so the filesystem bridge and the tools `
    + 'that use it cannot run there. Install Node.js 18 or newer inside the sandbox (for example '
    + `"sbx exec ${sandboxName} -- sudo apt-get install -y nodejs", or an official tarball from nodejs.org `
    + 'unpacked into /usr/local), then retry. '
    + `The probe "sbx exec ${sandboxName} -- which node" reported: ${failureDetail(result)}`,
  )
}

/**
 * Resolve the sandbox agent commands run in, creating or starting it when asked.
 *
 * A sandbox that `sbx ls` lists as running is used as it is. Otherwise, and only
 * with `ensureUp`, a missing sandbox is created around the host workspace and an
 * existing one is started detached. Without `ensureUp` the resolver reports the
 * state instead of changing it.
 *
 * Either way the sandbox is probed for `node` before it is returned: without one
 * it cannot start the filesystem helper, and reporting the missing runtime here
 * is more useful than the broken pipe it would otherwise cause.
 *
 * The listing also names the mounts, so the returned target carries the folder
 * the sandbox really has for this workspace instead of the host spelling.
 * @param spec - the sandbox specification.
 * @param run - the CLI runner.
 * @param signal - cancellation of the probe / start sequence.
 * @returns the sandbox target.
 * @throws Error when `sbx` is missing, the sandbox cannot be prepared, one is required and absent, or it has no Node.js.
 */
export async function resolveSbxTarget(
  spec: RepoContainerSpec,
  run: ContainerRun,
  signal?: AbortSignal,
): Promise<ContainerTarget> {
  const name = sandboxNameOf(spec)
  const listing = await listSandboxes(run, spec.containerTimeoutMs, signal)
  if (!listing.available) throw new Error(`sbx: ${SBX_INSTALL_HINT}`)
  const listed = listing.sandboxes.find(sandbox => sandbox.name === name)
  // The mounts this row reports decide where the workspace really is inside the
  // sandbox; a row that mounts nothing of this workspace, or no row at all, keeps
  // the specification's own folder.
  const target = sbxTargetOf(spec, listed?.mounts ?? [])
  if (listed?.running === true) {
    await assertSandboxNode(spec, name, run, signal)
    return target
  }
  if (!spec.ensureUp) {
    throw new Error(listed === undefined
      ? `sbx: no Docker Sandbox named "${name}" exists for "${spec.hostWorkspaceRoot}"; create it with "sbx create --name ${name} ${SANDBOX_TEMPLATE} ${spec.hostWorkspaceRoot}", or set ensureUp: true`
      : `sbx: Docker Sandbox "${name}" for "${spec.hostWorkspaceRoot}" is not running; start it with "sbx run --detach --name ${name}", or set ensureUp: true`)
  }
  if (listed === undefined) await createSandbox(spec, name, run, signal)
  await startSandbox(spec, name, run, signal)
  await assertSandboxNode(spec, name, run, signal)
  return target
}
