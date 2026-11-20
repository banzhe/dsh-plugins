/**
 * Filesystem provider for one POSIX SSH host that still reads this machine's own
 * AGENTS.md and skills trees from node:fs. Everything else is a helper request.
 */
import { createReadStream } from 'node:fs'
import type { BigIntStats } from 'node:fs'
import { lstat as lstatPath, open, readdir, readFile, realpath, stat as statPath } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { FS_ERROR_CODES, FileSystem, FsError, FsTargetKey, FsVersion, fsErrorFromErrno } from '@deepseek-ai/dsh-fs'
import { expandHomePath, resolveAgentsHome, resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import type {
  FsDeleteOutcome, FsDirEntry, FsEditOutcome, FsEditRequest, FsErrorCode, FsInfo, FsPathInfo,
  FsMoveOutcome, FsTarget, FsWriteIntent, FsWriteOutcome,
} from '@deepseek-ai/dsh-fs'
import { z } from 'zod'
import { RemoteOperationError } from './protocol.ts'
import {
  deleteResultSchema, editResultSchema, entriesSchema, infoSchema, moveResultSchema, pathInfoSchema,
  targetSchema, textStreamIdSchema, writeResultSchema,
} from './schemas.ts'

/** Per-call sandbox policy the remote helper fences a mutation with. */
type SandboxPolicy = NonNullable<Parameters<FileSystem['writeText']>[4]>
/** Deployment default sandbox mode. */
type SandboxMode = NonNullable<FileSystem['sandboxMode']>

/** Shared agent instructions each root places directly under itself. */
const AGENTS_FILE = 'AGENTS.md'
/** Directory under each root that holds discovered skills. */
const SKILLS_DIRECTORY = 'skills'
/** File each skill directory locates its instructions in. */
const SKILL_FILE = 'SKILL.md'
/** Subdirectory of a skill whose whole subtree stays readable here. */
const REFERENCES_DIRECTORY = 'references'

const errorCodes = new Set<string>(FS_ERROR_CODES)

/** What one absolute path is to this provider: host-readable, host-denied, or remote. */
type Route =
  | { readonly kind: 'host' }
  | { readonly kind: 'denied' }
  | { readonly kind: 'remote' }

/**
 * Filesystem provider paired with the SSH subprocess and sandbox providers. Only the
 * host's AGENTS.md files, skills roots, skill directories, their SKILL.md files and
 * their `references/` subtrees reach node:fs; every other path is a helper request.
 */
export class SshPosixFileSystem extends FileSystem {
  static inject = ['ssh', 'sandboxPolicy']

  override get sandboxMode(): SandboxMode { return this.sandboxPolicy.defaultMode }

  /**
   * The sandbox policy service, read through its published shape: this package
   * depends on dsh-fs, not on the sandbox-policy package that declares the row.
   */
  private get sandboxPolicy(): { defaultMode: SandboxMode; resolve(): SandboxPolicy } {
    const { sandboxPolicy } = this.ctx as unknown as { sandboxPolicy: { defaultMode: SandboxMode; resolve(): SandboxPolicy } }
    return sandboxPolicy
  }

  override async resolve(path: string, opts?: { cwd?: string; signal?: AbortSignal }): Promise<FsTarget> {
    const displayPath = absoluteHostPath(opts?.cwd, path)
    const route = routeOf(displayPath)
    if (route.kind === 'denied') throw hostReadDenied(displayPath)
    if (route.kind === 'remote') return await this.call('fs.resolve', { path, cwd: opts?.cwd }, targetSchema, opts?.signal) as FsTarget
    const targetKey = await hostIdentity(displayPath, opts?.signal)
    return { targetKey: FsTargetKey(targetKey), displayPath }
  }

  override processPath(target: FsTarget): string { return String(target.targetKey) }

  override fileUrl(target: FsTarget): string { return pathToFileURL(this.processPath(target)).href }

  override contains(parent: FsTarget, child: FsTarget): boolean {
    const path = relative(this.processPath(parent), this.processPath(child))
    return path === '' || (path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path))
  }

  override async stat(target: FsTarget, signal?: AbortSignal): Promise<FsInfo | undefined> {
    const route = routeOf(target.displayPath)
    if (route.kind === 'denied') throw hostReadDenied(target.displayPath)
    if (route.kind === 'remote') return await this.call('fs.stat', { target }, infoSchema.nullable(), signal) as FsInfo | null ?? undefined
    throwIfAborted(signal, 'stat')
    const info = await probe(this.processPath(target), target.displayPath, false)
    if (info === undefined) return undefined
    return { version: versionOf(info), type: typeOf(info), size: Number(info.size) }
  }

  override async lstat(path: string, opts?: { cwd?: string }, signal?: AbortSignal): Promise<FsPathInfo | undefined> {
    const displayPath = absoluteHostPath(opts?.cwd, path)
    const route = routeOf(displayPath)
    if (route.kind === 'denied') throw hostReadDenied(displayPath)
    if (route.kind === 'remote') return await this.call('fs.lstat', { path, cwd: opts?.cwd }, pathInfoSchema.nullable(), signal) as FsPathInfo | null ?? undefined
    throwIfAborted(signal, 'lstat')
    const info = await probe(displayPath, displayPath, true)
    if (info === undefined) return undefined
    return { version: versionOf(info), type: info.isSymbolicLink() ? 'symlink' : typeOf(info), size: Number(info.size) }
  }

  override async readText(target: FsTarget, signal?: AbortSignal): Promise<string> {
    const route = routeOf(target.displayPath)
    if (route.kind === 'denied') throw hostReadDenied(target.displayPath)
    if (route.kind === 'remote') return this.call('fs.readText', { target }, z.string(), signal)
    return textOf(this.processPath(target), target.displayPath, signal)
  }

  override async streamText(target: FsTarget, signal?: AbortSignal): Promise<AsyncIterable<string>> {
    const route = routeOf(target.displayPath)
    if (route.kind === 'denied') throw hostReadDenied(target.displayPath)
    if (route.kind === 'remote') {
      const id = await this.call('fs.stream', { target }, textStreamIdSchema, signal)
      const call = this.call.bind(this)
      return (async function* () {
        let ended = false
        try {
          while (!ended) {
            signal?.throwIfAborted()
            const next = await call('fs.next', { id }, z.object({ done: z.boolean(), value: z.string() }).strict(), signal)
            ended = next.done
            if (next.value.length > 0) yield next.value
          }
        } finally {
          if (!ended) await call('fs.streamClose', { id }, z.null()).catch(() => {})
        }
      })()
    }
    return hostText(this.processPath(target), target.displayPath, signal)
  }

  override async readBytes(target: FsTarget, signal: AbortSignal | undefined, maxBytes: number): Promise<Uint8Array> {
    const route = routeOf(target.displayPath)
    if (route.kind === 'denied') throw hostReadDenied(target.displayPath)
    if (route.kind === 'remote') return Buffer.from(await this.call('fs.readBytes', { target, maxBytes }, z.base64(), signal), 'base64')
    return await bytesOf(this.processPath(target), target.displayPath, signal, maxBytes)
  }

  override async readByteRange(target: FsTarget, range: { offset: number; length: number }, signal?: AbortSignal): Promise<Uint8Array> {
    const route = routeOf(target.displayPath)
    if (route.kind === 'denied') throw hostReadDenied(target.displayPath)
    if (route.kind === 'remote') return Buffer.from(await this.call('fs.readRange', { target, ...range }, z.base64(), signal), 'base64')
    return await bytesInRange(this.processPath(target), target.displayPath, range, signal)
  }

  override async listDir(target: FsTarget, signal?: AbortSignal): Promise<FsDirEntry[]> {
    const route = routeOf(target.displayPath)
    if (route.kind === 'denied') throw hostReadDenied(target.displayPath)
    if (route.kind === 'remote') return await this.call('fs.list', { target }, entriesSchema, signal) as FsDirEntry[]
    return await hostEntries(this.processPath(target), target.displayPath, signal)
  }

  override async writeText(
    target: FsTarget, content: string, expected?: FsWriteIntent, signal?: AbortSignal, sandboxPolicy?: SandboxPolicy,
  ): Promise<FsWriteOutcome> {
    this.assertRemote(target)
    const policy = sandboxPolicy ?? this.sandboxPolicy.resolve()
    return await this.call('fs.write', { target, content, expected, policy }, writeResultSchema, signal) as FsWriteOutcome
  }

  override async editText(
    target: FsTarget, edit: FsEditRequest, expected?: { version: FsVersion },
    signal?: AbortSignal, sandboxPolicy?: SandboxPolicy,
  ): Promise<FsEditOutcome> {
    this.assertRemote(target)
    const policy = sandboxPolicy ?? this.sandboxPolicy.resolve()
    return await this.call('fs.edit', { target, edit, expected, policy }, editResultSchema, signal) as FsEditOutcome
  }

  override async patchText(
    target: FsTarget, hunks: Parameters<FileSystem['patchText']>[1], expected?: { version: FsVersion },
    signal?: AbortSignal, sandboxPolicy?: SandboxPolicy,
  ): Promise<FsEditOutcome> {
    this.assertRemote(target)
    const policy = sandboxPolicy ?? this.sandboxPolicy.resolve()
    return await this.call('fs.patch', { target, hunks, expected, policy }, editResultSchema, signal) as FsEditOutcome
  }

  override async deleteFile(
    target: FsTarget, expected?: { version: FsVersion }, signal?: AbortSignal, sandboxPolicy?: SandboxPolicy,
  ): Promise<FsDeleteOutcome> {
    this.assertRemote(target)
    const policy = sandboxPolicy ?? this.sandboxPolicy.resolve()
    return this.call('fs.delete', { target, expected, policy }, deleteResultSchema, signal)
  }

  override async moveFile(
    source: FsTarget, destination: FsTarget, options: Parameters<FileSystem['moveFile']>[2],
    signal?: AbortSignal, sandboxPolicy?: SandboxPolicy,
  ): Promise<FsMoveOutcome> {
    this.assertRemote(source, destination)
    const policy = sandboxPolicy ?? this.sandboxPolicy.resolve()
    return await this.call('fs.move', { source, destination, options, policy }, moveResultSchema, signal) as FsMoveOutcome
  }

  /** Refuse any mutation that would land on this machine instead of the SSH host. */
  private assertRemote(...targets: FsTarget[]): void {
    for (const target of targets) {
      if (routeOf(target.displayPath).kind !== 'remote') throw hostWriteDenied(target.displayPath)
    }
  }

  private async call<T>(method: string, params: unknown, schema: z.ZodType<T>, signal?: AbortSignal): Promise<T> {
    try { return await this.ctx.ssh.request(method, params, schema, signal) } catch (error) {
      if (error instanceof RemoteOperationError && error.code !== undefined && errorCodes.has(error.code)) {
        throw new FsError(error.message, error.code as FsErrorCode, { cause: error })
      }
      throw new FsError(error instanceof Error ? error.message : String(error), signal?.aborted ? 'FS_ABORTED' : 'FS_IO_ERROR', { cause: error })
    }
  }
}

/**
 * Classify one absolute path. A normalized path outside both roots, and the roots
 * themselves, stay remote; only the shapes the host genuinely owns are local.
 * @param path - absolute path, already normalized against the host path rules.
 * @returns whether this machine or the SSH host owns the path.
 */
function routeOf(path: string): Route {
  for (const root of localRoots()) {
    const child = relative(root, path)
    if (child === '..' || child.startsWith(`..${sep}`) || isAbsolute(child)) continue
    if (child === AGENTS_FILE) return { kind: 'host' }
    if (child === SKILLS_DIRECTORY) return { kind: 'host' }
    if (!child.startsWith(`${SKILLS_DIRECTORY}${sep}`)) continue
    const segments = child.slice(SKILLS_DIRECTORY.length + 1).split(sep)
    if (segments.length === 1) return { kind: 'host' }
    const component = segments[1]
    if (segments.length === 2 && component === SKILL_FILE) return { kind: 'host' }
    if (component === REFERENCES_DIRECTORY) return { kind: 'host' }
    return { kind: 'denied' }
  }
  return { kind: 'remote' }
}

/** The harness home and the shared agent configuration root of this machine, as DSH resolves them. */
function localRoots(): string[] {
  return [resolveDshHome(), resolveAgentsHome()]
}

/** Absolute host spelling of a caller path, with `..` normalized away before classification. */
function absoluteHostPath(cwd: string | undefined, path: string): string {
  return resolve(cwd ?? process.cwd(), expandHomePath(path))
}

/**
 * Identify one host path the way the local backend does, following symlinks.
 * @param path - absolute host path.
 * @param signal - cancels the lookup.
 * @returns the realpath, or the normalized path while it does not exist yet.
 */
async function hostIdentity(path: string, signal?: AbortSignal): Promise<string> {
  throwIfAborted(signal, 'resolve')
  try {
    return await realpath(path)
  } catch (error) {
    if (isAbsent(error)) return path
    throw fsErrorFromErrno('resolve', path, error)
  }
}

/** Metadata of one host path, or `undefined` when it or a parent segment is absent. */
async function probe(path: string, displayPath: string, noFollow: boolean): Promise<BigIntStats | undefined> {
  try {
    return noFollow ? await lstatPath(path, { bigint: true }) : await statPath(path, { bigint: true })
  } catch (error) {
    if (isAbsent(error)) return undefined
    throw fsErrorFromErrno('stat', displayPath, error)
  }
}

/** Opaque version token from high-resolution identity and freshness metadata. */
function versionOf(info: BigIntStats): FsVersion {
  return FsVersion(`${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`)
}

function typeOf(info: BigIntStats): FsInfo['type'] {
  if (info.isFile()) return 'file'
  if (info.isDirectory()) return 'directory'
  return 'other'
}

/**
 * One host text, streamed as it is read rather than held whole.
 *
 * The decoder is not fatal, so the text a caller assembles is what
 * `readFile(path, 'utf8')` would have produced, and `stream: true` keeps a
 * multi-byte character whole when a chunk boundary falls inside it.
 */
async function* hostText(path: string, displayPath: string, signal?: AbortSignal): AsyncIterable<string> {
  const decoder = new TextDecoder('utf-8')
  try {
    for await (const chunk of createReadStream(path, signal === undefined ? {} : { signal })) {
      const text = decoder.decode(chunk as Buffer, { stream: true })
      if (text.length > 0) yield text
    }
    const rest = decoder.decode()
    if (rest.length > 0) yield rest
  } catch (error) {
    throw readFailure('read', displayPath, signal, error)
  }
}

/** Whole host text, decoded as UTF-8. */
async function textOf(path: string, displayPath: string, signal?: AbortSignal): Promise<string> {
  try {
    return await readFile(path, { encoding: 'utf8', signal })
  } catch (error) {
    throw readFailure('read', displayPath, signal, error)
  }
}

/**
 * Whole host bytes, with no decoding, refusing a file over the cap before reading it.
 *
 * The size decides first, so an oversized file costs a metadata call instead of a
 * buffered read; the length is checked again after the read, because a file that
 * grows in between must not slip past the cap it was measured against.
 */
async function bytesOf(
  path: string, displayPath: string, signal: AbortSignal | undefined, maxBytes: number,
): Promise<Buffer> {
  const size = await sizeOf(path, displayPath)
  if (size > maxBytes) throw tooLarge(displayPath, size, maxBytes)
  const bytes = await readWholeOf(path, displayPath, signal)
  if (bytes.byteLength > maxBytes) throw tooLarge(displayPath, bytes.byteLength, maxBytes)
  return bytes
}

/** One host file's bytes, with no decoding. */
async function readWholeOf(path: string, displayPath: string, signal?: AbortSignal): Promise<Buffer> {
  try {
    return await readFile(path, signal === undefined ? {} : { signal })
  } catch (error) {
    throw readFailure('read', displayPath, signal, error)
  }
}

/** Size of one host file, reported as a read failure when it cannot be measured. */
async function sizeOf(path: string, displayPath: string): Promise<number> {
  try {
    return (await statPath(path)).size
  } catch (error) {
    throw readFailure('read', displayPath, undefined, error)
  }
}

/**
 * The bytes at `[offset, offset + length)` of one host file, reading only that window.
 *
 * The window is the bound: opening the file and reading at an offset never holds
 * more than the caller asked for, whatever the file's size. A window at or past
 * the end of the file is empty.
 */
async function bytesInRange(
  path: string, displayPath: string, range: { offset: number; length: number }, signal?: AbortSignal,
): Promise<Uint8Array> {
  if (range.length <= 0) return new Uint8Array(0)
  try {
    const handle = await open(path, 'r')
    try {
      const window = Buffer.alloc(range.length)
      let filled = 0
      while (filled < window.length) {
        throwIfAborted(signal, 'read')
        const { bytesRead } = await handle.read(window, filled, window.length - filled, range.offset + filled)
        if (bytesRead === 0) break
        filled += bytesRead
      }
      return window.subarray(0, filled)
    } finally {
      await handle.close()
    }
  } catch (error) {
    throw readFailure('read', displayPath, signal, error)
  }
}

/** Direct children of one host directory, with resolved child targets in stable name order. */
async function hostEntries(path: string, displayPath: string, signal?: AbortSignal): Promise<FsDirEntry[]> {
  throwIfAborted(signal, 'list')
  const info = await probe(path, displayPath, false)
  if (info === undefined) throw new FsError(`cannot list "${displayPath}": not found`, 'FS_NOT_FOUND')
  if (!info.isDirectory()) throw new FsError(`cannot list "${displayPath}": not a directory`, 'FS_NOT_DIRECTORY')
  const dirents = await readdir(path, { withFileTypes: true, encoding: 'utf8' }).catch((error: unknown) => {
    throw fsErrorFromErrno('list', displayPath, error)
  })
  const entries: FsDirEntry[] = []
  for (const dirent of dirents.sort((left, right) => left.name.localeCompare(right.name))) {
    throwIfAborted(signal, 'list')
    const childPath = join(path, dirent.name)
    const childDisplay = join(displayPath, dirent.name)
    const child = await probe(childPath, childDisplay, false)
    entries.push({
      name: dirent.name,
      type: child === undefined ? 'other' : typeOf(child),
      target: { targetKey: FsTargetKey(childPath), displayPath: childDisplay },
      ...(child === undefined ? {} : { version: versionOf(child), size: Number(child.size) }),
    })
  }
  return entries
}

function readFailure(operation: string, displayPath: string, signal: AbortSignal | undefined, error: unknown): unknown {
  if (signal?.aborted === true) return new FsError(`${operation} aborted`, 'FS_ABORTED', { cause: error })
  return fsErrorFromErrno(operation, displayPath, error)
}

function throwIfAborted(signal: AbortSignal | undefined, operation: string): void {
  if (signal?.aborted === true) throw new FsError(`${operation} aborted`, 'FS_ABORTED')
}

function isAbsent(error: unknown): boolean {
  const code = error instanceof Error && 'code' in error ? error.code : undefined
  return code === 'ENOENT' || code === 'ENOTDIR'
}

function tooLarge(displayPath: string, size: number, maxBytes: number): FsError {
  return new FsError(`cannot read "${displayPath}": ${size} bytes exceeds the ${maxBytes}-byte limit`, 'FS_TOO_LARGE')
}

/** The host exposes the skill instructions and references; tools, templates and notes do not. */
function hostReadDenied(displayPath: string): FsError {
  return new FsError(`cannot access "${displayPath}": the local skills tree exposes only SKILL.md and references/**`, 'FS_PERMISSION_DENIED')
}

/** Mutations belong to the SSH host; this machine only supplies read-only agent instructions. */
function hostWriteDenied(displayPath: string): FsError {
  return new FsError(`cannot write "${displayPath}": this machine's AGENTS.md and skills trees are read-only`, 'FS_PERMISSION_DENIED')
}

export default SshPosixFileSystem
