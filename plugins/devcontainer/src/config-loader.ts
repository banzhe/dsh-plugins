/**
 * Repository-level Dev Container discovery and parsing.
 *
 * Discovery walks the ancestors of whatever directory a tool call arrives with
 * and takes the nearest repository declaration. Three shapes are honoured, in
 * this order:
 *
 * 1. `.dsh/devcontainer.json` and `.dsh/docker.json` — the lightweight form this
 *    Bundle adds: it may name an already-running `container` instead of asking
 *    the Dev Container CLI to build one.
 * 2. `.devcontainer/devcontainer.json` — the Dev Container specification.
 * 3. `.devcontainer.json` — the single-file variant of the same specification.
 *
 * @module @banzhe/dsh-devcontainer/config-loader
 */

import { readFileSync, statSync } from 'node:fs'
import { dirname, join, posix } from 'node:path'
import { parseJsonc } from './jsonc.ts'
import {
  defaultContainerWorkspaceFolder,
  isPathInsideContainer,
  isWindowsPath,
  normalizeHostRoot,
  relativeWithinHostRoot,
  toPosixSlashes,
} from './paths.ts'
import { CONTAINER_OPTION_DEFAULTS } from './options.ts'
import type { ContainerCli, ContainerOptions, RepoContainerSpec } from './types.ts'

/** One repository-level container configuration file. */
export interface ConfigFileCandidate {
  /** Path relative to the repository root. */
  readonly relativePath: string
}

/** The configuration files to probe in each ancestor directory, most specific first. */
export const CONFIG_CANDIDATES: readonly ConfigFileCandidate[] = [
  { relativePath: '.dsh/devcontainer.json' },
  { relativePath: '.dsh/docker.json' },
  { relativePath: '.devcontainer/devcontainer.json' },
  { relativePath: '.devcontainer.json' },
]

/** Reads a file, or returns undefined when it is absent or unreadable. */
export type ReadTextFile = (path: string) => string | undefined

/** The filesystem read discovery uses unless a caller supplies one. */
export const readTextFile: ReadTextFile = (path) => {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return undefined
  }
}

/** One configuration file found by the ancestor walk. */
export interface FoundConfig {
  /** Absolute host path of the configuration file. */
  readonly configPath: string
  /** Absolute host path of the repository root that owns it. */
  readonly hostRoot: string
}

/** Options a caller adds on top of {@link ContainerOptions} for one lookup. */
export interface LocateOptions extends Partial<ContainerOptions> {
  /** Directory relative paths resolve against, and the fallback discovery start. */
  readonly cwd?: string | undefined
}

const MAX_ANCESTOR_DEPTH = 64

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

function asBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined
}

function asStringMap(value: unknown): Record<string, string> | undefined {
  const record = asRecord(value)
  if (record === undefined) return undefined
  const entries: [string, string][] = []
  for (const [key, entry] of Object.entries(record)) {
    if (typeof entry === 'string') entries.push([key, entry])
    else if (typeof entry === 'number' || typeof entry === 'boolean') entries.push([key, String(entry)])
  }
  return entries.length === 0 ? undefined : Object.fromEntries(entries)
}

function asCli(value: unknown): ContainerCli | undefined {
  return value === 'auto' || value === 'devcontainer' || value === 'docker' || value === 'sbx' ? value : undefined
}

/**
 * Build one specification from a configuration file's text.
 *
 * A declared `workspaceFolder` wins over the specification's default mount
 * point, and both must be POSIX: a Windows-shaped value would produce a
 * container path no shell in the container could enter.
 * @param input - the repository root, the configuration path, its text, and the row's defaults.
 * @returns the resolved specification.
 * @throws Error when the document is unparsable or a field is unusable.
 */
export function buildSpec(input: {
  hostRoot: string
  configPath: string
  text: string
  options?: Partial<ContainerOptions> | undefined
}): RepoContainerSpec {
  let parsed: unknown
  try {
    parsed = parseJsonc(input.text)
  } catch (error) {
    throw new Error(`devcontainer: cannot parse ${input.configPath}: ${(error as Error).message}`)
  }
  const record = asRecord(parsed) ?? {}
  const hostRoot = normalizeHostRoot(input.hostRoot)
  const declaredFolder = asString(record.workspaceFolder)
  const containerWorkspaceFolder = declaredFolder === undefined
    ? defaultContainerWorkspaceFolder(hostRoot)
    : toPosixSlashes(declaredFolder).replace(/\/+$/, '')
  if (!posix.isAbsolute(containerWorkspaceFolder)) {
    throw new Error(`devcontainer: ${input.configPath}: workspaceFolder must be an absolute POSIX path, got ${JSON.stringify(declaredFolder)}`)
  }
  const remoteEnv = asStringMap(record.remoteEnv)
  const container = asString(record.container) ?? asString(record.containerName)
  const composeService = asString(record.service)
  const remoteUser = asString(record.remoteUser)
  const sandbox = asString(record.sandbox) ?? asString(record.sandboxName)
  const shell = asString(record.shell) ?? input.options?.shell ?? CONTAINER_OPTION_DEFAULTS.shell
  const cli = asCli(record.cli) ?? input.options?.cli ?? CONTAINER_OPTION_DEFAULTS.cli
  const ensureUp = asBoolean(record.ensureUp) ?? input.options?.ensureUp ?? CONTAINER_OPTION_DEFAULTS.ensureUp
  const containerTimeoutMs = input.options?.containerTimeoutMs ?? CONTAINER_OPTION_DEFAULTS.containerTimeoutMs
  return {
    hostWorkspaceRoot: hostRoot,
    containerWorkspaceFolder,
    configPath: input.configPath,
    ...container === undefined ? {} : { container },
    ...composeService === undefined ? {} : { composeService },
    ...remoteUser === undefined ? {} : { remoteUser },
    ...remoteEnv === undefined ? {} : { remoteEnv },
    ...sandbox === undefined ? {} : { sandbox },
    shell,
    cli,
    ensureUp,
    containerTimeoutMs,
  }
}

/**
 * Walk the ancestors of one directory and return the nearest configuration file.
 * @param startDir - absolute host path of a file or directory inside the repository.
 * @param read - file reader; absent files return undefined.
 * @returns the found file and its repository root, or undefined when no ancestor declares one.
 */
export function findConfigFile(startDir: string, read: ReadTextFile = readTextFile): FoundConfig | undefined {
  let current = normalizeHostRoot(startDir)
  for (let depth = 0; depth < MAX_ANCESTOR_DEPTH; depth += 1) {
    for (const candidate of CONFIG_CANDIDATES) {
      const configPath = join(current, ...candidate.relativePath.split('/'))
      if (read(configPath) === undefined) continue
      return { configPath, hostRoot: current }
    }
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }
  return undefined
}


/** One cached specification and the file state it was parsed from. */
interface CachedSpec {
  readonly spec: RepoContainerSpec
  /** `mtimeMs` of the configuration file at parse time; undefined when it could not be read. */
  readonly mtimeMs: number | undefined
}

/** How many repositories the container-path index keeps before dropping the oldest. */
const MAX_DISCOVERED = 64

/**
 * Last-modified time of one file, or undefined when it cannot be stat'd.
 * @param path - absolute path of the file.
 * @returns the mtime in milliseconds.
 */
export function statMtimeMs(path: string): number | undefined {
  try {
    return statSync(path).mtimeMs
  } catch {
    return undefined
  }
}

/**
 * Per-context cache of discovered specifications.
 *
 * Every shell command and every filesystem call asks for the repository
 * specification, so the ancestor walk is memoized per directory and the parse
 * per option signature. Two rules keep the cache honest:
 *
 * - a directory that declares nothing is NOT remembered: a person who adds
 *   `.dsh/docker.json` after being told the repository declares none must be
 *   picked up by the very next command;
 * - a parse is remembered together with the configuration file's `mtimeMs` and
 *   re-used only while the file still exists with that exact mtime, so editing or
 *   deleting a declaration takes effect immediately.
 */
export class RepoContainerRegistry {
  /** Directory → found config. Only hits are remembered. */
  private readonly directories = new Map<string, FoundConfig>()
  /** Option signature → parsed specification. */
  private readonly specifications = new Map<string, CachedSpec>()
  /** Configuration path → the parse it produced most recently. */
  private readonly latest = new Map<string, CachedSpec>()
  /** Every specification discovered so far, for container-path matching. */
  private readonly discovered: RepoContainerSpec[] = []

  /**
   * @param read - file reader; an absent file returns undefined.
   * @param mtime - file clock used to detect edits; undefined means "cannot tell".
   */
  constructor(
    private readonly read: ReadTextFile = readTextFile,
    private readonly mtime: (path: string) => number | undefined = statMtimeMs,
  ) {}

  /** Drop every cached discovery and parse. */
  reset(): void {
    this.directories.clear()
    this.specifications.clear()
    this.latest.clear()
    this.discovered.length = 0
  }

  /** Every specification discovered so far. */
  knownSpecs(): readonly RepoContainerSpec[] {
    return this.discovered
  }

  /**
   * Find the repository container specification that governs one path.
   *
   * Container paths carry no host ancestry, so the caller's host `cwd` is asked
   * first: it reaches the repository from disk without any earlier call, and it
   * separates two repositories that happen to mount at the same container folder.
   * @param path - the path a tool call carries: a host path, a container path, or a relative path.
   * @param options - the calling row's defaults plus the directory relative paths resolve against.
   * @returns the governing specification, or undefined when the path belongs to no Dev Container repository.
   */
  locate(path: string | undefined, options: LocateOptions = {}): RepoContainerSpec | undefined {
    const cwd = options.cwd
    const target = path === undefined || path === '' ? cwd : path
    if (target === undefined || target === '') return undefined
    if (cwd !== undefined && cwd !== '' && cwd !== target && !isWindowsPath(target)) {
      const fromCwd = this.discover(cwd, options)
      if (fromCwd !== undefined
        && isPathInsideContainer(target, fromCwd)
        && relativeWithinHostRoot(target, fromCwd.hostWorkspaceRoot) === undefined) {
        return fromCwd
      }
    }
    const stale: string[] = []
    const match = this.discovered.find((spec) => {
      if (!isPathInsideContainer(target, spec)) return false
      if (this.isStale(spec)) {
        stale.push(spec.configPath)
        return false
      }
      return true
    })
    for (const configPath of stale) this.forgetConfig(configPath)
    if (match !== undefined) return match
    const direct = this.discover(target, options)
    if (direct !== undefined) return direct
    if (cwd === undefined || cwd === target) return undefined
    const fromCwd = this.discover(cwd, options)
    if (fromCwd === undefined) return undefined
    // Only claim the path for the cwd's repository when it really is inside it:
    // an unrelated absolute host path must keep running on the host.
    return this.belongsTo(target, fromCwd) ? fromCwd : undefined
  }

  /** Whether one path lies inside a specification's host root or container mount. */
  private belongsTo(path: string, spec: RepoContainerSpec): boolean {
    return isPathInsideContainer(path, spec) || relativeWithinHostRoot(path, spec.hostWorkspaceRoot) !== undefined
  }

  /**
   * Discover from one path's ancestry, memoized per directory.
   * @param start - a file or directory inside the repository.
   * @param options - the calling row's defaults.
   * @returns the specification, or undefined when no ancestor declares one.
   */
  discover(start: string, options: LocateOptions = {}): RepoContainerSpec | undefined {
    const found = this.findConfig(start)
    if (found === undefined) return undefined
    return this.specFor(found, options)
  }

  /** The cached hit for one start directory, or a fresh walk. Misses are not cached. */
  private findConfig(start: string): FoundConfig | undefined {
    const absolute = start.startsWith('/') || start.startsWith('\\\\') || /^[A-Za-z]:[\\/]/.test(start)
    if (!absolute) return findConfigFile(start, this.read)
    const cached = this.directories.get(start)
    if (cached !== undefined) return cached
    const found = findConfigFile(start, this.read)
    if (found !== undefined) this.directories.set(start, found)
    return found
  }

  /** Parse one found file for one option signature, re-using the parse only while the file is unchanged. */
  private specFor(found: FoundConfig, options: LocateOptions): RepoContainerSpec | undefined {
    const signature = [
      found.configPath,
      options.cli ?? '',
      options.shell ?? '',
      options.ensureUp ?? '',
      options.containerTimeoutMs ?? '',
      options.requireContainer ?? '',
    ].join('\u0000')
    const cached = this.specifications.get(signature)
    if (cached !== undefined && !this.isStale(cached.spec)) return cached.spec
    if (cached !== undefined) this.forgetConfig(found.configPath)
    const text = this.read(found.configPath)
    if (text === undefined) {
      this.forgetConfig(found.configPath)
      return undefined
    }
    const entry: CachedSpec = {
      spec: buildSpec({ hostRoot: found.hostRoot, configPath: found.configPath, text, options }),
      mtimeMs: this.mtime(found.configPath),
    }
    this.specifications.set(signature, entry)
    this.latest.set(found.configPath, entry)
    this.remember(entry.spec)
    return entry.spec
  }

  /** Whether the file behind one specification is gone or has been edited since it was parsed. */
  private isStale(spec: RepoContainerSpec): boolean {
    const entry = this.latest.get(spec.configPath)
    if (entry === undefined) return true
    const clock = this.mtime(spec.configPath)
    return clock === undefined || clock !== entry.mtimeMs
  }

  /** Keep the container-path index free of duplicates and bounded. */
  private remember(spec: RepoContainerSpec): void {
    const index = this.discovered.findIndex(known => known.configPath === spec.configPath && known.cli === spec.cli)
    if (index >= 0) this.discovered[index] = spec
    else this.discovered.push(spec)
    while (this.discovered.length > MAX_DISCOVERED) this.discovered.shift()
  }

  /** Forget every trace of one configuration file, so the next call walks the disk again. */
  private forgetConfig(configPath: string): void {
    for (const [start, found] of this.directories) {
      if (found.configPath === configPath) this.directories.delete(start)
    }
    for (const [signature, entry] of this.specifications) {
      if (entry.spec.configPath === configPath) this.specifications.delete(signature)
    }
    this.latest.delete(configPath)
    const index = this.discovered.findIndex(known => known.configPath === configPath)
    if (index >= 0) this.discovered.splice(index, 1)
  }
}
