/**
 * The filesystem helper that runs INSIDE the developer container.
 *
 * DevcontainerFileSystem keeps one of these in a persistent
 * "docker exec -i <container> node <path>" process and speaks DSH's SSH helper
 * framing to it: a four-byte big-endian length header followed by one UTF-8
 * JSON document per frame, with "hello" as the handshake
 * (packages/ssh/ssh/src/protocol.ts, SSH_PROTOCOL_VERSION = 3).
 *
 * The program is dependency-free on purpose: it runs on whatever Node the image
 * ships, so it imports nothing but node: builtins and never assumes a bundler.
 * Every path it accepts or reports is a POSIX path inside this container, which
 * is what keeps the session's host filesystem physically out of reach.
 */
import { randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { chmod, link, lstat, mkdir, open, readFile, readdir, realpath, rename, rm, stat } from 'node:fs/promises'
import { posix } from 'node:path'
import { pathToFileURL } from 'node:url'
import { TextDecoder } from 'node:util'

/** Wire version, shared with the host client and DSH's SSH helper protocol. */
const PROTOCOL_VERSION = 3
/** Largest single frame either side accepts. */
const MAX_FRAME_BYTES = 64 * 1024 * 1024
/** Largest whole-text transfer; larger files reach the caller through fs.stream. */
const MAX_TEXT_BYTES = 32 * 1024 * 1024
/** Leading bytes scanned for a NUL before a file counts as binary. */
const BINARY_SAMPLE_BYTES = 8192
/** Concurrent open text iterators one helper will hold. */
const MAX_TEXT_STREAMS = 64
const FRAME_HEADER_BYTES = 4

/** The filesystem failure codes the host maps back onto FsError. */
const FS_ERROR_CODES = new Set([
  'FS_NOT_FOUND', 'FS_NOT_DIRECTORY', 'FS_NOT_TEXT', 'FS_NOT_REGULAR_FILE',
  'FS_TOO_LARGE', 'FS_PERMISSION_DENIED', 'FS_SANDBOX_DENIED', 'FS_IO_ERROR',
  'FS_STALE_VERSION', 'FS_NOT_OBSERVED', 'FS_AMBIGUOUS_EDIT', 'FS_EDIT_NOT_FOUND',
  'FS_ABORTED', 'FS_PATCH_MISMATCH', 'FS_SAME_TARGET',
])

/** POSIX failure names translated to the filesystem vocabulary the host understands. */
const ERRNO_CODES = {
  ENOENT: 'FS_NOT_FOUND',
  ENOTDIR: 'FS_NOT_DIRECTORY',
  EISDIR: 'FS_NOT_REGULAR_FILE',
  EACCES: 'FS_PERMISSION_DENIED',
  EPERM: 'FS_PERMISSION_DENIED',
  EROFS: 'FS_PERMISSION_DENIED',
  EEXIST: 'FS_NOT_OBSERVED',
  ENOTEMPTY: 'FS_IO_ERROR',
  ELOOP: 'FS_IO_ERROR',
  ENAMETOOLONG: 'FS_IO_ERROR',
  ENOSPC: 'FS_IO_ERROR',
  EXDEV: 'FS_IO_ERROR',
}

/** One typed filesystem failure, carrying a code the host maps back to FsError. */
function fsError(message, code) {
  const error = new Error(message)
  error.name = 'FsError'
  error.code = code
  return error
}

/** Translate one Node failure into the filesystem vocabulary; unknown faults stay FS_IO_ERROR. */
function translateError(error, fallback = 'FS_IO_ERROR') {
  if (error !== null && typeof error === 'object' && typeof error.code === 'string') {
    if (FS_ERROR_CODES.has(error.code)) return error
    const mapped = ERRNO_CODES[error.code]
    const translated = fsError(error.message, mapped === undefined ? fallback : mapped)
    translated.cause = error
    return translated
  }
  const translated = fsError(error instanceof Error ? error.message : String(error), fallback)
  translated.cause = error
  return translated
}

/** The frame body a failed request reports. */
function describeError(error) {
  const detail = translateError(error)
  const description = {
    name: typeof detail.name === 'string' ? detail.name : 'Error',
    message: detail.message ?? String(error),
  }
  if (typeof detail.code === 'string' && FS_ERROR_CODES.has(detail.code)) description.code = detail.code
  return description
}

// --- Framing -----------------------------------------------------------------

/** Encode one frame as a length header plus its JSON body. */
function encodeFrame(frame) {
  const body = Buffer.from(JSON.stringify(frame), 'utf8')
  if (body.length === 0 || body.length > MAX_FRAME_BYTES) {
    throw new Error('devcontainer helper: frame size out of range')
  }
  const bytes = Buffer.allocUnsafe(FRAME_HEADER_BYTES + body.length)
  bytes.writeUInt32BE(body.length, 0)
  body.copy(bytes, FRAME_HEADER_BYTES)
  return bytes
}

/** Serialized writer: one frame at a time, honoring stdout backpressure. */
let writeQueue = Promise.resolve()

function send(frame) {
  const bytes = encodeFrame(frame)
  writeQueue = writeQueue.then(() => new Promise((resolve, reject) => {
    if (process.stdout.write(bytes)) {
      resolve()
      return
    }
    const onDrain = () => {
      process.stdout.off('error', onError)
      resolve()
    }
    const onError = (error) => {
      process.stdout.off('drain', onDrain)
      reject(error)
    }
    process.stdout.once('drain', onDrain)
    process.stdout.once('error', onError)
  }))
  return writeQueue
}

/** Buffered decoder for arbitrary stdin chunk boundaries. */
class FrameDecoder {
  constructor() {
    this.header = Buffer.alloc(FRAME_HEADER_BYTES)
    this.headerBytes = 0
    this.payload = undefined
    this.payloadBytes = 0
  }

  /**
   * Consume one chunk.
   * @param {Buffer} chunk - bytes read from stdin.
   * @returns {object[]} every frame the chunk completed.
   */
  push(chunk) {
    const frames = []
    let offset = 0
    while (offset < chunk.length) {
      if (this.payload === undefined) {
        const count = Math.min(FRAME_HEADER_BYTES - this.headerBytes, chunk.length - offset)
        chunk.copy(this.header, this.headerBytes, offset, offset + count)
        this.headerBytes += count
        offset += count
        if (this.headerBytes < FRAME_HEADER_BYTES) continue
        const size = this.header.readUInt32BE(0)
        if (size === 0 || size > MAX_FRAME_BYTES) throw new Error('devcontainer helper: invalid frame length')
        this.payload = Buffer.alloc(size)
        this.payloadBytes = 0
      }
      const count = Math.min(this.payload.length - this.payloadBytes, chunk.length - offset)
      chunk.copy(this.payload, this.payloadBytes, offset, offset + count)
      this.payloadBytes += count
      offset += count
      if (this.payloadBytes === this.payload.length) {
        frames.push(JSON.parse(this.payload.toString('utf8')))
        this.payload = undefined
        this.headerBytes = 0
      }
    }
    return frames
  }
}

// --- Paths -------------------------------------------------------------------

/** Normalize one path this helper reports into its POSIX spelling. */
function toPosixPath(value) {
  return value.split('\\').join('/')
}

/** The container directory a relative request resolves against. */
let workspace = '/'
/** The realpath of the workspace, so a mount point that is itself a link still counts as inside. */
let workspaceReal = '/'
/** Extra read-only mounts the host declared for this session, in this container's spelling. */
let extraRoots = []
let initialized = false

/**
 * Anchor one already-normalized path under its base.
 *
 * Joining by hand rather than through posix.resolve keeps a drive-rooted base
 * intact: posix.resolve treats "C:/dir" as relative and prepends the process
 * working directory, which only happens when this program runs on Windows.
 * @param {string} text - the path to anchor.
 * @param {string} base - the directory relative paths resolve against.
 * @returns {string} the normalized absolute path.
 */
function anchorPath(text, base) {
  if (text.startsWith('/') || /^[A-Za-z]:\//.test(text)) return posix.normalize(text)
  const parent = posix.normalize(base).replace(/\/+$/, '')
  return posix.normalize(parent + '/' + text)
}

/**
 * Anchor one requested path in the container namespace.
 *
 * A drive-letter prefix is what win32 sometimes leaves on a container path
 * ("C:\workspaces\repo\src"). The mount point is POSIX, so such a prefix is
 * dropped — but only when what remains is inside the mount, because a
 * drive-rooted path on a Windows host is a real path and not a mangled one.
 * @param {unknown} value - the caller-supplied path.
 * @param {string} [base] - the directory relative paths resolve against.
 * @returns {string} the absolute POSIX path.
 */
function toAbsolute(value, base) {
  const raw = typeof value === 'string' ? value : typeof value === 'number' ? String(value) : ''
  const text = raw.split('\\').join('/')
  if (text.trim() === '') throw fsError('file_path must be a non-empty string', 'FS_NOT_FOUND')
  const mangled = /^[A-Za-z]:\//.test(text) ? text.slice(2) : undefined
  const insideMount = mangled !== undefined && workspace !== '/'
    && (mangled === workspace || mangled.startsWith(workspace + '/'))
  const declaredBase = base === undefined || base === null ? workspace : String(base).split('\\').join('/')
  return anchorPath(insideMount ? mangled : text, anchorPath(declaredBase, workspace))
}

/**
 * Whether one filesystem failure means the path is not a directory that exists.
 *
 * A file used as a directory is ENOTDIR on POSIX and ENOENT on Windows, so both
 * read as "absent" here; whichever operation follows reports the entry itself.
 * @param {unknown} error - the failure of one realpath, stat, or lstat call.
 * @returns true when the path is absent rather than unreadable.
 */
function isAbsent(error) {
  return error !== null && typeof error === 'object'
    && (error.code === 'ENOENT' || error.code === 'ENOTDIR')
}

/**
 * Resolve a path to its stable identity, keeping an absent suffix under the nearest existing ancestor.
 * @param {string} absolute - the absolute path to identify.
 * @returns {Promise<string>} the realpath-based identity.
 */
async function identityOf(absolute) {
  try {
    return toPosixPath(await realpath(absolute))
  } catch (error) {
    if (!isAbsent(error)) throw translateError(error)
  }
  const missing = [posix.basename(absolute)]
  let ancestor = posix.dirname(absolute)
  for (;;) {
    try {
      const real = toPosixPath(await realpath(ancestor))
      return posix.join(real, ...missing)
    } catch (error) {
      if (!isAbsent(error)) throw translateError(error)
      const parent = posix.dirname(ancestor)
      if (parent === ancestor) return absolute
      missing.unshift(posix.basename(ancestor))
      ancestor = parent
    }
  }
}

// --- Metadata ----------------------------------------------------------------

/** Opaque freshness token from identity and high-resolution timestamps. */
function versionOf(info) {
  return [info.dev, info.ino, info.size, info.mtimeNs, info.ctimeNs].join(':')
}

function typeOf(info) {
  if (info.isFile()) return 'file'
  if (info.isDirectory()) return 'directory'
  return 'other'
}

/** Stat a path, treating a missing entry and a file used as a directory as absent. */
async function probe(absolute, follow = true) {
  try {
    return await (follow ? stat : lstat)(absolute, { bigint: true })
  } catch (error) {
    if (isAbsent(error)) return null
    throw translateError(error)
  }
}

/** Require a regular file, reporting the verb the caller used. */
async function requireFile(target, verb) {
  const info = await probe(target.targetKey)
  if (info === null) throw fsError('cannot ' + verb + ' "' + target.displayPath + '": not found', 'FS_NOT_FOUND')
  if (!info.isFile()) {
    throw fsError('cannot ' + verb + ' "' + target.displayPath + '": not a regular file', 'FS_NOT_REGULAR_FILE')
  }
  return info
}

/**
 * Whether one real path stays inside a root the handshake named.
 *
 * The workspace is the session's own directory; the extra roots are the host paths
 * its sandbox was created with beside the workspace — the host's global skills and
 * `AGENTS.md`, mounted read-only. Nothing else is reachable, which is why the host
 * sends this list rather than the helper trusting the mount table.
 */
function insideWorkspace(real) {
  const roots = workspaceReal === workspace ? [workspace] : [workspace, workspaceReal]
  const normalized = real.replace(/\/+$/, '')
  for (const root of [...roots, ...extraRoots]) {
    const base = root.replace(/\/+$/, '')
    // A root that normalizes to the filesystem root leaves an empty base, and an
    // empty base is a prefix of every path: honouring it would open the whole
    // container. The host refuses such a mount, and the helper refuses it again
    // rather than trusting that the host did.
    if (base === '') continue
    if (normalized === base || normalized.startsWith(base + '/')) return true
  }
  return false
}

/**
 * Resolve one read target to the identity the read itself opens.
 *
 * The host fences the identity it resolved, and this resolves it once more
 * immediately before the I/O: a link inside the workspace can be repointed
 * outside it between the two, and reading the identity that was just verified
 * is what closes that window.
 * @param {{targetKey: string, displayPath: string}} target - the requested target.
 * @returns {Promise<string>} the real path to read.
 */
async function readableTarget(target) {
  let real
  try {
    real = toPosixPath(await realpath(target.targetKey))
  } catch (error) {
    throw translateError(error)
  }
  if (insideWorkspace(real)) return real
  throw fsError(
    'cannot read "' + target.displayPath + '": the resolved path "' + real + '" leaves the workspace',
    'FS_PERMISSION_DENIED',
  )
}

/** Require the guard the caller supplied to still describe the file. */
async function requireGuard(target, expected, verb) {
  const info = await probe(target.targetKey)
  const guarded = expected !== undefined && expected !== null && typeof expected.version === 'string'
  if (info === null || !info.isFile() || (guarded && versionOf(info) !== expected.version)) {
    throw fsError('cannot ' + verb + ' "' + target.displayPath + '": file changed since it was read', 'FS_STALE_VERSION')
  }
  return info
}

/** Normalize a request's target object. */
function asTarget(raw) {
  if (raw === null || typeof raw !== 'object' || typeof raw.targetKey !== 'string') {
    throw new Error('devcontainer helper: malformed target')
  }
  return {
    targetKey: raw.targetKey,
    displayPath: typeof raw.displayPath === 'string' ? raw.displayPath : raw.targetKey,
  }
}

// --- Text decoding -----------------------------------------------------------

function decodeUtf8(buffer, verb, displayPath) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer)
  } catch {
    throw fsError('cannot ' + verb + ' "' + displayPath + '": invalid UTF-8 text', 'FS_NOT_TEXT')
  }
}

function normalizeLineEndings(content) {
  return content.split('\r\n').join('\n')
}

function detectLineEndings(raw) {
  const sample = raw.slice(0, 4096)
  const crlf = sample.split('\r\n').length - 1
  const lf = sample.split('\n').length - 1 - crlf
  return crlf > lf ? 'CRLF' : 'LF'
}

function restoreLineEndings(content, style) {
  return style === 'LF' ? content : normalizeLineEndings(content).split('\n').join('\r\n')
}

/** Read a file for editing: LF-normalized text plus the style to restore on write-back. */
async function readForEdit(target, verb) {
  const buffer = await readFile(target.targetKey)
  if (buffer.includes(0)) throw fsError('cannot ' + verb + ' "' + target.displayPath + '": binary file', 'FS_NOT_TEXT')
  const raw = decodeUtf8(buffer, verb, target.displayPath)
  return { content: normalizeLineEndings(raw), lineEndings: detectLineEndings(raw) }
}

/** The bounded diff basis a mutation reports, or null when it is unavailable. */
async function diffBasis(target, maxBytes) {
  try {
    const info = await probe(target.targetKey)
    if (info === null || !info.isFile() || Number(info.size) >= maxBytes) return null
    const buffer = await readFile(target.targetKey)
    if (buffer.length !== Number(info.size) || buffer.includes(0)) return null
    return normalizeLineEndings(decodeUtf8(buffer, 'read', target.displayPath))
  } catch {
    return null
  }
}

// --- Literal edits and patches ----------------------------------------------

function countOccurrences(content, needle) {
  let count = 0
  let index = 0
  for (;;) {
    const found = content.indexOf(needle, index)
    if (found === -1) return count
    count += 1
    index = found + needle.length
  }
}

function applyLiteralEdit(content, edit, displayPath) {
  const oldText = normalizeLineEndings(String(edit.oldString === undefined ? '' : edit.oldString))
  if (oldText.length === 0) throw fsError('old_string must be a non-empty string', 'FS_EDIT_NOT_FOUND')
  const newText = normalizeLineEndings(String(edit.newString === undefined ? '' : edit.newString))
  const replacements = countOccurrences(content, oldText)
  if (replacements === 0) throw fsError('old_string was not found in "' + displayPath + '"', 'FS_EDIT_NOT_FOUND')
  if (edit.replaceAll !== true && replacements > 1) {
    throw fsError('old_string matched ' + replacements + ' times in "' + displayPath
      + '"; provide a more specific old_string or set replace_all to true', 'FS_AMBIGUOUS_EDIT')
  }
  return content.split(oldText).join(newText)
}

/*
 * Hunk application ported from DeepSeek Harness' @deepseek-ai/dsh-fs-patch
 * (itself adapted from OpenAI Codex rust-v0.158.0 NormalizeToLf, Apache-2.0), so a
 * patch the host parsed applies here with the same matching rules.
 */
const WHITE_SPACE = /\p{White_Space}/u

function trimWhitespace(value, leading) {
  let start = 0
  let end = value.length
  if (leading) while (start < end && WHITE_SPACE.test(value.charAt(start))) start += 1
  while (end > start && WHITE_SPACE.test(value.charAt(end - 1))) end -= 1
  return value.slice(start, end)
}

function normalizePunctuation(value) {
  return trimWhitespace(value, true)
    .replace(/[\u2010-\u2015\u2212]/gu, '-')
    .replace(/[\u2018-\u201B]/gu, "'")
    .replace(/[\u201C-\u201F]/gu, '"')
    .replace(/[\u00A0\u2002-\u200A\u202F\u205F\u3000]/gu, ' ')
}

const MATCH_PASSES = [
  (value) => value,
  (value) => trimWhitespace(value, false),
  (value) => trimWhitespace(value, true),
  normalizePunctuation,
]

function seekSequence(lines, pattern, start, eof) {
  if (pattern.length === 0) return start
  if (pattern.length > lines.length) return undefined
  const last = lines.length - pattern.length
  const first = eof ? last : start
  for (const normalize of MATCH_PASSES) {
    const expected = pattern.map(normalize)
    for (let index = first; index <= last; index += 1) {
      if (expected.every((line, offset) => normalize(lines[index + offset]) === line)) return index
    }
  }
  return undefined
}

function patchMismatch(hunk, stage) {
  return fsError('hunk at patch line ' + hunk.lineNumber + ' (' + stage + ') does not match', 'FS_PATCH_MISMATCH')
}

function applyHunks(before, hunks) {
  const original = before.split('\n')
  if (original[original.length - 1] === '') original.pop()
  const replacements = []
  let lineIndex = 0
  for (const hunk of hunks) {
    if (hunk.context !== undefined) {
      const anchor = [hunk.context]
      const found = seekSequence(original, anchor, lineIndex, false)
      if (found === undefined) throw patchMismatch(hunk, 'context')
      lineIndex = found + 1
    }
    if (hunk.oldLines.length === 0) {
      const at = original[original.length - 1] === '' ? original.length - 1 : original.length
      replacements.push({ start: at, oldLength: 0, newLines: hunk.newLines })
      continue
    }
    let pattern = hunk.oldLines
    let newLines = hunk.newLines
    let found = seekSequence(original, pattern, lineIndex, hunk.isEndOfFile === true)
    if (found === undefined && pattern[pattern.length - 1] === '') {
      pattern = pattern.slice(0, -1)
      if (newLines[newLines.length - 1] === '') newLines = newLines.slice(0, -1)
      found = seekSequence(original, pattern, lineIndex, hunk.isEndOfFile === true)
    }
    if (found === undefined) throw patchMismatch(hunk, 'oldLines')
    replacements.push({ start: found, oldLength: pattern.length, newLines })
    lineIndex = found + pattern.length
  }
  replacements.sort((left, right) => left.start - right.start)
  let lines = original
  for (const replacement of replacements.reverse()) {
    lines = [
      ...lines.slice(0, replacement.start),
      ...replacement.newLines,
      ...lines.slice(replacement.start + replacement.oldLength),
    ]
  }
  if (lines[lines.length - 1] !== '') lines.push('')
  return lines.join('\n')
}

// --- Mutations ---------------------------------------------------------------

/** Remove one staging directory without masking the primary failure. */
async function discard(path) {
  try {
    await rm(path, { recursive: true, force: true })
  } catch {
    // Staging residue must not replace the outcome the caller already earned.
  }
}

/** Atomically publish text through an owner-only staging file in the destination directory. */
async function writeFileAtomic(absolute, content, mode, options) {
  const directory = posix.dirname(absolute)
  await mkdir(directory, { recursive: true })
  const stagingDir = posix.join(
    directory,
    '.' + posix.basename(absolute) + '.' + process.pid + '.' + randomUUID() + '.tmpdir',
  )
  const tempPath = posix.join(stagingDir, 'file.tmp')
  await mkdir(stagingDir, { mode: 0o700 })
  try {
    await chmod(stagingDir, 0o700)
    const handle = await open(tempPath, 'wx', 0o600)
    try {
      await handle.writeFile(content, 'utf8')
      await handle.sync()
      if (mode !== undefined) await handle.chmod(mode)
    } finally {
      await handle.close()
    }
    if (options.createIfAbsent === true) {
      try {
        await link(tempPath, absolute)
      } catch (error) {
        const existing = await probe(absolute).catch(() => null)
        if (existing !== null) {
          throw fsError('cannot overwrite existing "' + options.displayPath + '": read it first', 'FS_NOT_OBSERVED')
        }
        throw translateError(error)
      }
    } else {
      await rename(tempPath, absolute)
    }
  } finally {
    await discard(stagingDir)
  }
}

/** Serialize mutations per path so read, guard, and write stay one critical section. */
const locks = new Map()

function withLock(key, operation) {
  return withLocks([key], operation)
}

function withLocks(keys, operation) {
  const ordered = [...new Set(keys)].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0))
  const acquire = (index) => {
    const key = ordered[index]
    if (key === undefined) return operation()
    const prior = locks.get(key) ?? Promise.resolve()
    const run = prior.then(() => acquire(index + 1))
    const tail = run.then(() => undefined, () => undefined)
    locks.set(key, tail)
    return run.finally(() => {
      if (locks.get(key) === tail) locks.delete(key)
    })
  }
  return Promise.resolve().then(() => acquire(0))
}

// --- Streams -----------------------------------------------------------------

const streams = new Map()

/** Decoded text chunks of one file, with the same rejection rules as a whole read. */
async function* streamWholeText(target) {
  const decoder = new TextDecoder('utf-8', { fatal: true })
  let sampled = 0
  for await (const chunk of createReadStream(target.targetKey)) {
    if (sampled < BINARY_SAMPLE_BYTES) {
      const sample = chunk.subarray(0, Math.min(chunk.length, BINARY_SAMPLE_BYTES - sampled))
      if (sample.includes(0)) throw fsError('cannot read "' + target.displayPath + '": binary file', 'FS_NOT_TEXT')
      sampled += sample.length
    }
    yield decodeUtf8Chunk(decoder, chunk, target.displayPath)
  }
  yield decodeUtf8Chunk(decoder, undefined, target.displayPath)
}

function decodeUtf8Chunk(decoder, chunk, displayPath) {
  try {
    return chunk === undefined ? decoder.decode() : decoder.decode(chunk, { stream: true })
  } catch {
    throw fsError('cannot read "' + displayPath + '": invalid UTF-8 text', 'FS_NOT_TEXT')
  }
}

// --- Handlers ----------------------------------------------------------------

/** The handshake and version probe; it also fixes the workspace. */
function hello(params) {
  if (initialized) throw new Error('devcontainer helper: handshake already completed')
  if (params === null || typeof params !== 'object') throw new Error('devcontainer helper: malformed handshake')
  if (params.protocol !== PROTOCOL_VERSION) {
    throw new Error('devcontainer helper: protocol ' + String(params.protocol) + ' is not ' + String(PROTOCOL_VERSION))
  }
  const declared = String(typeof params.workspace === 'string' ? params.workspace : '/').split('\\').join('/')
  workspace = anchorPath(declared.trim() === '' ? '/' : declared, '/')
  extraRoots = Array.isArray(params.mounts)
    ? params.mounts.filter((mount) => typeof mount === 'string' && mount.trim() !== '').map((mount) => posix.normalize(toPosixPath(mount.trim())))
    : []
  initialized = true
  const greeting = () => ({
    protocol: PROTOCOL_VERSION,
    platform: process.platform,
    nodeVersion: process.version,
    pid: process.pid,
    workspace,
    workspaceReal,
  })
  return realpath(workspace).then(
    (real) => {
      workspaceReal = toPosixPath(real)
      return greeting()
    },
    () => {
      // A mount that cannot be realpath'd is its own identity, never the root:
      // the host fences resolved identities against this path.
      workspaceReal = workspace
      return greeting()
    },
  )
}

function requireInitialized() {
  if (!initialized) throw new Error('devcontainer helper: handshake required')
}

async function fsResolve(params) {
  const absolute = toAbsolute(params.path, params.cwd)
  return { targetKey: await identityOf(absolute), displayPath: absolute }
}

async function fsLstat(params) {
  const absolute = toAbsolute(params.path, params.cwd)
  const info = await probe(absolute, false)
  if (info === null) return null
  return {
    version: versionOf(info),
    type: info.isSymbolicLink() ? 'symlink' : typeOf(info),
    size: Number(info.size),
  }
}

async function fsStat(params) {
  const target = asTarget(params.target)
  const info = await probe(target.targetKey)
  if (info === null) return null
  return { version: versionOf(info), type: typeOf(info), size: Number(info.size) }
}

async function fsReadText(params) {
  const target = asTarget(params.target)
  const info = await requireFile(target, 'read')
  if (Number(info.size) > MAX_TEXT_BYTES) {
    throw fsError(
      'cannot read "' + target.displayPath + '": ' + Number(info.size) + ' bytes exceeds the whole-text limit; stream it instead',
      'FS_TOO_LARGE',
    )
  }
  const buffer = await readFile(await readableTarget(target))
  if (buffer.subarray(0, BINARY_SAMPLE_BYTES).includes(0)) {
    throw fsError('cannot read "' + target.displayPath + '": binary file', 'FS_NOT_TEXT')
  }
  return decodeUtf8(buffer, 'read', target.displayPath)
}

async function fsReadBytes(params) {
  const target = asTarget(params.target)
  const info = await requireFile(target, 'read')
  const maxBytes = Math.min(Number(params.maxBytes === undefined ? MAX_TEXT_BYTES : params.maxBytes), MAX_TEXT_BYTES)
  if (Number(info.size) > maxBytes) {
    throw fsError(
      'cannot read "' + target.displayPath + '": ' + Number(info.size) + ' bytes exceeds the ' + maxBytes + '-byte limit',
      'FS_TOO_LARGE',
    )
  }
  return (await readFile(await readableTarget(target))).toString('base64')
}

function readWindow(absolute, offset, length) {
  return new Promise((resolve, reject) => {
    const chunks = []
    const stream = createReadStream(absolute, { start: offset, end: offset + Math.max(length, 1) - 1 })
    stream.on('data', (chunk) => { chunks.push(chunk) })
    stream.on('error', (error) => { reject(translateError(error)) })
    stream.on('end', () => { resolve(Buffer.concat(chunks)) })
  })
}

async function fsReadRange(params) {
  const target = asTarget(params.target)
  await requireFile(target, 'read')
  const offset = Number(params.offset === undefined ? 0 : params.offset)
  const length = Number(params.length === undefined ? 0 : params.length)
  if (length === 0) return ''
  return (await readWindow(await readableTarget(target), offset, length)).toString('base64')
}

async function fsList(params) {
  const target = asTarget(params.target)
  const info = await probe(target.targetKey)
  if (info === null) throw fsError('cannot list "' + target.displayPath + '": not found', 'FS_NOT_FOUND')
  if (!info.isDirectory()) throw fsError('cannot list "' + target.displayPath + '": not a directory', 'FS_NOT_DIRECTORY')
  const entries = await readdir(target.targetKey, { withFileTypes: true, encoding: 'utf8' })
  entries.sort((left, right) => left.name.localeCompare(right.name))
  const listed = []
  for (const entry of entries) {
    const childKey = await identityOf(posix.join(target.targetKey, entry.name))
    const childInfo = await probe(childKey)
    const child = {
      name: entry.name,
      type: childInfo === null ? 'other' : typeOf(childInfo),
      target: { targetKey: childKey, displayPath: posix.join(target.displayPath, entry.name) },
    }
    if (childInfo !== null) child.version = versionOf(childInfo)
    if (childInfo !== null && childInfo.isFile()) child.size = Number(childInfo.size)
    listed.push(child)
  }
  return listed
}

async function fsWrite(params) {
  const target = asTarget(params.target)
  return withLock(target.targetKey, async () => {
    const existing = await probe(target.targetKey)
    if (existing !== null && !existing.isFile()) {
      throw fsError('cannot write "' + target.displayPath + '": not a regular file', 'FS_NOT_REGULAR_FILE')
    }
    const expected = params.expected === undefined ? null : params.expected
    if (expected !== null && expected.kind === 'replaceIfVersion') {
      if (existing === null || versionOf(existing) !== expected.version) {
        throw fsError('cannot write "' + target.displayPath + '": file changed since it was read', 'FS_STALE_VERSION')
      }
    } else if (expected !== null && expected.kind === 'createIfAbsent' && existing !== null) {
      throw fsError('cannot overwrite existing "' + target.displayPath + '": read it first', 'FS_NOT_OBSERVED')
    }
    const content = String(params.content === undefined ? '' : params.content)
    const before = existing === null ? null : await diffBasis(target, MAX_TEXT_BYTES)
    await writeFileAtomic(target.targetKey, content, existing === null ? undefined : Number(existing.mode & 0o777n), {
      displayPath: target.displayPath,
      createIfAbsent: expected !== null && expected.kind === 'createIfAbsent',
    })
    const after = await probe(target.targetKey)
    return {
      operation: existing === null ? 'create' : 'update',
      version: after === null ? 'missing:' + target.targetKey : versionOf(after),
      before,
      after: normalizeLineEndings(content),
    }
  })
}

async function fsEdit(params) {
  const target = asTarget(params.target)
  return withLock(target.targetKey, async () => {
    const existing = await requireGuard(target, params.expected, 'edit')
    const original = await readForEdit(target, 'edit')
    const edited = applyLiteralEdit(original.content, params.edit === undefined ? {} : params.edit, target.displayPath)
    await writeFileAtomic(
      target.targetKey,
      restoreLineEndings(edited, original.lineEndings),
      Number(existing.mode & 0o777n),
      { displayPath: target.displayPath },
    )
    const after = await probe(target.targetKey)
    return {
      version: after === null ? 'missing:' + target.targetKey : versionOf(after),
      before: original.content,
      after: edited,
    }
  })
}

async function fsPatch(params) {
  const target = asTarget(params.target)
  return withLock(target.targetKey, async () => {
    const existing = await requireGuard(target, params.expected, 'patch')
    const original = await readForEdit(target, 'patch')
    const after = applyHunks(original.content, Array.isArray(params.hunks) ? params.hunks : [])
    await writeFileAtomic(
      target.targetKey,
      restoreLineEndings(after, original.lineEndings),
      Number(existing.mode & 0o777n),
      { displayPath: target.displayPath },
    )
    const info = await probe(target.targetKey)
    return {
      version: info === null ? 'missing:' + target.targetKey : versionOf(info),
      before: original.content,
      after,
    }
  })
}

async function fsDelete(params) {
  const target = asTarget(params.target)
  return withLock(target.targetKey, async () => {
    await requireGuard(target, params.expected, 'delete')
    const before = await diffBasis(target, MAX_TEXT_BYTES)
    try {
      await rm(target.targetKey)
    } catch (error) {
      throw translateError(error)
    }
    return { before }
  })
}

async function fsMove(params) {
  const source = asTarget(params.source)
  const destination = asTarget(params.destination)
  if (source.targetKey === destination.targetKey) {
    throw fsError('cannot move "' + source.displayPath + '": source and destination are the same file', 'FS_SAME_TARGET')
  }
  const options = params.options === undefined || params.options === null ? {} : params.options
  return withLocks([source.targetKey, destination.targetKey], async () => {
    const sourceInfo = await requireGuard(source, options.expectedSource, 'move')
    const existing = await probe(destination.targetKey)
    if (existing !== null && !existing.isFile()) {
      throw fsError('cannot move onto "' + destination.displayPath + '": not a regular file', 'FS_NOT_REGULAR_FILE')
    }
    const expectedDestination = options.expectedDestination === undefined ? null : options.expectedDestination
    if (expectedDestination !== null && expectedDestination.kind === 'createIfAbsent' && existing !== null) {
      throw fsError('cannot overwrite existing "' + destination.displayPath + '": read it first', 'FS_NOT_OBSERVED')
    }
    if (expectedDestination !== null && expectedDestination.kind === 'replaceIfVersion'
      && (existing === null || versionOf(existing) !== expectedDestination.version)) {
      throw fsError('cannot move onto "' + destination.displayPath + '": file changed since it was read', 'FS_STALE_VERSION')
    }
    const original = await readForEdit(source, 'move')
    const after = Array.isArray(options.hunks) ? applyHunks(original.content, options.hunks) : original.content
    const before = existing === null ? null : await diffBasis(destination, MAX_TEXT_BYTES)
    await writeFileAtomic(
      destination.targetKey,
      restoreLineEndings(after, original.lineEndings),
      Number(sourceInfo.mode & 0o777n),
      {
        displayPath: destination.displayPath,
        createIfAbsent: expectedDestination !== null && expectedDestination.kind === 'createIfAbsent',
      },
    )
    const published = await probe(destination.targetKey)
    const destinationOutcome = {
      operation: existing === null ? 'create' : 'update',
      version: published === null ? 'missing:' + destination.targetKey : versionOf(published),
      before,
      after,
    }
    let sourceFailure
    try {
      await rm(source.targetKey)
    } catch (error) {
      const translated = translateError(error)
      sourceFailure = {
        code: typeof translated.code === 'string' ? translated.code : 'FS_IO_ERROR',
        message: translated.message,
      }
    }
    return sourceFailure === undefined
      ? { sourceBefore: original.content, destination: destinationOutcome, sourceDeleted: true }
      : { sourceBefore: original.content, destination: destinationOutcome, sourceDeleted: false, sourceFailure }
  })
}

async function fsStreamStart(params) {
  const target = asTarget(params.target)
  await requireFile(target, 'read')
  if (streams.size >= MAX_TEXT_STREAMS) throw new Error('devcontainer helper: text stream limit reached')
  const id = randomUUID()
  streams.set(id, streamWholeText({ ...target, targetKey: await readableTarget(target) })[Symbol.asyncIterator]())
  return { id }
}

async function fsStreamNext(params) {
  const id = String(params.id)
  const record = streams.get(id)
  if (record === undefined) throw new Error('devcontainer helper: unknown text stream')
  const next = await record.next()
  if (next.done === true) {
    streams.delete(id)
    return { done: true, value: '' }
  }
  return { done: false, value: next.value }
}

async function fsStreamClose(params) {
  const id = String(params.id)
  const record = streams.get(id)
  if (record === undefined) return null
  streams.delete(id)
  await record.return()
  return null
}

// --- Dispatch ----------------------------------------------------------------

const HANDLERS = {
  hello,
  ping: () => ({ pong: true, now: Date.now() }),
  'fs.resolve': fsResolve,
  'fs.lstat': fsLstat,
  'fs.stat': fsStat,
  'fs.readText': fsReadText,
  'fs.readBytes': fsReadBytes,
  'fs.readRange': fsReadRange,
  'fs.list': fsList,
  'fs.write': fsWrite,
  'fs.edit': fsEdit,
  'fs.patch': fsPatch,
  'fs.delete': fsDelete,
  'fs.move': fsMove,
  'fs.stream': fsStreamStart,
  'fs.next': fsStreamNext,
  'fs.streamClose': fsStreamClose,
}

const active = new Map()
let closing = false

async function dispatch(method, params, signal) {
  const handler = HANDLERS[method]
  if (handler === undefined) throw new Error('devcontainer helper: unknown operation ' + String(method))
  if (method !== 'hello') requireInitialized()
  if (signal.aborted) throw fsError(method + ' aborted', 'FS_ABORTED')
  return await handler(params === undefined || params === null ? {} : params, signal)
}

function receive(frame) {
  if (frame === null || typeof frame !== 'object') return
  if (frame.type === 'cancel') {
    const controller = active.get(frame.id)
    if (controller !== undefined) controller.abort(new Error('devcontainer helper: caller cancelled the operation'))
    return
  }
  if (frame.type !== 'request' || typeof frame.id !== 'string') return
  if (active.has(frame.id)) return
  const controller = new AbortController()
  active.set(frame.id, controller)
  dispatch(frame.method, frame.params, controller.signal).then(
    (value) => send({ type: 'result', id: frame.id, value: value === undefined ? null : value }),
    (error) => send({ type: 'error', id: frame.id, error: describeError(error) }),
  ).finally(() => {
    active.delete(frame.id)
  })
}

function shutdown() {
  if (closing) return
  closing = true
  streams.clear()
  for (const controller of active.values()) controller.abort(new Error('devcontainer helper: closing'))
  active.clear()
  process.stdin.pause()
  void writeQueue.finally(() => { process.exit(0) })
}

/**
 * Serve one request without a transport.
 * @param {string} method - the helper operation.
 * @param {unknown} params - the request parameters.
 * @returns {Promise<unknown>} the operation's value.
 */
export async function handle(method, params) {
  return await dispatch(method, params, new AbortController().signal)
}

/** Read framed requests from stdin and answer on stdout until the pipe closes. */
function main() {
  const decoder = new FrameDecoder()
  process.stdin.on('data', (chunk) => {
    let frames
    try {
      frames = decoder.push(chunk)
    } catch (error) {
      process.stderr.write((error instanceof Error ? error.message : String(error)) + '\n')
      process.exit(1)
    }
    for (const frame of frames) receive(frame)
  })
  process.stdin.on('end', shutdown)
  process.stdin.on('error', shutdown)
  process.on('SIGTERM', shutdown)
  process.on('SIGINT', shutdown)
  process.stdout.on('error', shutdown)
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) main()
