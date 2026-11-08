/**
 * Finding or starting the repository's container.
 *
 * Three drivers, in the order `cli: 'auto'` tries them:
 *
 * 1. an explicit `container` / `containerName` from the configuration;
 * 2. a running container the Dev Container CLI labelled with
 *    `devcontainer.local_folder=<host root>`, which needs no CLI of our own;
 * 3. `devcontainer up`, which builds and starts the container from the
 *    configuration and reports the container id it produced.
 *
 * @module @banzhe/dsh-devcontainer/container
 */

import type { ContainerRun } from './exec.ts'
import { toPosixSlashes } from './paths.ts'
import { resolveSbxTarget } from './sbx.ts'
import type { RepoContainerSpec } from './types.ts'

/** Where agent commands run. */
export type ContainerTarget =
  | { readonly kind: 'docker'; readonly containerId: string; readonly workspaceFolder: string }
  | { readonly kind: 'devcontainer-cli'; readonly workspaceFolder: string }
  | { readonly kind: 'sbx'; readonly sandboxName: string; readonly workspaceFolder: string }

/** Label the Dev Container CLI stamps on every container it creates. */
export const CONTAINER_FOLDER_LABEL = 'devcontainer.local_folder'

const PS_FORMAT = '{{.ID}}\t{{.Label "devcontainer.local_folder"}}'

/** Compare two host folders as one repository, folding separators and win32 case. */
function sameFolder(left: string, right: string): boolean {
  return toPosixSlashes(left).replace(/\/+$/, '').toLowerCase()
    === toPosixSlashes(right).replace(/\/+$/, '').toLowerCase()
}

/**
 * Find the running container the Dev Container CLI started for this repository.
 * @param spec - the repository container specification.
 * @param run - the CLI runner.
 * @param signal - cancellation of the probe.
 * @returns the container id, or undefined when none is running (or Docker is absent).
 */
export async function findRunningContainer(
  spec: RepoContainerSpec,
  run: ContainerRun,
  signal?: AbortSignal,
): Promise<string | undefined> {
  const result = await run(
    ['docker', 'ps', '--filter', `label=${CONTAINER_FOLDER_LABEL}`, '--format', PS_FORMAT],
    { ...signal === undefined ? {} : { signal }, timeoutMs: spec.containerTimeoutMs },
  )
  if (result.exitCode !== 0) return undefined
  for (const line of result.stdout.split('\n')) {
    const [id, folder] = line.split('\t')
    if (id === undefined || folder === undefined) continue
    if (id.trim() === '' || folder.trim() === '') continue
    if (sameFolder(folder.trim(), spec.hostWorkspaceRoot)) return id.trim()
  }
  return undefined
}

/**
 * Read the container id out of `devcontainer up` output (its last JSON line).
 * @param stdout - the CLI's standard output.
 * @returns the container id, or undefined when the output carries none.
 */
export function parseUpOutput(stdout: string): string | undefined {
  const lines = stdout.split('\n').map(line => line.trim()).filter(line => line.startsWith('{'))
  for (const line of lines.reverse()) {
    try {
      const parsed: unknown = JSON.parse(line)
      if (typeof parsed === 'object' && parsed !== null) {
        const { containerId } = parsed as { containerId?: unknown }
        if (typeof containerId === 'string' && containerId !== '') return containerId
      }
    } catch {
      // A non-JSON line is progress output, not the result envelope.
    }
  }
  return undefined
}

/**
 * Build and start the repository's container through the Dev Container CLI.
 * @param spec - the repository container specification.
 * @param run - the CLI runner.
 * @param signal - cancellation of the CLI call.
 * @returns the produced container id when the CLI reported one.
 * @throws Error when the CLI failed and reported no container.
 */
export async function startContainer(
  spec: RepoContainerSpec,
  run: ContainerRun,
  signal?: AbortSignal,
): Promise<{ containerId?: string; workspaceFolder: string }> {
  const result = await run(
    ['devcontainer', 'up', '--workspace-folder', spec.hostWorkspaceRoot],
    { ...signal === undefined ? {} : { signal }, timeoutMs: spec.containerTimeoutMs },
  )
  const containerId = parseUpOutput(result.stdout)
  if (result.exitCode !== 0 && containerId === undefined) {
    const detail = (result.stderr.trim() || result.stdout.trim() || 'no output').split('\n').slice(-3).join(' ')
    throw new Error(`devcontainer: "${spec.configPath}": devcontainer up failed for ${spec.hostWorkspaceRoot}: ${detail}`)
  }
  return {
    ...containerId === undefined ? {} : { containerId },
    workspaceFolder: spec.hostWorkspaceRoot,
  }
}

/**
 * Resolve the container agent commands run in.
 *
 * `cli: 'sbx'` is not a container at all: a Docker Sandbox mounts the host
 * workspace at its own absolute path, so it is discovered and started by
 * {@link resolveSbxTarget} instead of by the Dev Container drivers below.
 * @param spec - the repository container specification.
 * @param run - the CLI runner.
 * @param signal - cancellation of the probe / start sequence.
 * @returns the docker target when a container id is known, else the CLI or sandbox target.
 * @throws Error when `cli: 'docker'` was demanded and no container is running, or `sbx` cannot be prepared.
 */
export async function resolveContainerTarget(
  spec: RepoContainerSpec,
  run: ContainerRun,
  signal?: AbortSignal,
): Promise<ContainerTarget> {
  if (spec.cli === 'sbx') return await resolveSbxTarget(spec, run, signal)
  if (spec.container !== undefined) {
    return { kind: 'docker', containerId: spec.container, workspaceFolder: spec.containerWorkspaceFolder }
  }
  if (spec.cli !== 'devcontainer') {
    const running = await findRunningContainer(spec, run, signal)
    if (running !== undefined) {
      return { kind: 'docker', containerId: running, workspaceFolder: spec.containerWorkspaceFolder }
    }
    if (spec.cli === 'docker') {
      throw new Error('devcontainer: "' + spec.configPath + '": cli is "docker" but no running container carries '
        + `${CONTAINER_FOLDER_LABEL}=${spec.hostWorkspaceRoot}; start it or set cli: "auto"`)
    }
  }
  if (spec.ensureUp) {
    const started = await startContainer(spec, run, signal)
    if (started.containerId !== undefined) {
      return {
        kind: 'docker',
        containerId: started.containerId,
        workspaceFolder: spec.containerWorkspaceFolder,
      }
    }
    return { kind: 'devcontainer-cli', workspaceFolder: started.workspaceFolder }
  }
  return { kind: 'devcontainer-cli', workspaceFolder: spec.hostWorkspaceRoot }
}
