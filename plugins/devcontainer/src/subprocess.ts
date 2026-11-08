/**
 * `ctx.subprocess` for repositories that declare a Dev Container, narrowed to the
 * one field a host process cannot take from the container: its working directory.
 *
 * A container-bound session speaks container paths end to end — `ctx.shell`
 * reports `/workspaces/<repo>/…` and `ctx.fs` resolves the same spelling inside
 * the container — so the directory a child process is asked to start in can name
 * something that exists only on the container side. Nothing on the host can enter
 * it: the spawn fails with `ENOENT` before a single line of the child runs, which
 * is how the `run_code` PTC worker died before its first `tools.read` binding.
 *
 * So the seam is decorated, one decision deep: a working directory that belongs to
 * a discovered repository is translated back onto that repository's host root
 * using POSIX path arithmetic and the host root's own separator style, so the same
 * code is correct on a Windows, Linux, or macOS host. Everything else — an
 * ordinary session, a host path, a container path no declaration owns — reaches
 * the provider exactly as the caller wrote it.
 *
 * Only the working directory moves. What the child then does with files still
 * travels the container path: the PTC bindings call `tools.read`/`tools.write`,
 * which are `ctx.fs`, which is the Docker RPC pipe. The host directory is where a
 * host process may start, not a place the session may read.
 * @module @banzhe/dsh-devcontainer/subprocess
 */

import type { Context } from '@deepseek-ai/cordis'
import type { SubprocessHandle, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import { toHostPath } from './paths.ts'
import { callingVariantKind } from './refusal.ts'
import { repoRegistry } from './registry.ts'
import { asSbxSpec, sbxSpecFor, sbxWorkspaceRootFor } from './sbx.ts'
import type { ContainerOptions, RepoContainerSpec } from './types.ts'

/** The one method of the subprocess seam this module decorates. */
export interface SpawnSeam {
  /**
   * Start one managed child process.
   * @param spec - the caller's fully specified spawn request.
   * @returns the live process handle.
   */
  spawn(spec: SubprocessSpawnSpec): SubprocessHandle
}

/** The `ctx.agents` slice this module reads: the Agent that initiated the call. */
interface InitiatorLookup {
  /**
   * Read the Agent that initiated the inherited asynchronous driver chain.
   * @returns the inherited Agent, or undefined outside an initiator boundary.
   */
  currentInitiator(): { readonly session: { readonly header?: { readonly cwd?: string } } } | undefined
}

/** The `ctx.workingDirectory` slice this module reads. */
interface DirectoryLookup {
  /**
   * Read the Session's current directory.
   * @param session - the Session whose directory is requested.
   * @returns the committed directory.
   */
  get(session: never): string
}

/** Read one service without a typed `Context` augmentation, as the other rows do. */
function serviceOf(ctx: Context, service: string): unknown {
  return (ctx as unknown as { get(name: string): unknown }).get(service)
}

/**
 * The working directory a host process may actually start in.
 * @param cwd - the directory the caller asked for.
 * @param repository - the container repository that owns it, when one does.
 * @returns the host path of the same directory, or `cwd` unchanged.
 */
export function mapSpawnCwd(cwd: string, repository: RepoContainerSpec | undefined): string {
  return repository === undefined ? cwd : toHostPath(cwd, repository)
}

/**
 * The host directories that can name the repository behind a container path.
 *
 * Discovery walks host ancestors, and a container path has none, so the walk needs
 * a real directory to start from. The initiating Agent's own two are the ones this
 * session started with: its working-directory projection is where the model
 * believes it is, and its Session header keeps the project directory the Session
 * was created in — a host path, because the Session is created on the host. An
 * anchor that names nothing real simply discovers nothing; ownership still decides
 * whether a repository may claim the path.
 * @param ctx - the calling row's context.
 * @returns candidate host directories, best first, without duplicates.
 */
function hostAnchors(ctx: Context): readonly string[] {
  let initiator: { readonly session: { readonly header?: { readonly cwd?: string } } } | undefined
  try {
    initiator = (serviceOf(ctx, 'agents') as InitiatorLookup | undefined)?.currentInitiator()
  } catch {
    // A closing initiator scope cannot answer; the discovery cache is still consulted.
    initiator = undefined
  }
  if (initiator === undefined) return []
  const anchors: string[] = []
  const directories = serviceOf(ctx, 'workingDirectory') as DirectoryLookup | undefined
  if (directories !== undefined) {
    try {
      anchors.push(directories.get(initiator.session as never))
    } catch {
      // A Session with no directory projection answers nothing; the header still can.
    }
  }
  const project = initiator.session.header?.cwd
  if (project !== undefined) anchors.push(project)
  return [...new Set(anchors)]
}

/**
 * The repository whose runtime owns one directory.
 *
 * A `(sbx)` session mounts the host directory at its own absolute path, so the
 * specification handed back is the sandbox view of the same repository: the
 * declared `workspaceFolder` (`/workspaces/<repo>`) is replaced by the host
 * root, which keeps the translation this module performs a normalization instead
 * of a wrong mount. A sandbox directory with no declaration at all is described
 * from the directory itself, because a sandbox needs no declaration.
 * @param ctx - the calling row's context.
 * @param path - a container path, a host path, or a relative path.
 * @param options - the row's container defaults, applied to a fresh discovery.
 * @returns the owning repository specification, or undefined when nothing declares a container for it.
 */
export function repositoryOfPath(
  ctx: Context, path: string, options: ContainerOptions,
): RepoContainerSpec | undefined {
  const kind = callingVariantKind(ctx)
  const adopt = (spec: RepoContainerSpec): RepoContainerSpec => (kind === 'sbx' ? asSbxSpec(spec) : spec)
  const registry = repoRegistry(ctx)
  for (const anchor of hostAnchors(ctx)) {
    const found = registry.locate(path, { ...options, cwd: anchor })
    if (found !== undefined) return adopt(found)
  }
  const found = registry.locate(path, options)
  if (found !== undefined) return adopt(found)
  if (kind !== 'sbx') return undefined
  const root = sbxWorkspaceRootFor(path, undefined, undefined)
  return root === undefined ? undefined : sbxSpecFor(root, options)
}

/**
 * Start every host process in a directory that exists on this host.
 *
 * The seam is decorated in place rather than replaced: Cordis holds one
 * implementation per service name, so a second `subprocess` row would be refused
 * at activation, while every spawn that needs no rewrite — an ordinary session's
 * shell, a language server in a host repository — must keep the provider's own
 * process mechanics. The inherited method is called with its own receiver, and
 * the original spec object is passed through untouched when nothing is mapped.
 * @param seam - the mounted subprocess service.
 * @param repositoryOf - the repository that owns one directory, when one does.
 * @returns the disposer that puts the inherited method back.
 */
export function installSpawnCwdMapping(
  seam: SpawnSeam,
  repositoryOf: (cwd: string) => RepoContainerSpec | undefined,
): () => void {
  const inherited = seam.spawn.bind(seam)
  const mapped = (spec: SubprocessSpawnSpec): SubprocessHandle => {
    const cwd = mapSpawnCwd(spec.cwd, repositoryOf(spec.cwd))
    return inherited(cwd === spec.cwd ? spec : { ...spec, cwd })
  }
  Object.defineProperty(seam, 'spawn', { configurable: true, writable: true, value: mapped })
  return () => {
    // Cordis hands a service out through a traceable proxy that wraps every
    // method read in a fresh function, so the own descriptor — not a read of the
    // method — says whether this decoration is still the installed one.
    if (Object.getOwnPropertyDescriptor(seam, 'spawn')?.value !== mapped) return
    Reflect.deleteProperty(seam, 'spawn')
  }
}
