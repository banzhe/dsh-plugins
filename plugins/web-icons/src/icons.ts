/**
 * The icon set this Bundle serves: one immutable snapshot of the DSH Web
 * launcher artwork.
 *
 * The files are the bytes committed under `apps/web/public` in the DSH source at
 * the revision this Bundle snapshots. They live inside the package because a
 * Bundle must not depend on a DSH checkout: the served artwork has to survive an
 * upgrade, a reinstall, or a machine that never had the source
 * (see docs/adr/0010).
 *
 * Nothing is cached: every response is derived from the file as it is now, so
 * refreshing the snapshot in place under a `link:` install changes both the bytes
 * and the validator without restarting the Host. A revalidation and a HEAD cost
 * one `stat`, not a read — {@link inspectIcon} exists for exactly that.
 *
 * The missing-file codes and the extension-to-media-type decisions below are
 * local restatements of tables the harness keeps private in
 * `@deepseek-ai/dsh-host-frontend-static`. Importing them is not possible (the
 * package exports neither table and is absent from this workspace's catalog), and
 * a peer dependency taken for four string constants would widen every profile's
 * dependency surface — so they stay here.
 */

import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** One served icon: the browser-facing pathname and the packaged asset behind it. */
export interface IconRoute {
  /** Absolute pathname the browser requests. */
  readonly path: string
  /** File name under {@link ASSET_DIRECTORY}. */
  readonly asset: string
  /** `content-type` of the response. */
  readonly contentType: string
}

/**
 * The takeover set.
 *
 * Seven of these pathnames are exactly the ones the Web document and its
 * manifest reference, and exactly the ones the Desktop shell answers by itself
 * for its own window — those seven are the reason this plugin is invisible
 * there. `favicon-dark.svg` is the exception: the shell does not claim it, so
 * this plugin answers it inside the window too. It is part of the source artwork
 * although nothing references it, and it is served so the snapshot stays whole.
 *
 * `favicon.svg` is deliberately absent: the source retired that mark, and the
 * harness's own build test requires the dist not to ship it.
 */
export const ICON_ROUTES: readonly IconRoute[] = [
  { path: '/favicon.ico', asset: 'favicon.ico', contentType: 'image/vnd.microsoft.icon' },
  { path: '/favicon-dark.svg', asset: 'favicon-dark.svg', contentType: 'image/svg+xml' },
  { path: '/icon-192.png', asset: 'icon-192.png', contentType: 'image/png' },
  { path: '/icon-512.png', asset: 'icon-512.png', contentType: 'image/png' },
  { path: '/icon-maskable-192.png', asset: 'icon-maskable-192.png', contentType: 'image/png' },
  { path: '/icon-maskable-512.png', asset: 'icon-maskable-512.png', contentType: 'image/png' },
  { path: '/apple-touch-icon.png', asset: 'apple-touch-icon.png', contentType: 'image/png' },
  { path: '/manifest.webmanifest', asset: 'manifest.webmanifest', contentType: 'application/manifest+json' },
]

/** Absolute snapshot directory, resolved from this module rather than from the cwd. */
export const ASSET_DIRECTORY = fileURLToPath(new URL('../assets/', import.meta.url))

/** One asset's identity on disk: what a validator and a response need before its bytes. */
export interface IconFile {
  /** Byte length. */
  readonly size: number
  /** Modification time in milliseconds. */
  readonly mtimeMs: number
  /** Validator over both, as the response sends it. */
  readonly etag: string
}

/** Filesystem codes that mean "no readable file here", not "the read failed". */
const MISSING_CODES: ReadonlySet<string> = new Set(['ENOENT', 'EISDIR', 'ENOTDIR'])

/**
 * Whether a rejection is the filesystem reporting no readable file, rather than
 * a failure worth propagating. A rejection carrying no `code` at all is a
 * failure: treating it as absence would report a broken read as a missing file.
 * @param error - the caught value.
 * @returns True when the file is simply not there.
 */
export function isMissing(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null | undefined)?.code
  return typeof code === 'string' && MISSING_CODES.has(code)
}

/** The one place a probed path is composed, so a report names what was probed. */
function iconPath(asset: string, directory: string): string {
  return join(directory, asset)
}

/**
 * Compose the weak validator for one asset: size plus millisecond mtime.
 * Refreshing the snapshot copies files, which moves mtime, so a replaced icon
 * never keeps the validator of the icon it replaced.
 * @param size - byte length on disk.
 * @param mtimeMs - modification time in milliseconds.
 * @returns A weak entity tag.
 */
export function etagOf(size: number, mtimeMs: number): string {
  return `W/"${String(size)}-${String(Math.trunc(mtimeMs))}"`
}

/**
 * Read one asset's identity without its bytes.
 * @param asset - file name under the snapshot directory.
 * @param directory - snapshot directory; only tests pass another one.
 * @returns identity, or undefined when no readable file is there.
 */
export async function inspectIcon(asset: string, directory: string = ASSET_DIRECTORY): Promise<IconFile | undefined> {
  try {
    const info = await stat(iconPath(asset, directory))
    if (!info.isFile()) return undefined
    return { size: info.size, mtimeMs: info.mtimeMs, etag: etagOf(info.size, info.mtimeMs) }
  } catch (error) {
    if (isMissing(error)) return undefined
    throw error
  }
}

/**
 * Read one asset's bytes, which only a response that carries them needs.
 * @param asset - file name under the snapshot directory.
 * @param directory - snapshot directory; only tests pass another one.
 * @returns bytes, or undefined when no readable file is there.
 */
export async function readIcon(asset: string, directory: string = ASSET_DIRECTORY): Promise<Buffer | undefined> {
  try {
    return await readFile(iconPath(asset, directory))
  } catch (error) {
    if (isMissing(error)) return undefined
    throw error
  }
}

/**
 * Refuse activation on an incomplete snapshot: routes are registered only once
 * every asset is there, so a half-installed Bundle cannot serve a mix of new
 * icons and the dist's old ones. Identity only — the bytes wait for a request
 * that carries them.
 * @param routes - the takeover set.
 * @param directory - snapshot directory; only tests pass another one.
 */
export async function assertIconsPresent(
  routes: readonly IconRoute[] = ICON_ROUTES,
  directory: string = ASSET_DIRECTORY,
): Promise<void> {
  const missing: string[] = []
  for (const route of routes) {
    if (await inspectIcon(route.asset, directory) === undefined) missing.push(iconPath(route.asset, directory))
  }
  if (missing.length > 0) throw new Error(`web-icons: snapshot is missing ${missing.join(', ')}`)
}

/**
 * Compare a request's `if-none-match` against the validator this response would
 * carry. Weakness is ignored on both sides: a snapshot that reaches the client
 * byte-for-byte is the only thing being asserted.
 * @param header - the raw header value, when the request carried one.
 * @param etag - the validator of the bytes on disk now.
 * @returns True when the client already holds these bytes.
 */
export function matchesEtag(header: string | undefined, etag: string): boolean {
  if (header === undefined) return false
  const strip = (value: string): string => value.startsWith('W/') ? value.slice(2) : value
  const expected = strip(etag)
  return header.split(',').some((candidate) => {
    const value = candidate.trim()
    return value === '*' || strip(value) === expected
  })
}
