/**
 * The argv one container-executed command becomes.
 *
 * Two shapes, one contract: the command runs under the configured Linux shell,
 * in the container directory that mirrors the host workdir, with ONLY the
 * environment this Bundle deliberately forwards. The host's `PATH`,
 * `SystemRoot`, and every other Windows entry stay out of the container — a
 * Linux `bash` reading a Windows `PATH` finds no binaries at all.
 *
 * @module @banzhe/dsh-devcontainer/argv
 */

import type { ContainerTarget } from './container.ts'
import { CONTAINER_MARKER_KEYS } from './refusal.ts'
import type { RepoContainerSpec } from './types.ts'

/**
 * The host-side scheduling markers. They tell this Bundle's executor whose
 * command it is holding; inside the runtime they mean nothing, so they are
 * never forwarded.
 */
const INTERNAL_ENV_KEYS: ReadonlySet<string> = new Set(CONTAINER_MARKER_KEYS)

/**
 * Terminal facts every container command gets. They replace what
 * `LocalBashExecutor` normally sets on the child: colors, pagers, and
 * interactive prompts have no place in captured tool output.
 */
export const BASE_CONTAINER_ENV: Readonly<Record<string, string>> = {
  TERM: 'dumb',
  GIT_TERMINAL_PROMPT: '0',
  NO_COLOR: '1',
}

/** One command's container argv inputs. */
export interface ExecArgvInput {
  /** The repository container specification. */
  readonly spec: RepoContainerSpec
  /** The resolved container target. */
  readonly target: ContainerTarget
  /** POSIX directory inside the container the command runs in. */
  readonly containerWorkdir: string
  /** The command source the model asked for. */
  readonly command: string
  /** Already-merged environment entries; only these reach the container. */
  readonly env: Readonly<Record<string, string>>
}

/**
 * Merge the container environment: base facts first, then the configuration's
 * `remoteEnv`, then the caller's own entries. Nothing from the host process
 * participates.
 * @param spec - the repository container specification.
 * @param env - the caller's ordinary environment entries.
 * @param dshEnv - the harness-managed `DSH_*` snapshot for this execution.
 * @returns the merged map, or `{}` when nothing is forwarded.
 */
export function containerEnv(
  spec: RepoContainerSpec,
  env?: Readonly<Record<string, string>>,
  dshEnv?: Readonly<Record<string, string>>,
): Record<string, string> {
  const managed: Record<string, string> = {}
  for (const [key, value] of Object.entries(dshEnv ?? {})) {
    if (INTERNAL_ENV_KEYS.has(key)) continue
    managed[key] = value
  }
  return {
    ...BASE_CONTAINER_ENV,
    ...spec.remoteEnv,
    ...env,
    ...managed,
  }
}

/**
 * Split a configured shell into its program and any fixed arguments, so
 * `/bin/bash -l` reaches the container as two words followed by `-c`.
 * @param shell - the configured shell string.
 * @returns the program followed by its arguments; `/bin/bash` when empty.
 */
export function shellParts(shell: string): string[] {
  const parts = shell.trim().split(/\s+/).filter(part => part !== '')
  return parts.length === 0 ? ['/bin/bash'] : parts
}

/** `-e KEY=VALUE` flags, sorted so one command always yields one argv. */
function envFlags(env: Readonly<Record<string, string>>): string[] {
  return Object.keys(env).sort().map((key) => `${key}=${env[key] as string}`)
}

/** Single-quote one shell word, so an inner command survives unchanged. */
function quote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`
}

/**
 * Assemble the argv for one command.
 * @param input - target, workdir, command, and the merged environment.
 * @returns the complete argv to hand to the subprocess seam.
 */
export function buildExecArgv(input: ExecArgvInput): readonly string[] {
  const { spec, target, containerWorkdir, command } = input
  const flags = envFlags(input.env)
  const user = spec.remoteUser
  switch (target.kind) {
    case 'docker':
      return [
        'docker', 'exec', '-i', '-w', containerWorkdir,
        ...user === undefined ? [] : ['-u', user],
        ...flags.flatMap(entry => ['-e', entry]),
        target.containerId,
        ...shellParts(spec.shell), '-c', command,
      ]
    case 'devcontainer-cli':
      // `devcontainer exec` starts its own process, so the subdirectory has to be
      // entered by a POSIX shell wrapper inside the container.
      return [
        'devcontainer', 'exec', '--workspace-folder', target.workspaceFolder,
        ...user === undefined ? [] : ['--remote-user', user],
        ...flags.flatMap(entry => ['--remote-env', entry]),
        '--', '/bin/sh', '-c', shellWrapper(input, []),
      ]
    case 'sbx':
      // `sbx exec` takes no environment flags on the sandbox CLI version this
      // Bundle targets, and it starts its own process, so both the workdir and the
      // environment are applied by the same POSIX wrapper: `env` sets the entries
      // for the shell about to replace the wrapper, and `exec` keeps the exit code
      // and signal of the real command.
      return [
        'sbx', 'exec', target.sandboxName, '--', '/bin/sh', '-c',
        shellWrapper(input, envProgram(flags)),
      ]
  }
}

/**
 * The POSIX wrapper one sandbox or CLI command runs under.
 * @param input - the command and where it runs.
 * @param program - words that precede the shell (an `env` prefix, or nothing).
 * @returns the wrapper script.
 */
function shellWrapper(input: ExecArgvInput, program: readonly string[]): string {
  const shell = [...program, ...shellParts(input.spec.shell).map(quote)].join(' ')
  return `cd -- ${quote(input.containerWorkdir)} && exec ${shell} -c ${quote(input.command)}`
}

/**
 * An `env` prefix carrying the merged environment, so a sandbox command sees the
 * same entries a `docker exec -e` would have given it.
 * @param flags - the sorted `KEY=VALUE` entries.
 * @returns the prefix words, or an empty list when nothing is forwarded.
 */
function envProgram(flags: readonly string[]): string[] {
  return flags.length === 0 ? [] : ['env', ...flags.map(quote)]
}
