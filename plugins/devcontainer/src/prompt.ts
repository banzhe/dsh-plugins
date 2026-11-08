/**
 * The Linux container context: the one place the model learns it is not on
 * Windows.
 *
 * `WorkingDirectoryService` owns the `working-directory:current` context and
 * rewrites it after `next()`; a listener registered with `{ prepend: true }`
 * runs first and therefore sees that final text, which is what this module
 * replaces.
 * @module @banzhe/dsh-devcontainer/prompt
 */

import type { PromptAssembly } from '@deepseek-ai/dsh-system-prompt'
import { win32, posix } from 'node:path'
import { hostPathStyle } from './paths.ts'
import type { RepoContainerSpec } from './types.ts'

/** Name of the context `WorkingDirectoryService` contributes. */
export const WORKING_DIRECTORY_CONTEXT = 'working-directory:current'

/**
 * The label the prompt names the container by: the explicit container, its
 * compose service, or the repository directory name.
 * @param spec - the repository container specification.
 * @returns a short human label.
 */
export function containerLabel(spec: RepoContainerSpec): string {
  if (spec.container !== undefined) return spec.container
  if (spec.composeService !== undefined) return `service ${spec.composeService}`
  const base = hostPathStyle(spec.hostWorkspaceRoot) === 'win32'
    ? win32.basename(spec.hostWorkspaceRoot)
    : posix.basename(spec.hostWorkspaceRoot)
  return base === '' ? spec.hostWorkspaceRoot : base
}

/**
 * The replacement text for `working-directory:current`.
 * @param containerWorkdir - POSIX directory the command runs in.
 * @param spec - the repository container specification.
 * @param hostWorkdir - the host directory that mount corresponds to.
 * @returns the assembled context text.
 */
export function containerContextText(
  containerWorkdir: string,
  spec: RepoContainerSpec,
  hostWorkdir: string,
): string {
  return `Current working directory: "${containerWorkdir}".\n`
    + `Runtime environment: Linux Docker container (${containerLabel(spec)}) mounted from host directory "${hostWorkdir}". `
    + 'The active shell is Linux bash (/bin/bash). Always write POSIX/Linux commands and never PowerShell commands.'
}

/**
 * The replacement text for `working-directory:current` under a `(sbx)` preset.
 *
 * A sandbox needs no declaration, so this text never explains a refusal: it names
 * the sandbox and states the one fact the model cannot infer — that the paths are
 * the host's own, because `sbx` mounts a workspace at the same absolute path.
 * @param containerWorkdir - the directory the command runs in.
 * @param sandboxName - the Docker Sandbox it runs in.
 * @param hostWorkdir - the host directory that sandbox mounts.
 * @returns the assembled context text.
 */
export function sbxContextText(
  containerWorkdir: string,
  sandboxName: string,
  hostWorkdir: string,
): string {
  return `Current working directory: "${containerWorkdir}".\n`
    + `Runtime environment: Linux Docker Sandbox "${sandboxName}" (sbx) mounting host directory "${hostWorkdir}" at the same absolute path. `
    + 'The active shell is Linux bash (/bin/bash). Always write POSIX/Linux commands and never PowerShell commands.'
}

/**
 * The replacement text for `working-directory:current` when a `(devContainer)`
 * preset meets a repository that declares no container.
 *
 * The instruction is explicit about the two things the model must not do: retry
 * the command or the file access, and describe the failure as if it were temporary. It also says
 * which language to report in, because the person on the other side chose a
 * Chinese-labelled preset.
 * @param hostWorkdir - the host directory the session is working in.
 * @param preset - the derived preset id the session runs.
 * @returns the assembled context text.
 */
export function missingContainerContextText(hostWorkdir: string, preset: string): string {
  return `Current working directory: "${hostWorkdir}".\n`
    + `Runtime environment: this session runs the (devContainer) preset "${preset}", but the working directory "${hostWorkdir}" declares no Dev Container configuration.\n`
    + 'Looked for .devcontainer/devcontainer.json, .devcontainer.json, .dsh/devcontainer.json, and .dsh/docker.json in that directory and every ancestor directory.\n'
    + 'Every shell command and every file operation is BLOCKED: the shell tool refuses to run commands on the host, the file tools refuse to read or write host files, so nothing has executed and nothing will execute until this repository gets a container configuration.\n'
    + 'Tell the user this immediately, in Chinese: the (devContainer) preset requires a container configuration for this repository, and there are two ways out — add one of those files (for example .devcontainer/devcontainer.json, or .dsh/docker.json pointing at a container that is already running), or switch back to an ordinary preset (标准模式 / 委派模式).'
    + ' Do not retry shell commands or file operations while this stands, and do not describe it as a temporary failure.'
}

/**
 * Replace (or add) the working-directory context of one assembly.
 * @param assembly - the mutable assembly the waterfall produced.
 * @param text - the container context text.
 * @returns true when the assembly was changed.
 */
export function applyContainerContext(assembly: PromptAssembly, text: string): boolean {
  const contribution = assembly.contexts.find(entry => entry.name === WORKING_DIRECTORY_CONTEXT)
  if (contribution === undefined) {
    assembly.contexts.unshift({ name: WORKING_DIRECTORY_CONTEXT, text, interpolate: false })
    return true
  }
  contribution.text = text
  contribution.interpolate = false
  return true
}

/**
 * Read the host directory back out of an assembly that carries no agent.
 * @param assembly - the assembly to read.
 * @returns the host directory the `working-directory:current` context names, or undefined.
 */
export function hostDirectoryFromContext(assembly: PromptAssembly): string | undefined {
  const contribution = assembly.contexts.find(entry => entry.name === WORKING_DIRECTORY_CONTEXT)
  if (contribution === undefined) return undefined
  const match = /Current working directory: (".*?")\./.exec(contribution.text)
  if (match === null) return undefined
  try {
    const parsed: unknown = JSON.parse(match[1] as string)
    return typeof parsed === 'string' ? parsed : undefined
  } catch {
    return undefined
  }
}
