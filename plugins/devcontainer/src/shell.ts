/**
 * Report a container-bound result as what it is: the host process was not
 * confined, because the container confines the command instead. Permission
 * bookkeeping therefore never attributes a host-sandbox denial to it.
 * @param execution - the handle returned for a `docker exec` run.
 * @returns the same handle, with its settled result stamped unconfined.
 */
function stampUnconfined(execution: ShellExecution): ShellExecution {
  const base = execution.result.bind(execution)
  let stamped: Promise<ShellRunResult> | undefined
  execution.result = () => {
    stamped ??= base().then(result => ({ ...result, sandbox: { mode: 'danger-full-access' as const, denied: false } }))
    return stamped
  }
  return execution
}

/**
 * `ctx.shell` for repositories that declare a Dev Container, or run in a Docker
 * Sandbox.
 *
 * The executor IS the sandboxed local bash executor — same deadlines, same
 * output caps, same job/background semantics, same host-side confinement — with
 * two changes at the execution boundary:
 *
 * - {@link DevcontainerShellExecutor.resolve} reports the workdir as the
 *   container's POSIX path, so `result.cwd` and every subsequent `workdir` the
 *   model writes are Linux paths;
 * - {@link DevcontainerShellExecutor.execute} runs `docker exec` (or
 *   `devcontainer exec`) instead of an in-process `bash -c`, from the HOST
 *   repository root: `child_process` cannot chdir into `/workspaces/…`, which
 *   does not exist on Windows.
 *
 * Everything outside a Dev Container repository keeps the LOCAL provider this
 * platform had before this Bundle existed — bash on POSIX, PowerShell on Windows
 * (`packages/shell/pwsh-local`). That is not cosmetic: on Windows the shipped
 * presets mount `tool-pwsh`, whose commands are PowerShell source, and a Windows
 * `bash` reading them would fail where it used to work.
 *
 * @module @banzhe/dsh-devcontainer/shell
 */

import { Context, type Volatile } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { SandboxBashExecutor } from '@deepseek-ai/dsh-bash-sandbox'
import type { Config as LocalBashConfig } from '@deepseek-ai/dsh-bash-local'
import { ENCODING_PREAMBLE, resolvePwshPath } from '@deepseek-ai/dsh-pwsh-local'
import type { ShellExecRequest, ShellExecSpec, ShellExecution } from '@deepseek-ai/dsh-shell'
import { buildExecArgv, containerEnv } from './argv.ts'
import { resolveContainerTarget } from './container.ts'
import type { ContainerTarget } from './container.ts'
import { runContainerCommand } from './exec.ts'
import type { ContainerRun } from './exec.ts'
import { containerOptionFields, containerOptions } from './options.ts'
import { toContainerPath } from './paths.ts'
import {
  markedContainerOnly, markedPreset, markedVariantKind, refusalText, refusedExecution, sbxRefusalText,
} from './refusal.ts'
import type { ShellRunResult } from '@deepseek-ai/dsh-shell'
import { liveHostMountRejections, liveSbxOptions, repoRegistry, warnOnce } from './registry.ts'
import { bindSbxMount, sandboxHostPathFor, sbxSpecFor, sbxWorkspaceRootFor } from './sbx.ts'
import type { SandboxHostAttribution } from './sbx.ts'
import type { ContainerOptions, RepoContainerSpec } from './types.ts'
import type { VariantKind } from './ids.ts'

/** Plugin name used by the Loader row. */
export const name = 'devcontainer-shell'

/** The seams this executor spawns and confines through. */
export const inject = ['subprocess', 'sandbox', 'sandboxPolicy']

/** The local shell used when a workdir belongs to no Dev Container repository. */
export type LocalShell = 'auto' | 'bash' | 'powershell'

/**
 * Whether one container run failed because the container or sandbox is gone.
 *
 * A target is cached per repository, so a container that was restarted or
 * recreated shows up as these errors on the next command; the cache entry is
 * dropped so the following command re-probes instead of failing forever. The
 * sandbox half covers `sbx`: it reports a missing sandbox on stderr AND with
 * exit code 125, which is Docker's generic "could not run the command" status.
 * @param result - the settled foreground result.
 * @returns true when the failure is about the runtime itself.
 */
function containerGone(result: ShellRunResult): boolean {
  if (result.exitCode === 0) return false
  if (result.exitCode === 125) return true
  return /no such container|is not running|cannot connect to the docker daemon|container .* is not running/i.test(result.stderr.text)
    || /no such sandbox|sandbox .* (?:not found|does not exist|is not running|is stopped|has stopped)/i.test(result.stderr.text)
}

/**
 * The host directory a sandbox-spelled workdir names.
 *
 * Only a Windows host maps a drive directory into its sandbox without the drive
 * colon, so only there does a container path need reversing: everywhere else a
 * sandbox mounts the directory at the absolute path it already has, which is the
 * workdir a caller wrote.
 * @param workdir - the directory the command named.
 * @returns the attribution, or undefined when the path names no host directory.
 */
function sandboxHostAttribution(workdir: string): SandboxHostAttribution | undefined {
  return process.platform === 'win32' ? sandboxHostPathFor(workdir) : undefined
}

/** The local executor's knobs plus this Bundle's container options. */
export interface Config extends LocalBashConfig, ContainerOptions {
  /** Explicit pwsh executable for the Windows local fallback (empty = probe well-known paths). */
  pwshPath?: Volatile<string>
  /**
   * Local fallback shell (default `auto`: PowerShell on Windows, bash elsewhere).
   * `bash` keeps the inherited executor; `powershell` runs
   * `pwsh -NoProfile -Command`, the same invocation `@deepseek-ai/dsh-pwsh-local`
   * uses.
   */
  localShell?: LocalShell
}

/**
 * Mirrors `@deepseek-ai/dsh-bash-local`'s schema field for field — the inherited
 * `resolve()` validates these through `assertServiceableBashConfig` — and adds
 * the shared container options plus the local-fallback knobs.
 */
const ConfigSchema = z.object({
  cwd: z.string().volatile(),
  timeoutMs: z.number().default(120_000).volatile(),
  maxTimeoutMs: z.number().default(600_000).volatile(),
  maxOutputBytes: z.number().default(64_000).volatile(),
  maxSpillBytes: z.number().default(64 * 1024 * 1024).volatile(),
  graceMs: z.number().default(3_000).volatile(),
  pwshPath: z.string().default('').volatile(),
  localShell: z.union(['auto', 'bash', 'powershell'] as const).default('auto'),
  ...containerOptionFields(),
})

/** The row's schema, typed for callers; the loader reads the class's static copy. */
export const Config = ConfigSchema as unknown as z<Config>

/**
 * Container-backed bash executor. Falls through to the platform's local shell
 * for every workdir that belongs to no Dev Container repository, so a session
 * that never touches such a repository behaves exactly like the provider this
 * Bundle replaced.
 */
export class DevcontainerShellExecutor extends SandboxBashExecutor {
  /**
   * The schema the Loader resolves this row's config through.
   *
   * It has to be a STATIC: the module's `default` export is this class, and the
   * Loader's `unwrapExports` hands Cordis the class itself — module-level exports
   * such as `Config` never reach it. Without this static the row would be mounted
   * with the inherited bash-local schema, silently dropping every container knob.
   */
  static override Config = ConfigSchema

  /**
   * The seams this executor spawns and confines through.
   *
   * This row REPLACES the sandboxed executor rather than the plain local one:
   * `ctx.shell.sandboxMode` is the capability fact permission presets read, and
   * an executor that cannot report one makes them refuse to compose at all.
   * Host-side commands therefore keep the confinement this platform shipped;
   * only a command that enters the container runs unconfined on the host,
   * because the container is what confines it.
   */
  static override inject = ['subprocess', 'sandbox', 'sandboxPolicy']

  /** Test seam: replaces the host CLI runner. */
  internals: { run?: ContainerRun; localShell?: LocalShell; requireContainer?: boolean } = {}

  /** This row's own configuration (the inherited `config` is typed by the local executor). */
  private readonly ownConfig: Config

  /** The container options this row was configured with. */
  private readonly options: ContainerOptions

  /** One resolved target per repository, so a burst of commands probes Docker once. */
  private readonly targets = new Map<string, Promise<ContainerTarget>>()

  /** Whether the configured directory has been walked for a declaration yet. */
  private warmed = false

  constructor(ctx: Context, config: Config) {
    super(ctx, config)
    this.ownConfig = config
    this.options = containerOptions(config)
    ctx.effect(() => {
      const cache = repoRegistry(ctx)
      return () => { cache.reset() }
    })
  }

  /**
   * Report the container's POSIX workdir so the model sees Linux paths.
   *
   * Only an execution that must reach a container is rewritten. An ordinary
   * session in the same repository keeps host paths, because its commands keep
   * running on the host — reporting `/workspaces/…` for a command that never
   * enters a container would describe a directory that does not exist.
   * @param request - the caller's request.
   * @returns the resolved spec, with a container workdir when this execution is container-bound.
   */
  override resolve(request: ShellExecRequest): ShellExecSpec {
    const spec = super.resolve(request)
    if (!this.requiresContainer(request)) return spec
    const repository = this.locate(spec.workdir, markedVariantKind(spec.dshEnv))
    if (repository === undefined) return spec
    const workdir = toContainerPath(spec.workdir, repository)
    return workdir === spec.workdir ? spec : { ...spec, workdir }
  }

  /**
   * Run the command inside the repository's container, or through the platform's
   * local shell when the workdir belongs to no Dev Container repository.
   * @param spec - a resolved spec from {@link DevcontainerShellExecutor.resolve}.
   * @returns the prepared execution handle.
   */
  override async execute(spec: ShellExecSpec): Promise<ShellExecution> {
    // A repository that declares a container does not make every session run in
    // it: only a container-bound execution is routed there. An ordinary preset
    // keeps the platform shell it had, even with a `.devcontainer` in the tree.
    if (!this.requiresContainer(spec)) return this.executeLocal(spec)
    const kind = markedVariantKind(spec.dshEnv)
    const repository = this.locate(spec.workdir, kind)
    if (repository === undefined) {
      // A derived preset promises container execution. Falling back to the host
      // would hand the model a host result it reads as a Linux one, so the command
      // is refused instead of silently misdirected.
      const preset = this.presetOf(spec)
      return refusedExecution(spec, kind === 'sbx'
        ? sbxRefusalText(spec.workdir, preset)
        : refusalText(spec.workdir, preset))
    }
    const key = this.targetKey(repository)
    // The host process must start in a directory that exists on THIS host.
    const hostSpec: ShellExecSpec = { ...spec, workdir: repository.hostWorkspaceRoot }
    const execution = await this.executeArgv(hostSpec, async (signal) => {
      const target = await this.containerTarget(key, repository, signal)
      // A sandbox may mount the workspace under a path of its own, which only its
      // listing knows: the workdir is translated against the folder it reported.
      const bound = bindSbxMount(repository, target)
      return buildExecArgv({
        spec: bound,
        target,
        containerWorkdir: toContainerPath(spec.workdir, bound),
        command: spec.command,
        env: containerEnv(repository, spec.env, spec.dshEnv),
      })
    })
    // A container that was restarted or recreated out from under a cached target
    // must be re-probed rather than reported as a permanent failure.
    void execution.result().then(
      (result) => { if (containerGone(result)) this.forgetTarget(key) },
      () => { this.forgetTarget(key) },
    )
    return stampUnconfined(execution)
  }

  /**
   * The local fallback: the inherited bash path (host confinement included), or
   * the PowerShell invocation `@deepseek-ai/dsh-pwsh-local` uses on Windows,
   * wrapped through the provider `@deepseek-ai/dsh-pwsh-sandbox` used. Both keep
   * the inherited deadline, output, and cancellation mechanics.
   */
  private executeLocal(spec: ShellExecSpec): Promise<ShellExecution> {
    const localShell = this.internals.localShell ?? this.ownConfig.localShell ?? 'auto'
    const powershell = localShell === 'powershell' || (localShell === 'auto' && process.platform === 'win32')
    if (!powershell) return super.execute(spec)
    const argv = [
      resolvePwshPath(this.ownConfig.pwshPath?.get()),
      '-NoLogo', '-NoProfile', '-NonInteractive',
      '-Command', `${ENCODING_PREAMBLE}${spec.command}`,
    ]
    const policy = spec.sandboxPolicy
    // No policy, or one that asks for host-wide access: spawn as before. A
    // confining policy wraps the same argv the sandboxed pwsh executor wrapped.
    if (policy === undefined) return this.executeArgv(spec, argv)
    const { mode } = policy
    if (mode === 'danger-full-access') return this.executeArgv(spec, argv)
    return this.executeArgv(spec, async (signal) => {
      const prepared = await this.ctx.sandbox.confine(argv, { ...policy, mode }, signal)
      signal.throwIfAborted()
      return prepared.argv
    })
  }

  /** Whether this execution must reach a container or not run at all. */
  private requiresContainer(request: ShellExecRequest | ShellExecSpec): boolean {
    if (this.internals.requireContainer === true) return true
    if (this.options.requireContainer) return true
    return markedContainerOnly(request.dshEnv)
  }

  /** The preset id the marker carries, so the refusal can name it. */
  private presetOf(spec: ShellExecSpec): string | undefined {
    return markedPreset(spec.dshEnv)
  }

  /**
   * The repository container specification governing one workdir.
   *
   * A `(devContainer)` session needs a declaration: without one there is nowhere
   * to run, which is what the refusal above reports. A `(sbx)` session needs
   * none — a sandbox mounts the host workspace at its own path — so a directory
   * with no declaration is described by {@link sbxSpecFor} instead, and only a
   * missing host directory (no configured cwd to fall back on) stays unresolved.
   *
   * A sandbox-spelled workdir is reversed onto the host before the registry is
   * asked, because `/f/personal/repo` has no host ancestry of its own.
   * @param workdir - the directory the command names.
   * @param kind - the runtime the calling preset selects, when one does.
   * @returns the specification, or undefined when this directory cannot be run in.
   */
  private locate(workdir: string, kind: VariantKind | undefined): RepoContainerSpec | undefined {
    const cwd = this.config.cwd.get()
    this.warmUp(cwd)
    const registry = repoRegistry(this.ctx)
    const options = { ...this.options, cwd }
    // A (sbx) session names its workdir the way its sandbox spells it, and that
    // spelling has no host ancestry to walk: `/f/personal/repo` resolves to no
    // host repository on a Windows host, where the directory is
    // `F:\personal\repo`. The host directory is recovered first, so a command
    // that already carries a container path still finds its repository.
    const attributed = kind === 'sbx' ? sandboxHostAttribution(workdir) : undefined
    const declared = registry.locate(attributed?.host ?? workdir, options)
    if (kind !== 'sbx') return declared
    const root = this.sbxHostRootOf(workdir, cwd, declared, attributed)
    return root === undefined
      ? undefined
      : sbxSpecFor(root, liveSbxOptions(this.ctx, this.options), declared)
  }

  /**
   * The host directory a `(sbx)` session mounts for one workdir.
   *
   * A declaration wins, because a sandbox mounts the repository it was found in.
   * The directory the row was configured with comes next: that is the workspace
   * the sandbox was created around, and a workdir below it belongs to the same
   * mount. Only a row configured with no directory at all takes the workspace from
   * the workdir itself — the host directory a reported mount covers, else the
   * drive directory its sandbox spelling names — which is what makes a workdir of
   * `/f/personal/repo` reach the sandbox of `F:\personal\repo`.
   * @param workdir - the directory the command named.
   * @param cwd - the directory the row was configured with.
   * @param declared - the specification a declaration produced, when one exists.
   * @param attributed - the host directory the workdir's sandbox spelling names.
   * @returns the absolute host path to mount, or undefined when none can be named.
   */
  private sbxHostRootOf(
    workdir: string,
    cwd: string | undefined,
    declared: RepoContainerSpec | undefined,
    attributed: SandboxHostAttribution | undefined,
  ): string | undefined {
    if (declared !== undefined) return declared.hostWorkspaceRoot
    if (cwd !== undefined && cwd !== '') return cwd
    if (attributed !== undefined) return attributed.workspaceRoot ?? attributed.host
    return sbxWorkspaceRootFor(workdir, undefined, undefined)
  }

  /**
   * Discover the configured directory once, so a first call that already speaks
   * in container paths can still be attributed to its repository.
   */
  private warmUp(cwd: string | undefined): void {
    if (this.warmed || cwd === undefined) return
    this.warmed = true
    repoRegistry(this.ctx).discover(cwd, { ...this.options, cwd })
  }

  /** The cache key of one repository's container target. */
  private targetKey(repository: RepoContainerSpec): string {
    return [
      repository.hostWorkspaceRoot,
      repository.cli,
      repository.container ?? '',
      repository.sandbox ?? '',
      String(repository.ensureUp),
    ].join('\u0000')
  }

  /** Drop one cached target, so the next command probes the container again. */
  private forgetTarget(key: string): void {
    this.targets.delete(key)
  }

  /** Resolve (once per repository) where commands run. */
  private containerTarget(key: string, repository: RepoContainerSpec, signal: AbortSignal): Promise<ContainerTarget> {
    const cached = this.targets.get(key)
    if (cached !== undefined) return cached
    for (const rejection of liveHostMountRejections(this.ctx)) {
      warnOnce(this.ctx, text => { this.ctx.logger.warn(text) }, rejection)
    }
    const pending = resolveContainerTarget(
      repository,
      this.internals.run ?? runContainerCommand,
      signal,
      message => { warnOnce(this.ctx, text => { this.ctx.logger.warn(text) }, message) },
    )
    this.targets.set(key, pending)
    pending.catch(() => {
      // A failed probe must not cache its failure: the next command retries.
      if (this.targets.get(key) === pending) this.targets.delete(key)
    })
    return pending
  }
}

export default DevcontainerShellExecutor
