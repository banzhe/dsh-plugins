/**
 * The refusal boundary for a `(devContainer)` preset in a repository that
 * declares no container.
 *
 * A derived preset promises "every command runs in the container". When the
 * repository has no configuration, silently running the command on the host
 * breaks that promise in the worst way: the model still believes it is in Linux,
 * so it writes Linux commands and reads their host-side failures as its own
 * mistakes. So the executor refuses instead, and the prompt says why before the
 * first command is even attempted.
 *
 * The marker travels in the managed `DSH_*` environment: `ctx.shellEnv`'s
 * contributor resolves the calling agent's preset for every shell call, and the
 * shell tools hand that snapshot to the executor as `dshEnv`. The executor
 * therefore never has to guess whose command this is.
 *
 * A filesystem call carries no such snapshot, and its own refusal is worse than
 * a misdirected command: reading or writing the host leaves a real file changed
 * while the model still believes it is in the container. {@link callingContainerPreset}
 * answers the same question from the one fact the composition does expose — the
 * Agent that initiated the current asynchronous chain — and
 * {@link fsRefusalText} is the diagnostic the filesystem row raises.
 *
 * The same two facts decide WHICH runtime a session is bound to: a
 * `(devContainer)` preset marks its commands with `DSH_DEVCONTAINER`, a `(sbx)`
 * preset with `DSH_SBX`. {@link markedVariantKind} and {@link callingVariantKind}
 * read that back, so the shell, filesystem, subprocess, and PTC seams each route
 * a call without asking four different questions.
 * @module @banzhe/dsh-devcontainer/refusal
 */

import type { Context } from '@deepseek-ai/cordis'
import { DSH_ENV_PREFIX } from '@deepseek-ai/dsh-shell'
import type {
  CollectedOutput, DshEnvironment, ShellExecSpec, ShellExecution, ShellProcessRead, ShellRunResult,
} from '@deepseek-ai/dsh-shell'
import { variantKindOf } from './ids.ts'
import type { VariantKind } from './ids.ts'

/** The managed `DSH_*` variable that marks a command issued from a derived preset. */
export const DEVCONTAINER_ENV_KEY = `${DSH_ENV_PREFIX}DEVCONTAINER` as `${typeof DSH_ENV_PREFIX}DEVCONTAINER`

/** Its only value: present means "this command must reach a container". */
export const DEVCONTAINER_ENV_VALUE = '1'

/** The preset id that set the marker, so a refusal can name it. */
export const DEVCONTAINER_PRESET_ENV_KEY = `${DSH_ENV_PREFIX}DEVCONTAINER_PRESET` as `${typeof DSH_ENV_PREFIX}DEVCONTAINER_PRESET`

/** The managed `DSH_*` variable that marks a command issued from a `(sbx)` preset. */
export const SBX_ENV_KEY = `${DSH_ENV_PREFIX}SBX` as `${typeof DSH_ENV_PREFIX}SBX`

/** Its only value: present means "this command must reach the Docker Sandbox". */
export const SBX_ENV_VALUE = '1'

/** The preset id that set the sandbox marker, so a diagnostic can name it. */
export const SBX_PRESET_ENV_KEY = `${DSH_ENV_PREFIX}SBX_PRESET` as `${typeof DSH_ENV_PREFIX}SBX_PRESET`

/** Every scheduling marker this Bundle owns; none of them is forwarded into a runtime. */
export const CONTAINER_MARKER_KEYS: readonly string[] = [
  DEVCONTAINER_ENV_KEY, DEVCONTAINER_PRESET_ENV_KEY, SBX_ENV_KEY, SBX_PRESET_ENV_KEY,
]

/** The preset-registry slice this module reads. */
export interface PresetLookup {
  /**
   * Read the preset a Session committed to.
   * @param session - the session whose selection is read.
   * @returns the preset id, or null when the session committed to none.
   */
  presetForSession(session: never): string | null
}

/**
 * The derived preset an agent runs under, on either track.
 * @param presets - the Host preset registry, when the composition supplies one.
 * @param session - the calling agent's session, when the call has one.
 * @returns the derived preset id, or undefined for an ordinary preset or no lookup.
 */
export function containerPresetOf(
  presets: PresetLookup | undefined,
  session: unknown,
): string | undefined {
  if (presets === undefined || session === undefined || session === null) return undefined
  let id: string | null
  try {
    id = presets.presetForSession(session as never)
  } catch {
    // A registry that cannot answer must not break a command that would otherwise run.
    return undefined
  }
  return id !== null && variantKindOf(id) !== undefined ? id : undefined
}

/**
 * Which runtime one preset id targets.
 * @param preset - a preset id, or undefined when the session committed to none.
 * @returns the track, or undefined for an ordinary preset.
 */
export function presetKindOf(preset: string | undefined): VariantKind | undefined {
  return preset === undefined ? undefined : variantKindOf(preset)
}

/** The `ctx.agents` slice this module reads: the Agent that initiated an asynchronous chain. */
export interface InitiatorLookup {
  /**
   * Read the Agent that initiated the inherited asynchronous driver chain.
   * @returns the inherited Agent, or undefined outside an initiator boundary.
   */
  currentInitiator(): { session: unknown } | undefined
}

/** Read one service without a typed `Context` augmentation, as the Host row does. */
function serviceOf(ctx: Context, service: string): unknown {
  return (ctx as unknown as { get(name: string): unknown }).get(service)
}

/**
 * The derived preset the CALLING agent runs, on either track.
 *
 * A shell call carries its agent in `spec.dshEnv`; a filesystem call carries
 * nothing, so this reads the initiator the loop establishes around every turn —
 * a subagent's own Session answers `presetForSession`, so a delegated agent is
 * attributed to its own preset exactly as it is for a command. A call made
 * outside any turn (a file read by the settings page, a plugin's own
 * bookkeeping) inherits no initiator and therefore no requirement.
 * @param ctx - the calling row's context.
 * @returns the derived preset id, or undefined for an ordinary or agentless call.
 */
export function callingContainerPreset(ctx: Context): string | undefined {
  const agents = serviceOf(ctx, 'agents') as InitiatorLookup | undefined
  const presets = serviceOf(ctx, 'agentPresets') as PresetLookup | undefined
  if (agents === undefined) return undefined
  let initiator: { session: unknown } | undefined
  try {
    initiator = agents.currentInitiator()
  } catch {
    // A registry that is closing cannot answer; a call that would otherwise run must not break.
    return undefined
  }
  return containerPresetOf(presets, initiator?.session)
}

/**
 * Which runtime the CALLING agent's preset targets.
 *
 * The filesystem, subprocess, and PTC seams carry no per-call marker, so they ask
 * the initiator boundary the same way {@link callingContainerPreset} does.
 * @param ctx - the calling row's context.
 * @returns the track, or undefined for an ordinary or agentless call.
 */
export function callingVariantKind(ctx: Context): VariantKind | undefined {
  return presetKindOf(callingContainerPreset(ctx))
}

/**
 * Whether one execution is marked as bound to a derived preset's runtime.
 * @param dshEnv - the managed environment the shell tool passed down.
 * @returns true when either marker is present.
 */
export function markedContainerOnly(dshEnv: DshEnvironment | undefined): boolean {
  if (dshEnv === undefined) return false
  return Reflect.get(dshEnv, DEVCONTAINER_ENV_KEY) === DEVCONTAINER_ENV_VALUE
    || Reflect.get(dshEnv, SBX_ENV_KEY) === SBX_ENV_VALUE
}

/**
 * Which runtime one execution is marked for.
 *
 * The sandbox marker is checked first: a `(sbx)` preset never sets the Dev
 * Container one, and a call that somehow carried both must be answered by the
 * marker whose runtime mounts the workspace without a declaration.
 * @param dshEnv - the managed environment the shell tool passed down.
 * @returns the track, or undefined when the call is unmarked.
 */
export function markedVariantKind(dshEnv: DshEnvironment | undefined): VariantKind | undefined {
  if (dshEnv === undefined) return undefined
  if (Reflect.get(dshEnv, SBX_ENV_KEY) === SBX_ENV_VALUE) return 'sbx'
  if (Reflect.get(dshEnv, DEVCONTAINER_ENV_KEY) === DEVCONTAINER_ENV_VALUE) return 'devcontainer'
  return undefined
}

/**
 * The preset id recorded alongside the marker.
 * @param dshEnv - the managed environment the shell tool passed down.
 * @returns the derived preset id, or undefined when no marker carries one.
 */
export function markedPreset(dshEnv: DshEnvironment | undefined): string | undefined {
  if (dshEnv === undefined) return undefined
  for (const key of [SBX_PRESET_ENV_KEY, DEVCONTAINER_PRESET_ENV_KEY]) {
    const value: unknown = Reflect.get(dshEnv, key)
    if (typeof value === 'string' && value.length > 0) return value
  }
  return undefined
}

/**
 * The diagnostic a refused command reports.
 * @param workdir - the host directory the command named.
 * @param preset - the derived preset the session runs, when it is known.
 * @returns the stderr text.
 */
export function refusalText(workdir: string, preset: string | undefined): string {
  const owner = preset === undefined ? 'a (devContainer) preset' : `the (devContainer) preset "${preset}"`
  return [
    `devcontainer: refused to run this command on the host.`,
    `This session uses ${owner}, so every command must run inside the repository's Linux container, but "${workdir}" declares none.`,
    `Looked for .devcontainer/devcontainer.json, .devcontainer.json, .dsh/devcontainer.json, or .dsh/docker.json in that directory and its ancestors.`,
    `Add one of those files to the repository, or switch to an ordinary preset without the (devContainer) suffix.`,
    '',
  ].join('\n')
}

/**
 * The diagnostic a refused `(sbx)` command reports.
 *
 * A sandbox needs no declaration, so this refusal only happens when the session
 * has no host directory at all to mount — a row mounted without `cwd` and a
 * relative workdir. Naming the row's own setting is the way out.
 * @param workdir - the directory the command named.
 * @param preset - the derived preset the session runs, when it is known.
 * @returns the stderr text.
 */
export function sbxRefusalText(workdir: string, preset: string | undefined): string {
  const owner = preset === undefined ? 'a (sbx) preset' : `the (sbx) preset "${preset}"`
  return [
    'sbx: refused to run this command on the host.',
    `This session uses ${owner}, so every command must run inside its Docker Sandbox, but no host workspace directory could be resolved for "${workdir}".`,
    'A Docker Sandbox mounts a host directory, and this row was configured without a "cwd" to fall back on.',
    'Set the row\'s "cwd" to the repository directory, or switch to a preset without the (sbx) suffix.',
    '',
  ].join('\n')
}

/**
 * The diagnostic a metadata probe outside every mount reports.
 *
 * A sandbox filesystem holds its workspace and the mounts its row declares; a probe
 * of anything else is answered as the absence it is, in one line, without the escape
 * wording a refused read or write gets.
 * @param path - the path the probe named.
 * @returns the diagnostic, ending without a newline so the seam reports it verbatim.
 */
export function fsUnmountedText(path: string): string {
  return `devcontainer: "${path}" is not inside any mount of this session's container, so its filesystem has no such path`
}

/**
 * The diagnostic a refused filesystem call reports.
 *
 * It names the preset, the path, and every file discovery looked for, then the
 * two ways out — adding a declaration or switching to an ordinary preset — so
 * the refusal cannot be mistaken for a broken tool.
 * @param path - the path the call named.
 * @param preset - the derived preset the session runs, when it is known.
 * @returns the refusal text.
 */
export function fsRefusalText(path: string, preset: string | undefined): string {
  const owner = preset === undefined ? 'a (devContainer) preset' : `the (devContainer) preset "${preset}"`
  return [
    `devcontainer: refused to access this path on the host.`,
    `This session uses ${owner}, so every file it reads or writes must live in the repository its Linux container mounts, but the repository that owns "${path}" declares none.`,
    `Looked for .devcontainer/devcontainer.json, .devcontainer.json, .dsh/devcontainer.json, or .dsh/docker.json next to that path and in its ancestors.`,
    `Add one of those files to the repository, or switch to an ordinary preset without the (devContainer) suffix.`,
    '',
  ].join('\n')
}

/**
 * The diagnostic a filesystem call reports when the target escapes the repository mount.
 *
 * A path inside the repository can still name something outside it: a symbolic
 * link resolves wherever it points, and a target resolved before the session
 * became container-bound carries a host spelling. Both are refused, and the two
 * spellings are both reported so the link can be found and removed instead of
 * the refusal reading as a bug.
 * @param displayPath - the path the call named.
 * @param targetKey - the resolved path the backend would have used for I/O.
 * @param preset - the derived preset the session runs, when it is known.
 * @returns the refusal text.
 */
export function fsEscapeRefusalText(displayPath: string, targetKey: string, preset: string | undefined): string {
  const owner = preset === undefined ? 'a (devContainer) preset' : `the (devContainer) preset "${preset}"`
  return [
    `devcontainer: refused to access this path.`,
    `This session uses ${owner}, so everything it reads or writes must stay inside the repository its Linux container mounts.`,
    `"${displayPath}" resolves to "${targetKey}", which is outside that repository.`,
    `A symbolic link inside the repository must not point out of it, and a location resolved on the host must be resolved again inside the container.`,
    `Switch to an ordinary preset without the (devContainer) suffix to work on host files.`,
    '',
  ].join('\n')
}

/** One offset read over a stream that already holds its whole text. */
interface SettledReader {
  readFrom(fromByte: number): { text: string, nextOffset: number, lossy: boolean }
}

/** A captured stream that already holds its whole text. */
function settledReader(text: string): SettledReader {
  return {
    readFrom: (fromByte: number) => ({
      text: text.slice(fromByte),
      nextOffset: text.length,
      lossy: false,
    }),
  }
}

/** A captured stream with no truncation. */
function collected(text: string): CollectedOutput {
  return { text, truncated: false }
}

/**
 * The completed execution a refused command returns.
 *
 * A command that never ran still has to answer in the shape the tool expects:
 * `exitCode: 1` and the diagnostic on stderr, so the model reads a failure it can
 * act on instead of a host-side result that looks like success.
 * @param spec - the resolved spec that was refused.
 * @param text - the diagnostic to report.
 * @returns the settled execution handle.
 */
export function refusedExecution(spec: ShellExecSpec, text: string): ShellExecution {
  let drained = false
  const stderr = settledReader(text)
  const stdout = settledReader('')
  const result: ShellRunResult = {
    exitCode: 1,
    signal: null,
    timedOut: false,
    aborted: false,
    timeoutMs: spec.timeoutMs,
    stdout: collected(''),
    stderr: collected(text),
  }
  return {
    status: 'completed',
    exitCode: 1,
    signal: null,
    done: Promise.resolve(),
    readOutput: (): ShellProcessRead => {
      if (drained) return { delta: '', lossy: false }
      drained = true
      return { delta: text, lossy: false }
    },
    observed: { stdout, stderr },
    kill: () => false,
    result: () => Promise.resolve(result),
  }
}
