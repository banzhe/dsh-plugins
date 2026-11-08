/**
 * Two-way translation between the host workspace path a session carries and the
 * POSIX path the same directory has inside the container.
 *
 * The model writes container paths (`/workspaces/repo/src`), and on Windows it
 * sometimes writes them after something win32 resolved the leading slash into a
 * drive (`F:\\workspaces\\repo\\src`); the host hands over native paths with
 * either separator style. Every function here is pure and idempotent: a value it
 * cannot attribute to the repository comes back unchanged.
 * @module @banzhe/dsh-devcontainer/paths
 */

import { posix, win32 } from 'node:path'
import type { RepoContainerSpec } from './types.ts'

const DRIVE_PREFIX = /^[A-Za-z]:[\\/]/
const UNC_PREFIX = /^\\\\/

/**
 * Whether a path is written in Windows form (drive letter or UNC share).
 * @param path - the path to classify.
 * @returns true for `F:\\x`, `f:/x`, and `\\\\server\\share`.
 */
export function isWindowsPath(path: string): boolean {
  return DRIVE_PREFIX.test(path) || UNC_PREFIX.test(path)
}

/** Replace every backslash with a forward slash. */
export function toPosixSlashes(path: string): string {
  return path.replaceAll('\\', '/')
}

/**
 * Whether a path is a POSIX-absolute path rather than a host path. A bare
 * `/workspaces/x` is what the model writes; the win32 module also calls it
 * absolute, so callers must consult the container mount point first.
 * @param path - the path to classify.
 * @returns true when the path starts at the POSIX root.
 */
export function isPosixAbsolute(path: string): boolean {
  return path.startsWith('/') && !isWindowsPath(path)
}

/**
 * Which path module owns this host root.
 * @param hostRoot - an absolute host directory.
 * @returns `'win32'` for a drive/UNC root, `'posix'` otherwise.
 */
export function hostPathStyle(hostRoot: string): 'win32' | 'posix' {
  return isWindowsPath(hostRoot) ? 'win32' : 'posix'
}

/** Normalize a host root into its native absolute spelling. */
export function normalizeHostRoot(hostRoot: string): string {
  return hostPathStyle(hostRoot) === 'win32' ? win32.resolve(hostRoot) : posix.resolve(hostRoot)
}

/** Join a POSIX relative path onto a host root using that root's separator style. */
export function joinHostRoot(hostRoot: string, relative: string): string {
  return hostPathStyle(hostRoot) === 'win32'
    ? win32.join(hostRoot, toPosixSlashes(relative))
    : posix.join(hostRoot, relative)
}

/**
 * The mount point the Dev Container specification uses when the configuration
 * omits `workspaceFolder`: `/workspaces/<basename of the repository root>`.
 * @param hostRoot - the absolute host repository root.
 * @returns the POSIX mount point.
 */
export function defaultContainerWorkspaceFolder(hostRoot: string): string {
  const base = hostPathStyle(hostRoot) === 'win32' ? win32.basename(hostRoot) : posix.basename(hostRoot)
  return posix.join('/workspaces', base === '' ? 'workspace' : base)
}

/**
 * Match a path against a container mount point.
 * @param path - candidate path, in either separator style.
 * @param folder - the container mount point.
 * @returns the POSIX remainder (`''` for the mount point itself), or undefined when the path is elsewhere.
 */
export function containerRemainder(path: string, folder: string): string | undefined {
  const normalized = posix.normalize(toPosixSlashes(path))
  const root = posix.normalize(toPosixSlashes(folder))
  if (normalized === root) return ''
  const prefix = root.endsWith('/') ? root : `${root}/`
  return normalized.startsWith(prefix) ? normalized.slice(prefix.length) : undefined
}

/** The spellings a model-supplied container path may have degraded into. */
function containerCandidates(path: string): string[] {
  const candidates = [toPosixSlashes(path)]
  if (DRIVE_PREFIX.test(path)) candidates.push(toPosixSlashes(path).slice(2))
  return candidates
}

/**
 * Whether the path names something inside the repository's container mount.
 * @param path - candidate path, in either separator style.
 * @param spec - the repository container specification.
 * @returns true when the path is the mount point or lies under it.
 */
export function isPathInsideContainer(path: string, spec: RepoContainerSpec): boolean {
  return containerCandidates(path).some(candidate => containerRemainder(candidate, spec.containerWorkspaceFolder) !== undefined)
}

/**
 * The POSIX relative path from a host root, or undefined when the path escapes it.
 * Comparison folds case on win32 (drive letters and Windows paths are
 * case-insensitive) and preserves it elsewhere.
 * @param path - candidate host path.
 * @param hostRoot - the absolute host repository root.
 * @returns the relative path (`''` for the root itself), or undefined when it is outside.
 */
export function relativeWithinHostRoot(path: string, hostRoot: string): string | undefined {
  const style = hostPathStyle(hostRoot)
  const module = style === 'win32' ? win32 : posix
  const absolutePath = toPosixSlashes(module.resolve(path))
  const absoluteRoot = toPosixSlashes(module.resolve(hostRoot))
  const folder = (value: string): string => (style === 'win32' ? value.toLowerCase() : value)
  const foldedPath = folder(absolutePath)
  const foldedRoot = folder(absoluteRoot)
  if (foldedPath === foldedRoot) return ''
  const prefix = foldedRoot.endsWith('/') ? foldedRoot : `${foldedRoot}/`
  if (!foldedPath.startsWith(prefix)) return undefined
  return absolutePath.slice(prefix.length)
}

/**
 * Join a relative path onto a mount point, in that mount's own style.
 *
 * A Dev Container mount is POSIX, so this is `posix.join` for every container.
 * A Docker Sandbox mounts the host directory under its own absolute path, so its
 * mount point can be a Windows path, and joining it as POSIX would produce the
 * mixed `F:\\repo/src` spelling no shell on either side accepts.
 * @param folder - the mount point.
 * @param relative - the relative path inside it.
 * @returns the joined path, using the mount point's separator style.
 */
export function joinMount(folder: string, relative: string): string {
  return isWindowsPath(folder) ? joinHostRoot(folder, relative) : posix.join(folder, toPosixSlashes(relative))
}

/**
 * Translate one model/plugin-supplied path into the container's POSIX view.
 * @param path - a host path, a mixed-separator host path, an already-container
 *   path, or a path relative to the mount point.
 * @param spec - the repository container specification.
 * @returns the POSIX container path; a path outside the repository comes back slash-normalized.
 */
export function toContainerPath(path: string, spec: RepoContainerSpec): string {
  const folder = spec.containerWorkspaceFolder
  if (path === '') return folder
  for (const candidate of containerCandidates(path)) {
    const remainder = containerRemainder(candidate, folder)
    if (remainder !== undefined) return remainder === '' ? folder : joinMount(folder, remainder)
  }
  if (!isWindowsPath(path) && !path.startsWith('/')) {
    // A relative path is resolved against the mount point, and one that climbs
    // out of it must not silently land somewhere else in the container: it comes
    // back unchanged so the failure is visible.
    const normalized = posix.normalize(toPosixSlashes(path))
    if (normalized === '..' || normalized.startsWith('../')) return path
    return normalized === '.' ? folder : joinMount(folder, normalized)
  }
  // A path that is absolute in some namespace is translated only when it is a
  // host path of this repository. A POSIX path this mount does not hold belongs
  // to the container's own namespace, and re-basing it onto the mount would
  // invent a path no caller named; it comes back unchanged so the mount check
  // can refuse it.
  const relative = relativeWithinHostRoot(path, spec.hostWorkspaceRoot)
  if (relative === undefined) return toPosixSlashes(path)
  return relative === '' ? folder : joinMount(folder, relative)
}

/**
 * Translate one container path back into the host path of the bind mount.
 * @param path - a container path, a drive-mangled container path, a host path, or a relative path.
 * @param spec - the repository container specification.
 * @returns the native host path inside the repository, or `path` unchanged when it is not container-side.
 */
export function toHostPath(path: string, spec: RepoContainerSpec): string {
  for (const candidate of containerCandidates(path)) {
    const remainder = containerRemainder(candidate, spec.containerWorkspaceFolder)
    if (remainder === undefined) continue
    return remainder === '' ? normalizeHostRoot(spec.hostWorkspaceRoot) : joinHostRoot(spec.hostWorkspaceRoot, remainder)
  }
  return path
}
