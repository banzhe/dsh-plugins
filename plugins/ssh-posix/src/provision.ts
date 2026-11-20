/** Host-pushed helper provisioning: local archive inspection and the remote commands one installation runs. */

import { createHash, randomBytes } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { posix } from 'node:path'
import { createGunzip } from 'node:zlib'
import { z } from 'zod'
import { shellWord } from './target-shell.ts'

/** Payload root inside a release archive; the builder archives that directory as the archive's single tree. */
const PAYLOAD_ROOT = 'dsh-ssh-helper'
/** Entry file inside the payload, as the release manifest lists it. */
const ENTRY_PATH = 'dsh-ssh-helper'
/** Remote probe result: the host cannot compute digests, so no installation can be verified. */
export const NO_SHA256SUM_EXIT = 97
/** Remote probe result: the configured entry is absent, so this connection installs one. */
export const MISSING_ENTRY_EXIT = 96
/** Remote installation result: the transferred bytes are not the archive the host read. */
export const ARCHIVE_DIGEST_EXIT = 98

/** Release manifest fields this client reads; the builder writes the entry digest among them. */
const manifestSchema = z.object({
  files: z.array(z.object({ path: z.string().min(1), sha256: z.string().regex(/^[0-9a-f]{64}$/) }).loose()).min(1),
}).loose()

/** The host archive one connection pushes, with both digests its installation checks. */
export interface ProvisionPlan {
  /** Absolute host-local archive path from configuration. */
  readonly source: string
  /** Lowercase SHA-256 of the archive bytes; the remote host repeats that check after the transfer. */
  readonly archiveHash: string
  /** Lowercase SHA-256 the archive's manifest declares for the installed entry. */
  readonly entryHash: string
}

/** Remote paths one provisioning attempt writes. */
export interface ProvisionPlacement {
  /** Configured remote entry the connection launches, and the path every attempt replaces. */
  readonly helper: string
  /** Directory holding content-addressed payloads beside the installed entry. */
  readonly directory: string
  /** Payload directory named by the verified entry digest. */
  readonly content: string
  /** Archive payload root inside {@link content}. */
  readonly payload: string
  /** Installed entry inside {@link payload}; the link target the connection launches. */
  readonly entry: string
  /** Archive this attempt transfers. */
  readonly archive: string
  /** Directory this attempt extracts into before the payload is placed. */
  readonly staging: string
  /** Link this attempt creates, renamed atomically onto {@link helper}. */
  readonly link: string
}

/**
 * Read the entry digest a release archive declares, and the digest of the archive bytes.
 * @param source - absolute host-local path to the release tar.gz.
 * @returns both digests the remote installation checks.
 */
export async function inspectProvisionArchive(source: string): Promise<ProvisionPlan> {
  try {
    const archiveHash = await digestFile(source)
    const manifest = manifestSchema.parse(JSON.parse((await readArchiveFile(source, `${PAYLOAD_ROOT}/manifest.json`)).toString('utf8')))
    const entry = manifest.files.find(file => file.path === ENTRY_PATH)
    if (entry === undefined) throw new Error(`manifest.json declares no ${ENTRY_PATH} entry`)
    return { source, archiveHash, entryHash: entry.sha256 }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new Error(`SSH helper provisioning cannot read ${source}: ${detail}`)
  }
}

/**
 * Derive the remote paths one attempt writes beside the configured entry.
 * @param helper - absolute remote entry the connection launches.
 * @param entryHash - verified digest naming the payload directory.
 * @returns the paths of one attempt.
 */
export function createPlacement(helper: string, entryHash: string): ProvisionPlacement {
  const parent = posix.dirname(helper)
  const directory = posix.join(parent, '.dsh-provision')
  const content = posix.join(directory, entryHash)
  const payload = posix.join(content, PAYLOAD_ROOT)
  const nonce = randomBytes(4).toString('hex')
  return {
    helper,
    directory,
    content,
    payload,
    entry: posix.join(payload, ENTRY_PATH),
    archive: posix.join(parent, `.dsh-provision-${nonce}.tgz`),
    staging: posix.join(directory, `.partial-${nonce}`),
    link: `${helper}.new.${nonce}`,
  }
}

/**
 * Report the digest of the installed entry, or why it cannot be computed.
 * @param helper - absolute remote entry the connection launches.
 * @returns the remote shell script.
 */
export function probeScript(helper: string): string {
  return [
    `command -v sha256sum >/dev/null 2>&1 || { echo 'dsh-provision: sha256sum is unavailable on the remote host' >&2; exit ${NO_SHA256SUM_EXIT}; }`,
    `if [ ! -f ${shellWord(helper)} ]; then echo 'dsh-provision: the configured helper entry is absent' >&2; exit ${MISSING_ENTRY_EXIT}; fi`,
    `sha256sum ${shellWord(helper)}`,
  ].join('\n')
}

/**
 * Receive the archive bytes on the standard input of this command.
 * @param placement - paths of this attempt.
 * @returns the remote shell script.
 */
export function receiveScript(placement: ProvisionPlacement): string {
  return [
    `mkdir -p ${shellWord(posix.dirname(placement.archive))} || exit 95`,
    `cat > ${shellWord(placement.archive)}`,
  ].join('\n')
}

/**
 * Verify the transferred archive, extract it beside the installed entry, and link the entry into place.
 * @param placement - paths of this attempt.
 * @param archiveHash - digest of the archive bytes the host read.
 * @returns the remote shell script.
 */
export function installScript(placement: ProvisionPlacement, archiveHash: string): string {
  const staged = posix.join(placement.staging, PAYLOAD_ROOT)
  const stagedEntry = posix.join(staged, ENTRY_PATH)
  return [
    'set -u',
    `[ "$(sha256sum ${shellWord(placement.archive)} | cut -c1-64)" = ${archiveHash} ] || { echo 'dsh-provision: the transferred archive differs from the host archive' >&2; exit ${ARCHIVE_DIGEST_EXIT}; }`,
    `if [ ! -f ${shellWord(placement.entry)} ]; then`,
    `  mkdir -p ${shellWord(placement.content)} || exit 99`,
    `  if [ -e ${shellWord(placement.payload)} ]; then echo 'dsh-provision: the payload directory holds a different entry' >&2; exit 99; fi`,
    `  mkdir -p ${shellWord(placement.staging)} || exit 99`,
    `  tar -xzf ${shellWord(placement.archive)} -C ${shellWord(placement.staging)} || { rm -rf ${shellWord(placement.staging)}; echo 'dsh-provision: the transferred archive did not extract' >&2; exit 99; }`,
    `  [ -f ${shellWord(stagedEntry)} ] || { rm -rf ${shellWord(placement.staging)}; echo 'dsh-provision: the archive omits the ${PAYLOAD_ROOT} entry' >&2; exit 99; }`,
    `  chmod 0755 ${shellWord(stagedEntry)} || { rm -rf ${shellWord(placement.staging)}; echo 'dsh-provision: the extracted entry is not executable' >&2; exit 99; }`,
    `  mv ${shellWord(staged)} ${shellWord(placement.content)}/ || { rm -rf ${shellWord(placement.staging)}; echo 'dsh-provision: the extracted payload could not be placed' >&2; exit 99; }`,
    `  rm -rf ${shellWord(placement.staging)}`,
    'fi',
    `chmod 0755 ${shellWord(placement.entry)} || exit 100`,
    `ln -s ${shellWord(placement.entry)} ${shellWord(placement.link)} || exit 100`,
    `mv -f ${shellWord(placement.link)} ${shellWord(placement.helper)} || exit 100`,
    `rm -f ${shellWord(placement.archive)}`,
  ].join('\n')
}

/**
 * Remove everything one attempt wrote except an already placed payload, after a failed installation.
 * @param placement - paths of this attempt.
 * @returns the remote shell script.
 */
export function cleanupScript(placement: ProvisionPlacement): string {
  return [
    `rm -rf ${shellWord(placement.staging)}`,
    `rm -f ${shellWord(placement.archive)} ${shellWord(placement.link)}`,
  ].join('\n')
}

/**
 * Read the digest a probe reported on standard output.
 * @param stdout - probe standard output.
 * @returns the lowercase SHA-256, or nothing when the probe reported none.
 */
export function probeDigest(stdout: string): string | undefined {
  return /^([0-9a-f]{64})/.exec(stdout.trim())?.[1]
}

/**
 * Hash one file without holding it in memory.
 * @param source - file path.
 * @returns lowercase SHA-256 of its bytes.
 */
function digestFile(source: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    const stream = createReadStream(source)
    stream.on('data', (chunk: string | Buffer) => { hash.update(chunk) })
    stream.once('error', (error: Error) => { reject(error) })
    stream.once('end', () => { resolve(hash.digest('hex')) })
  })
}

/**
 * Read one file out of a ustar archive. Only a small manifest is needed, so this reads headers
 * directly rather than adding an archive dependency to the client.
 * @param source - host-local tar.gz path.
 * @param wanted - archive-relative POSIX path.
 * @returns the file bytes.
 */
async function readArchiveFile(source: string, wanted: string): Promise<Buffer> {
  const stream = createReadStream(source).pipe(createGunzip()) as AsyncIterable<Buffer>
  const iterator = stream[Symbol.asyncIterator]()
  let pending: Buffer = Buffer.alloc(0)
  const pull = async (): Promise<void> => {
    const next = await iterator.next()
    if (next.done === true) throw new Error(`the archive ends before ${wanted}`)
    pending = pending.length === 0 ? next.value : Buffer.concat([pending, next.value])
  }
  const take = async (size: number): Promise<Buffer> => {
    while (pending.length < size) await pull()
    const value = pending.subarray(0, size)
    pending = pending.subarray(size)
    return value
  }
  let first = true
  for (;;) {
    const header = await take(512)
    if (header.every(byte => byte === 0)) break
    if (first) {
      if (header.subarray(257, 262).toString('ascii') !== 'ustar') throw new Error('the archive is not a ustar tar.gz')
      first = false
    }
    const size = headerSize(header)
    const padded = size + ((512 - (size % 512)) % 512)
    if (isRegularFile(header) && headerName(header) === wanted) return await take(size)
    await take(padded)
  }
  throw new Error(`the archive contains no ${wanted}`)
}

/**
 * Read the size field of one tar header.
 * @param header - one 512-byte header block.
 * @returns the payload size in bytes.
 */
function headerSize(header: Buffer): number {
  const leading = header[124]
  if (leading === undefined) throw new Error('the archive header is truncated')
  if ((leading & 0x80) !== 0) {
    let size = leading & 0x7f
    for (let index = 125; index < 136; index += 1) size = size * 256 + (header[index] ?? 0)
    return size
  }
  const octal = nulTerminated(header.subarray(124, 136)).trim()
  const size = Number.parseInt(octal, 8)
  if (!Number.isSafeInteger(size) || size < 0) throw new Error(`the archive header declares an invalid size: ${octal}`)
  return size
}

/**
 * Read the path field of one tar header, including its ustar prefix.
 * @param header - one 512-byte header block.
 * @returns the archive-relative POSIX path.
 */
function headerName(header: Buffer): string {
  const name = nulTerminated(header.subarray(0, 100))
  const prefix = nulTerminated(header.subarray(345, 500))
  return prefix === '' ? name : `${prefix}/${name}`
}

/**
 * Read one NUL-terminated header field.
 * @param field - the field bytes.
 * @returns the text before the terminator.
 */
function nulTerminated(field: Buffer): string {
  const end = field.indexOf(0)
  return field.subarray(0, end === -1 ? field.length : end).toString('utf8')
}

/**
 * Whether one tar header names a regular file rather than a directory or an extended header.
 * @param header - one 512-byte header block.
 * @returns whether the entry carries file bytes.
 */
function isRegularFile(header: Buffer): boolean {
  const type = header[156]
  return type === undefined || type === 0 || type === 0x30
}
