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
 * sandboxes, `sbx create --name <name> [--template <image>] shell <path>` creates
 * one around a host directory without attaching, and `sbx run -d --name <name>`
 * starts an existing sandbox detached. `sbx exec` reports a missing sandbox with
 * exit code 125.
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
import type { ExtraMount } from './paths.ts'
import {
  hostMountArgument,
  hostMountPlan,
  hostMountSourceExists,
  splitHostTarget,
  splitMountMode,
} from './host-mounts.ts'
import type { SandboxSpecOptions } from './registry.ts'
import { sandboxTemplateOf } from './sbx-template.ts'
import type { HostMount, RepoContainerSpec } from './types.ts'

/** Prefix every sandbox this Bundle creates carries, so it is recognizable on a host. */
export const SANDBOX_NAME_PREFIX = 'dsh-'

/** The positional agent a created sandbox runs: Docker's agent-less shell agent. */
export const SANDBOX_TEMPLATE = 'shell'

/**
 * The flag that picks the IMAGE a created sandbox runs, as opposed to
 * {@link SANDBOX_TEMPLATE}, which is the agent it starts.
 */
export const SANDBOX_TEMPLATE_FLAG = '--template'

/**
 * The `--template` arguments one specification adds to `sbx create`.
 * @param spec - the sandbox specification.
 * @returns `['--template', image]`, or nothing when the row configured no image.
 * @throws Error when the configured value cannot travel as one argv token.
 */
export function sandboxTemplateArgs(spec: RepoContainerSpec): string[] {
  const image = spec.sbxTemplate === undefined ? undefined : sandboxTemplateOf(spec.sbxTemplate)
  return image === undefined ? [] : [SANDBOX_TEMPLATE_FLAG, image]
}

/**
 * The extra read-only positionals one specification asks for, as declared.
 *
 * This is the argv shape without asking the host whether the sources exist, which
 * is what a diagnostic that names the command should show; `createSandbox`
 * filters it against the host before it runs.
 * @param spec - the sandbox specification.
 * @returns one `PATH[:TARGET]:ro` argument per declared mount, in declaration order.
 */
function hostMountArgsOf(spec: RepoContainerSpec): string[] {
  return (spec.hostMounts ?? []).map(hostMountArgument)
}

/**
 * The tail of the `sbx create` argv one specification issues: the image flags,
 * the agent, the host directory to mount, and the extra read-only host paths.
 * @param spec - the sandbox specification.
 * @param extra - the extra mount arguments to append; the declared ones by default.
 * @returns the flags and positionals that follow `--name`.
 * @throws Error when the configured image cannot travel as one argv token.
 */
function createTailOf(spec: RepoContainerSpec, extra: readonly string[] = hostMountArgsOf(spec)): string[] {
  return [...sandboxTemplateArgs(spec), SANDBOX_TEMPLATE, spec.hostWorkspaceRoot, ...extra]
}

/**
 * What a missing `sbx` CLI means for the person reading the diagnostic.
 *
 * The name is deliberately long-form: `command not found: sbx` says nothing
 * about what to install, and a `(sbx)` preset otherwise looks like a broken
 * shell tool.
 */
export const SBX_INSTALL_HINT = 'Install the Docker Sandbox CLI ("sbx", shipped with Docker Desktop) so it is on PATH, '
  + 'sign in with "sbx login", or switch to a preset without the (sbx) suffix.'

/** One host path a sandbox mounts, with the path it has inside the sandbox. */
export interface SandboxMount extends ExtraMount {
  /**
   * Whether the sandbox mounted it read-only, which the listing reports as a
   * `:ro` token on the entry and not as a field. Absent means read-write, or an
   * entry whose form says nothing about it.
   */
  readonly readOnly?: boolean
}

/** One host path a sandbox takes as a workspace, as its `workspaces` list reports it. */
export interface SandboxWorkspace {
  /** The host path the sandbox mounted as a workspace, in the host's own path style. */
  readonly host: string
  /** Whether the sandbox mounted that workspace read-only. */
  readonly readOnly?: boolean
}

/** One sandbox as `sbx ls` reports it. */
export interface ListedSandbox {
  /** The sandbox name. */
  readonly name: string
  /** Whether it is running right now. */
  readonly running: boolean
  /** The mounts it reported; empty when the row carried none this module can read. */
  readonly mounts: readonly SandboxMount[]
  /**
   * The paths it was asked to mount: the workspace first, then every host path the
   * `create` named, in order. Empty when the row reported none this module can read.
   *
   * This is what tells a workspace from an extra mount: `mounts` also carries the
   * mounts `sbx` injects for itself, such as its agent skill store.
   */
  readonly workspaces: readonly SandboxWorkspace[]
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

/** The first string-valued field of a row, when it carries one. */
function firstString(row: Record<string, unknown>, names: readonly string[]): string | undefined {
  for (const name of names) {
    const value = row[name]
    if (typeof value === 'string' && value.trim() !== '') return value.trim()
  }
  return undefined
}

/**
 * Read one mount entry a listing reports.
 *
 * The mode token and the two paths are read by the same splitter the row's own
 * `hostMounts` entries go through ({@link splitMountMode} and
 * {@link splitHostTarget}), so a listing and a configuration cannot disagree about
 * what one entry means. An entry that does not split into two absolute paths is
 * dropped rather than guessed at, which leaves its sandbox on the host-path
 * fallback instead of a path that exists nowhere. The object form is accepted
 * with the field names a later listing may use, so a release that switches from
 * the `host:sandbox` string to an object does not silently report no mounts.
 * @param value - one entry of a row's `mounts` array.
 * @returns the mount, or undefined when the entry names none.
 */
function sandboxMount(value: unknown): SandboxMount | undefined {
  if (typeof value === 'string') {
    const { text, readOnly } = splitMountMode(value.trim())
    const { host: spelled, target } = splitHostTarget(text)
    const host = spelled.trim()
    const sandbox = target?.trim()
    if (sandbox === undefined) return undefined
    if (!isWindowsPath(host) && !isPosixAbsolute(host)) return undefined
    if (!isPosixAbsolute(sandbox)) return undefined
    return { host, sandbox, readOnly }
  }
  if (typeof value !== 'object' || value === null) return undefined
  const row = value as Record<string, unknown>
  const host = firstString(row, ['host', 'source', 'src', 'hostPath'])
  const sandbox = firstString(row, ['sandbox', 'destination', 'dst', 'target'])
  if (host === undefined || sandbox === undefined) return undefined
  if (!isWindowsPath(host) && !isPosixAbsolute(host)) return undefined
  if (!isPosixAbsolute(sandbox)) return undefined
  return { host, sandbox, readOnly: row['readOnly'] === true || row['read_only'] === true }
}

/**
 * Read one `workspaces` entry, which is an absolute host path that may end in `:ro`.
 * @param value - one entry of a row's `workspaces` array.
 * @returns the workspace, or undefined when the entry names no absolute host path.
 */
function sandboxWorkspace(value: unknown): SandboxWorkspace | undefined {
  if (typeof value !== 'string') return undefined
  const { text, readOnly } = splitMountMode(value.trim())
  if (!isWindowsPath(text) && !isPosixAbsolute(text)) return undefined
  return { host: text, readOnly }
}

/** The mounts one row reports, in the order it reports them. */
function mountsOf(row: Record<string, unknown>): SandboxMount[] {
  const listed = row['mounts']
  if (!Array.isArray(listed)) return []
  return listed.map(sandboxMount).filter((mount): mount is SandboxMount => mount !== undefined)
}

/** The workspaces one row reports, in the order it reports them. */
function workspacesOf(row: Record<string, unknown>): SandboxWorkspace[] {
  const listed = row['workspaces']
  if (!Array.isArray(listed)) return []
  return listed.map(sandboxWorkspace).filter((workspace): workspace is SandboxWorkspace => workspace !== undefined)
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
  const workspaces = workspacesOf(row)
  if (row['running'] === true || row['detached'] === true) return { name: name.trim(), running: true, mounts, workspaces }
  for (const field of ['status', 'state']) {
    const state = row[field]
    if (typeof state === 'string') {
      return { name: name.trim(), running: RUNNING_STATES.has(state.trim().toLowerCase()), mounts, workspaces }
    }
  }
  return { name: name.trim(), running: false, mounts, workspaces }
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
  recordListing(sandboxes)
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
 * What one sandbox's last listing reported, together with what the last
 * specification built for it declares.
 *
 * {@link sbxSpecFor} and {@link asSbxSpec} are synchronous — the preset builder,
 * the filesystem route, and the spawn-cwd mapping all build a specification on a
 * path that a listing has already answered for — so the listing leaves its mounts
 * here for them. Mounts handed to those functions explicitly always win.
 */
interface SandboxRecord {
  /** The mounts the last listing reported, which include the ones `sbx` injects itself. */
  mounts: readonly SandboxMount[]
  /** The `workspaces` the last listing reported: the workspace first, then the declared extra hosts. */
  workspaces: readonly SandboxWorkspace[]
  /** The extra host paths the last specification built for this sandbox declares. */
  declared: readonly HostMount[]
  /** The host workspace that specification mounted. */
  workspaceRoot?: string
}

/** What is known about each sandbox, for the life of the process. */
const sandboxRecords = new Map<string, SandboxRecord>()

/** The record of one sandbox, created empty when nothing is known about it yet. */
function recordOf(name: string): SandboxRecord {
  const existing = sandboxRecords.get(name)
  if (existing !== undefined) return existing
  const created: SandboxRecord = { mounts: [], workspaces: [], declared: [] }
  sandboxRecords.set(name, created)
  return created
}

/**
 * Remember one listing, so the synchronous builders below can read it.
 * @param sandboxes - the sandboxes the listing reported.
 */
function recordListing(sandboxes: readonly ListedSandbox[]): void {
  for (const sandbox of sandboxes) {
    const record = recordOf(sandbox.name)
    record.mounts = sandbox.mounts
    record.workspaces = sandbox.workspaces
  }
}

/**
 * Remember what one specification asks for, so a later attribution can name it.
 *
 * Only a specification a row BUILT carries a declared plan: one adopted from a
 * declaration has no say in what its host mounts, so it must not erase the plan
 * the row configured.
 * @param spec - the specification just built.
 */
function recordSpec(spec: RepoContainerSpec): void {
  const record = recordOf(sandboxNameOf(spec))
  record.workspaceRoot = spec.hostWorkspaceRoot
  if (spec.hostMounts !== undefined) record.declared = spec.hostMounts
}

/** The host workspace of one sandbox, as its specification or its listing names it. */
function workspaceRootOf(record: SandboxRecord): string | undefined {
  return record.workspaceRoot ?? record.workspaces[0]?.host
}

/**
 * The host paths one sandbox accepts beside its workspace.
 *
 * Only the workspace and the mounts the row itself declares are here. The rest of
 * a listing — the agent skill store `sbx` injects, for one — belongs to the
 * sandbox's own machinery, and a session must not be able to name it, so nothing
 * is admitted merely because the listing reported it.
 *
 * A listing without `workspaces` still names its workspace through the mount that
 * covers this specification's workspace root; that mount is the only one such a
 * row can be given outside the declared set.
 * @param record - what is known about the sandbox.
 * @returns the accepted mounts, the workspace first.
 */
function acceptedMounts(record: SandboxRecord): readonly SandboxMount[] {
  const accepted: SandboxMount[] = []
  const reported = record.workspaces[0]
  const root = workspaceRootOf(record) ?? reported?.host
  if (root !== undefined) {
    const sandbox = sandboxMountFor(root, record.mounts)
    if (sandbox !== undefined) {
      accepted.push({
        host: normalizeHostRoot(root),
        sandbox,
        ...reported?.readOnly === undefined ? {} : { readOnly: reported.readOnly },
      })
    }
  }
  for (const mount of declaredMounts(record.declared, record.mounts, record.mounts.length > 0)) {
    if (accepted.some(candidate => sameHost(candidate.host, mount.host))) continue
    accepted.push(mount)
  }
  return accepted
}

/**
 * Resolve declared host paths to the paths the sandbox really has for them.
 *
 * The listing is the authority: it reports where each host path was mounted, so a
 * declaration it does not mention was never mounted and is left out. A declaration
 * that names its own target needs no lookup, and the host convention answers only
 * before any listing has run — the same drive-letter rule a sandbox uses for its
 * workspace, and the only thing available at that point.
 *
 * That convention guess is a deliberate, accepted exception to "only what the
 * listing reported": the paths it admits are the row's own declarations, which are
 * exactly the ones just handed to `sbx create`, so it widens nothing a listing
 * would have named. If the sandbox mounted one of them elsewhere, a read there
 * fails with `FS_NOT_FOUND` — a missing file inside an accepted root, never a
 * fence that opens onto something else.
 * @param declared - the host paths a row asked to mount.
 * @param mounts - the mounts a listing reported.
 * @param listed - whether a listing has reported this sandbox at all.
 * @returns one read-only mount per declaration the sandbox carries.
 */
function declaredMounts(
  declared: readonly HostMount[], mounts: readonly SandboxMount[], listed: boolean,
): SandboxMount[] {
  const resolved: SandboxMount[] = []
  for (const mount of declared) {
    const host = normalizeHostRoot(mount.host)
    const reported = sandboxMountFor(host, mounts)
    const sandbox = mount.target ?? reported ?? (listed ? undefined : sandboxWorkspacePath(host))
    if (sandbox === undefined) continue
    resolved.push({ host, sandbox, readOnly: true })
  }
  return resolved
}

/** Whether two host paths name the same file or directory, folding win32 case. */
function sameHost(left: string, right: string): boolean {
  return relativeWithinHostRoot(left, right) === '' || relativeWithinHostRoot(right, left) === ''
}

/**
 * The extra read-only mounts one specification's sandbox carries.
 *
 * These are the paths a session may name beside its workspace, and nothing else a
 * listing reports: the fence, the path translation, and the helper's own guard are
 * all built from this list.
 * @param spec - the repository container specification.
 * @returns the declared mounts with their sandbox spellings; empty when none resolves.
 */
export function sbxExtraMountsOf(spec: RepoContainerSpec): readonly SandboxMount[] {
  if (spec.cli !== 'sbx') return []
  const record = sandboxRecords.get(sandboxNameOf(spec))
  const declared = spec.hostMounts ?? record?.declared ?? []
  if (declared.length === 0) return []
  const mounts = record?.mounts ?? []
  return declaredMounts(declared, mounts, mounts.length > 0)
}

/** Where a sandbox-spelled path really is, as far as the host can tell. */
export interface SandboxHostAttribution {
  /** Absolute host path the sandbox path stands for. */
  readonly host: string
  /**
   * The host workspace of the sandbox that mounts the path — present only when a
   * reported mount answered, because only a mount says which workspace a sandbox
   * has, while the host convention says just what the path is called.
   */
  readonly workspaceRoot?: string
  /**
   * The sandbox that mounts the path, present only when a reported mount answered.
   * It is the sandbox a call naming the path must run in, which is not the sandbox
   * of the host directory the path itself happens to live in — a mount of one host
   * file belongs to the workspace that mounted it, not to a sandbox named after it.
   */
  readonly sandbox?: string
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
  if (mounted !== undefined) return mounted
  const drive = driveHostFor(normalized)
  return drive === undefined ? undefined : { host: drive }
}

/**
 * The sandbox whose workspace or declared extra mount covers one HOST path.
 *
 * A session names `C:\Users\me\.dsh\AGENTS.md` the way the host spells it, while
 * the sandbox that mounted it is the one whose workspace the session runs in — not
 * a sandbox invented around that file. This answers which one it is.
 * @param hostPath - an absolute host path.
 * @returns the host path and its sandbox, or undefined when no sandbox mounts it.
 */
export function sbxMountAttribution(hostPath: string): SandboxHostAttribution | undefined {
  const normalized = normalizeHostRoot(hostPath)
  let found: { readonly length: number, readonly attribution: SandboxHostAttribution } | undefined
  for (const [name, record] of sandboxRecords) {
    for (const mount of acceptedMounts(record)) {
      const relative = relativeWithinHostRoot(normalized, mount.host)
      if (relative === undefined) continue
      if (found !== undefined && found.length >= mount.host.length) continue
      const workspaceRoot = workspaceRootOf(record)
      found = {
        length: mount.host.length,
        attribution: {
          host: relative === '' ? normalizeHostRoot(mount.host) : joinHostRoot(mount.host, relative),
          ...workspaceRoot === undefined ? {} : { workspaceRoot: normalizeHostRoot(workspaceRoot) },
          sandbox: name,
        },
      }
    }
  }
  return found?.attribution
}

/** The host directory and workspace a reported mount covers, the deepest mount winning. */
function mountedHostFor(sandboxPath: string): SandboxHostAttribution | undefined {
  let found: { readonly depth: number, readonly attribution: SandboxHostAttribution } | undefined
  for (const [name, record] of sandboxRecords) {
    const workspaceRoot = workspaceRootOf(record)
    for (const mount of acceptedMounts(record)) {
      const relative = containerRemainder(sandboxPath, mount.sandbox)
      if (relative === undefined) continue
      const depth = posix.normalize(mount.sandbox).length
      if (found !== undefined && found.depth >= depth) continue
      found = {
        depth,
        attribution: {
          host: relative === '' ? normalizeHostRoot(mount.host) : joinHostRoot(mount.host, relative),
          workspaceRoot: normalizeHostRoot(workspaceRoot ?? mount.host),
          sandbox: name,
        },
      }
    }
  }
  return found?.attribution
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
  const mounts = sandboxRecords.get(sandboxNameOf(spec))?.mounts
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
 *
 * The image a created sandbox runs is the Host row's `sbxTemplate` and nothing
 * else's: a declaration cannot choose the image of the host that mounts it. The
 * caller passes the value the Host row configures at this moment
 * (`liveSandboxTemplate`) on `options.sbxTemplate`, so a settings write is
 * answered by the next command, and it is carried on the specification so
 * `createSandbox` and the diagnostic that names the command both read the same one.
 *
 * The extra host mounts are the Host row's too, for the same reason: they are the
 * paths a sandbox mounts beside this workspace, and a declaration has no say in
 * them. The plan is carried on the specification, where the fence, the path
 * translation, and the helper's guard read it.
 * @param hostWorkspaceRoot - absolute host path of the workspace.
 * @param options - the row's container defaults, plus the image and mounts configured right now.
 * @param declared - the specification a declaration produced, when one exists.
 * @param mounts - the mounts of a fresh listing; when absent, the mounts the last one reported are used.
 * @returns the specification a `(sbx)` session runs under.
 */
export function sbxSpecFor(
  hostWorkspaceRoot: string,
  options: SandboxSpecOptions,
  declared?: RepoContainerSpec,
  mounts?: readonly SandboxMount[],
): RepoContainerSpec {
  const root = normalizeHostRoot(hostWorkspaceRoot)
  const spec = declared !== undefined && normalizeHostRoot(declared.hostWorkspaceRoot) === root
    ? asSbxSpec(declared, mounts)
    : asSbxSpec({
      hostWorkspaceRoot: root,
      containerWorkspaceFolder: sandboxWorkspacePath(root) ?? root,
      configPath: '',
      shell: options.shell,
      cli: 'sbx',
      ensureUp: options.ensureUp,
      containerTimeoutMs: options.containerTimeoutMs,
    }, mounts)
  // The image and the extra mounts are the row's, never a declaration's: a
  // repository cannot choose the sandbox image or the host configuration of the
  // host that mounts it, so the specification is rebuilt without whatever a
  // declaration carried and the live values decide alone.
  const image = options.sbxTemplate?.trim() ?? ''
  const { sbxTemplate: _declared, hostMounts: _declaredMounts, ...rest } = spec
  return {
    ...rest,
    hostMounts: hostMountPlan(options.hostMounts),
    ...image === '' ? {} : { sbxTemplate: image },
  }
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

/** Reports a mount this Bundle could not establish, where a person running the session can see it. */
export type SandboxWarning = (message: string) => void

/**
 * The declared mounts whose host source is gone.
 * @param spec - the sandbox specification.
 * @returns the declarations whose path does not exist right now.
 */
async function missingHostMounts(spec: RepoContainerSpec): Promise<HostMount[]> {
  const missing: HostMount[] = []
  for (const mount of spec.hostMounts ?? []) {
    if (!(await hostMountSourceExists(mount))) missing.push(mount)
  }
  return missing
}

/**
 * The declared mounts one existing sandbox did not take.
 *
 * The listing's `workspaces` is what answers, in order: the first entry is the
 * workspace, so a declaration missing from the rest was never mounted — it did not
 * exist when the sandbox was created. A listing that reports no `workspaces` is
 * read through its mounts, which is all an older CLI offers.
 * @param spec - the sandbox specification.
 * @param listed - the sandbox as the listing reports it.
 * @returns the declarations that sandbox does not mount.
 */
function unmountedHostMounts(spec: RepoContainerSpec, listed: ListedSandbox): HostMount[] {
  const declared = spec.hostMounts ?? []
  if (declared.length === 0) return []
  const mounted = listed.workspaces.length === 0
    ? listed.mounts.map(mount => mount.host)
    : listed.workspaces.map(workspace => workspace.host)
  return declared.filter(mount => !mounted.some(host => sameHost(host, mount.host)))
}

/** The one sentence a mount whose source is gone is reported with. */
function missingHostMountText(mount: HostMount, sandboxName: string): string {
  return 'devcontainer: the host mount source "' + mount.host + '" does not exist, so it is not mounted in sandbox "'
    + sandboxName + '"; create it, then remove the sandbox ("sbx rm ' + sandboxName + '") so it is created with that mount'
}

/** The one sentence a mount the sandbox carries whose host source vanished is reported with. */
function brokenHostMountText(mount: HostMount, sandboxName: string): string {
  return 'devcontainer: sandbox "' + sandboxName + '" mounts "' + mount.host
    + '", whose source no longer exists on the host; restore it, or remove the sandbox ("sbx rm '
    + sandboxName + '") so it is created without that mount'
}

/** The one sentence a declaration an existing sandbox never took is reported with. */
function unmountedHostMountText(mount: HostMount, sandboxName: string): string {
  return 'devcontainer: sandbox "' + sandboxName + '" does not mount "' + mount.host + '", which this row declares; '
    + 'remove the sandbox ("sbx rm ' + sandboxName + '") so it is created with that mount'
}

/** The failure of a start that cannot succeed, worded as what to do about it. */
function missingMountStartText(sandboxName: string, mounts: readonly HostMount[]): string {
  const paths = mounts.map(mount => '"' + mount.host + '"').join(', ')
  return 'sbx: Docker Sandbox "' + sandboxName + '" cannot start: the host mount source ' + paths
    + ' no longer exists. Restore it, or remove the sandbox ("sbx rm ' + sandboxName
    + '") so it is created without that mount.'
}

/**
 * Report every declared mount the host or the sandbox does not carry.
 *
 * Only a mount the sandbox actually carries can make a start fail, so that is the
 * one case reported as a state a start cannot survive. A declaration whose source
 * is gone and that the sandbox never took is the ordinary `auto` situation — the
 * host has no `~/.agents/AGENTS.md`, say — and a sandbox without that mount starts
 * exactly as it always did; it is reported, never refused.
 * @param spec - the sandbox specification.
 * @param listed - the sandbox as the listing reports it.
 * @param warn - where the reports go; nothing is reported without one.
 * @returns the declarations the sandbox mounts whose host source is gone.
 */
async function reportMountState(
  spec: RepoContainerSpec, listed: ListedSandbox, warn: SandboxWarning | undefined,
): Promise<HostMount[]> {
  const name = sandboxNameOf(spec)
  const missing = await missingHostMounts(spec)
  const unmounted = unmountedHostMounts(spec, listed)
  const broken: HostMount[] = []
  for (const mount of missing) {
    if (unmounted.some(candidate => sameHost(candidate.host, mount.host))) {
      warn?.(missingHostMountText(mount, name))
      continue
    }
    warn?.(brokenHostMountText(mount, name))
    broken.push(mount)
  }
  for (const mount of unmounted) {
    if (missing.some(candidate => sameHost(candidate.host, mount.host))) continue
    warn?.(unmountedHostMountText(mount, name))
  }
  return broken
}

/**
 * Create one sandbox around a host workspace, without attaching to it.
 *
 * The extra host mounts are appended as positional arguments, and only the ones
 * whose source exists right now: `sbx` fails the whole creation for a missing
 * source, and an interactive CLI offers to create one, which a session must never
 * do to a host path it was only given to read.
 * @param spec - the sandbox specification.
 * @param sandboxName - the name to create.
 * @param run - the CLI runner.
 * @param signal - cancellation.
 * @param warn - reports each declared mount whose source is gone.
 * @throws Error when `sbx` is missing or the creation failed.
 */
export async function createSandbox(
  spec: RepoContainerSpec,
  sandboxName: string,
  run: ContainerRun,
  signal?: AbortSignal,
  warn?: SandboxWarning,
): Promise<void> {
  recordSpec(spec)
  const extra: string[] = []
  for (const mount of spec.hostMounts ?? []) {
    if (await hostMountSourceExists(mount)) extra.push(hostMountArgument(mount))
    else warn?.(missingHostMountText(mount, sandboxName))
  }
  const result = await run(
    // The documented core form: an optional image, then the agent (an agent-less
    // shell), then the host directory to mount, then any further read-only host
    // paths. Progress output goes to the captured stream and is not shown, so no
    // suppression flag is needed — and no flag this CLI may not have.
    ['sbx', 'create', '--name', sandboxName, ...createTailOf(spec, extra)],
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
 *
 * The extra host mounts are the one thing a sandbox cannot gain after it exists,
 * so this is also where their state is reported: a missing source is a diagnostic
 * (and, for a sandbox that has to start, a refusal worded as what to do), and a
 * declaration the sandbox never took is the same `sbx rm` advice. Nothing here
 * removes or recreates a sandbox — that is the user's call.
 * @param spec - the sandbox specification.
 * @param run - the CLI runner.
 * @param signal - cancellation of the probe / start sequence.
 * @param warn - reports a mount the sandbox does not carry, and a source that is gone.
 * @returns the sandbox target.
 * @throws Error when `sbx` is missing, the sandbox cannot be prepared, one is required and absent, it has no Node.js, or a start would fail on a mount the sandbox carries whose source is gone.
 */
export async function resolveSbxTarget(
  spec: RepoContainerSpec,
  run: ContainerRun,
  signal?: AbortSignal,
  warn?: SandboxWarning,
): Promise<ContainerTarget> {
  const name = sandboxNameOf(spec)
  recordSpec(spec)
  const listing = await listSandboxes(run, spec.containerTimeoutMs, signal)
  if (!listing.available) throw new Error(`sbx: ${SBX_INSTALL_HINT}`)
  const listed = listing.sandboxes.find(sandbox => sandbox.name === name)
  // The mounts this row reports decide where the workspace really is inside the
  // sandbox; a row that mounts nothing of this workspace, or no row at all, keeps
  // the specification's own folder.
  const target = sbxTargetOf(spec, listed?.mounts ?? [])
  if (listed?.running === true) {
    // A running sandbox keeps reading its mounts, so a source that is gone is
    // reported rather than refused: only the next start needs it.
    await reportMountState(spec, listed, warn)
    await assertSandboxNode(spec, name, run, signal)
    return target
  }
  if (!spec.ensureUp) {
    throw new Error(listed === undefined
      ? `sbx: no Docker Sandbox named "${name}" exists for "${spec.hostWorkspaceRoot}"; create it with "sbx create --name ${name} ${createTailOf(spec).join(' ')}", or set ensureUp: true`
      : `sbx: Docker Sandbox "${name}" for "${spec.hostWorkspaceRoot}" is not running; start it with "sbx run --detach --name ${name}", or set ensureUp: true`)
  }
  if (listed === undefined) {
    await createSandbox(spec, name, run, signal, warn)
    await startSandbox(spec, name, run, signal)
    await assertSandboxNode(spec, name, run, signal)
    // A sandbox that has just been created carries its extra mounts now, and only a
    // fresh listing says where `sbx` put them: the fence and the path translation
    // are built from what is recorded here. A create that asked for none has
    // nothing to learn, so it costs no second listing.
    if ((spec.hostMounts ?? []).length === 0) return target
    const refreshed = await listSandboxes(run, spec.containerTimeoutMs, signal)
    return sbxTargetOf(spec, refreshed.sandboxes.find(sandbox => sandbox.name === name)?.mounts ?? [])
  }
  const missing = await reportMountState(spec, listed, warn)
  if (missing.length > 0) throw new Error(missingMountStartText(name, missing))
  await startSandbox(spec, name, run, signal)
  await assertSandboxNode(spec, name, run, signal)
  return target
}
