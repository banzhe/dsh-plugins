/**
 * `ctx.ptcRuntime` for repositories that declare a Dev Container, narrowed to the
 * one field a program's host process cannot take from the container: its working
 * directory.
 *
 * `ctx.subprocess` already starts every host process in the host repository root
 * (`src/subprocess.ts`), but the PTC seam is asked for a directory of its own:
 * `resolve` fills a missing `cwd` from the sandbox policy's workspace root — the
 * container's `/workspaces/<repo>` — and `run` hands that directory to the worker,
 * whose entry program `process.chdir`s into it before the first line of the
 * program runs. The worker is a host Node process, so the chdir failed with
 * `ENOENT` before any binding call reached `ctx.fs`.
 *
 * So both entry points are decorated, one decision deep: a directory that names
 * the container view of a discovered repository becomes that repository's host
 * directory through `toHostPath` — POSIX remainder arithmetic plus the host
 * root's own separator style, so a Windows, Linux, or macOS host runs one code
 * path and no drive letter is ever constructed. Everything else — an ordinary
 * session, a host path, a relative path, a container path no declaration owns —
 * reaches the provider exactly as the caller wrote it.
 *
 * Only the working directory moves. The program's file access is `ctx.fs`, which
 * is the Docker RPC pipe, and the sandbox policy is the caller's: the host
 * directory is where a host process may start, never a place the session may read.
 * @module @banzhe/dsh-devcontainer/ptc
 */

import type { PtcRunRequest, PtcRunResult, PtcRunSpec } from '@deepseek-ai/dsh-ptc-runtime'
import { toHostPath } from './paths.ts'
import type { RepoContainerSpec } from './types.ts'

/** The two methods of the PTC seam this module decorates. */
export interface PtcSeam {
  /**
   * Resolve supported options and provider defaults before execution.
   * @param request - program, bindings, cancellation and optional execution choices.
   * @returns the complete execution inputs, including the directory `run` receives.
   */
  resolve(request: PtcRunRequest): PtcRunSpec

  /**
   * Execute one resolved program.
   * @param spec - the directory, deadline, program, bindings and policy of one run.
   * @returns the captured output and the execution outcome.
   */
  run(spec: PtcRunSpec): Promise<PtcRunResult>
}

/** The repository that owns one directory, when a declaration does. */
export type RepositoryOfPath = (cwd: string) => RepoContainerSpec | undefined

/**
 * The directory the host process may actually start in.
 * @param cwd - the directory the caller, or the provider's own default, named.
 * @param repository - the container repository that owns it, when one does.
 * @returns the host path of the same directory, or `cwd` unchanged.
 */
export function mapPtcCwd(cwd: string, repository: RepoContainerSpec | undefined): string {
  return repository === undefined ? cwd : toHostPath(cwd, repository)
}

/**
 * Make every program run in a directory that exists on this host.
 *
 * The seam is decorated in place rather than replaced: Cordis holds one
 * implementation per service name, so a second `ptcRuntime` row would be refused
 * at activation, while every run that needs no rewrite — an ordinary session's
 * program, a program in a host repository — must keep the provider's own process
 * mechanics. Both inherited methods are called with their own receiver, and a
 * request or spec object is passed through untouched when nothing is mapped.
 *
 * `resolve` is decorated as well as `run`, not instead of it: a caller that keeps
 * the resolved spec (a consumer that reports the directory, or a persistent
 * runtime that compares policies) must not be handed a container path that the
 * provider then chdirs into. A request that names no directory is resolved by the
 * provider first and mapped afterwards, because the provider fills it from the
 * sandbox policy's workspace root, which is the container spelling this module
 * exists to replace.
 * @param seam - the mounted PTC runtime.
 * @param repositoryOf - the repository that owns one directory, when one does.
 * @returns the disposer that puts the inherited methods back.
 */
export function installPtcCwdMapping(seam: PtcSeam, repositoryOf: RepositoryOfPath): () => void {
  const inheritedResolve = seam.resolve.bind(seam)
  const inheritedRun = seam.run.bind(seam)

  const mappedResolve = (request: PtcRunRequest): PtcRunSpec => {
    const requested = request.cwd
    if (requested !== undefined) {
      const cwd = mapPtcCwd(requested, repositoryOf(requested))
      return inheritedResolve(cwd === requested ? request : { ...request, cwd })
    }
    const resolved = inheritedResolve(request)
    const cwd = mapPtcCwd(resolved.cwd, repositoryOf(resolved.cwd))
    return cwd === resolved.cwd ? resolved : { ...resolved, cwd }
  }

  const mappedRun = (spec: PtcRunSpec): Promise<PtcRunResult> => {
    const cwd = mapPtcCwd(spec.cwd, repositoryOf(spec.cwd))
    return inheritedRun(cwd === spec.cwd ? spec : { ...spec, cwd })
  }

  Object.defineProperty(seam, 'resolve', { configurable: true, writable: true, value: mappedResolve })
  Object.defineProperty(seam, 'run', { configurable: true, writable: true, value: mappedRun })
  return () => {
    // Cordis hands a service out through a traceable proxy that wraps every
    // method read in a fresh function, so the own descriptor — not a read of the
    // method — says whether this decoration is still the installed one.
    for (const [method, installed] of [['resolve', mappedResolve], ['run', mappedRun]] as const) {
      if (Object.getOwnPropertyDescriptor(seam, method)?.value !== installed) continue
      Reflect.deleteProperty(seam, method)
    }
  }
}
