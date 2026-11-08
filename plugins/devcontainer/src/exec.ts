/**
 * The one place this Bundle starts a host process: the Docker / Dev Container
 * CLI probes that find or start the container, and the `docker exec` that runs
 * the agent's command. Kept behind an interface so the container argv logic is
 * testable without a Docker daemon.
 * @module @banzhe/dsh-devcontainer/exec
 */

import { execFile } from 'node:child_process'
import { SENSITIVE_ENV_PATTERN } from '@deepseek-ai/dsh-subprocess'

/** One finished CLI call. */
export interface ContainerCommandResult {
  readonly stdout: string
  readonly stderr: string
  /** Exit code, or null when the CLI could not be started at all. */
  readonly exitCode: number | null
}

/** Options for one CLI call. */
export interface ContainerCommandOptions {
  readonly signal?: AbortSignal | undefined
  readonly timeoutMs?: number | undefined
  readonly cwd?: string | undefined
}

/** Runs one host CLI command and resolves with its output. */
export type ContainerRun = (argv: readonly string[], options?: ContainerCommandOptions) => Promise<ContainerCommandResult>

/**
 * Cap for one probe's captured output. The agent's own commands do not come
 * through here — they run through the subprocess seam, which streams and caps
 * them — so this only has to hold `devcontainer up`'s build log.
 */
const MAX_CLI_OUTPUT_BYTES = 32 * 1024 * 1024

/**
 * The parent variables a Docker / Dev Container CLI is started with.
 *
 * The CLI is a host program the harness runs on the user's behalf, not a proxy
 * for the session: starting it with the ambient environment would hand the
 * harness's own credentials, the session's `DSH_*` facts, and every unrelated
 * host-only variable to a build that the container's `Dockerfile` can read.
 * Only the names below survive, because the CLI itself needs each one:
 * executable lookup and the platform runtime, the per-user Docker configuration
 * under `HOME`/`APPDATA` (where the credential helper is named), scratch space,
 * locale, and proxy routing.
 */
const CONTAINER_CLI_ENV_NAMES: readonly string[] = [
  'PATH', 'PATHEXT', 'SYSTEMROOT', 'SYSTEMDRIVE', 'WINDIR', 'COMSPEC',
  'HOME', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'APPDATA', 'LOCALAPPDATA',
  'PROGRAMDATA', 'PROGRAMFILES', 'PROGRAMFILES(X86)', 'PROGRAMW6432',
  'TEMP', 'TMP', 'TMPDIR',
  'LANG', 'LANGUAGE', 'LC_ALL', 'LC_CTYPE', 'TZ',
  'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'ALL_PROXY',
]

/** Families the CLIs own end to end; a user's Docker/XDG settings belong to them. */
const CONTAINER_CLI_ENV_PREFIXES: readonly string[] = ['DOCKER_', 'XDG_']

/**
 * The environment one Docker / Dev Container CLI call is started with.
 *
 * Names are matched case-insensitively because Windows environment names are,
 * and a credential-shaped name is dropped even when it is otherwise listed (see
 * `SENSITIVE_ENV_PATTERN`, the one heuristic every in-repo spawner shares).
 * @param parent - the environment to filter; the host process environment by default.
 * @returns a fresh environment object, safe to hand to `execFile`.
 */
export function containerCliEnv(parent: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const allowed = new Set(CONTAINER_CLI_ENV_NAMES)
  const env: Record<string, string> = {}
  for (const [name, value] of Object.entries(parent)) {
    if (value === undefined || SENSITIVE_ENV_PATTERN.test(name)) continue
    const folded = name.toUpperCase()
    if (!allowed.has(folded) && !CONTAINER_CLI_ENV_PREFIXES.some(prefix => folded.startsWith(prefix))) continue
    env[name] = value
  }
  return env
}

/**
 * Run one CLI command without a shell, capturing bounded output.
 * @param argv - program and arguments, never shell-interpreted.
 * @param options - cancellation, timeout, and working directory.
 * @returns the captured result; a missing program is reported as `exitCode: null`.
 */
export const runContainerCommand: ContainerRun = (argv, options = {}) => {
  const [program, ...args] = argv
  if (program === undefined) return Promise.reject(new Error('devcontainer: empty command'))
  return new Promise((resolvePromise, reject) => {
    execFile(program, args, {
      encoding: 'utf8',
      maxBuffer: MAX_CLI_OUTPUT_BYTES,
      windowsHide: true,
      env: containerCliEnv(),
      // `signal` kills the child on abort; naming the signal keeps the kill
      // deterministic instead of relying on the platform default.
      killSignal: 'SIGTERM',
      ...options.signal === undefined ? {} : { signal: options.signal },
      ...options.timeoutMs === undefined ? {} : { timeout: options.timeoutMs },
      ...options.cwd === undefined ? {} : { cwd: options.cwd },
    }, (error, stdout, stderr) => {
      if (error !== null && options.signal?.aborted === true) {
        reject(options.signal.reason instanceof Error ? options.signal.reason : new Error('devcontainer: command aborted'))
        return
      }
      const exitCode = error === null
        ? 0
        : typeof error.code === 'number' ? error.code : null
      resolvePromise({ stdout, stderr, exitCode })
    })
  })
}
