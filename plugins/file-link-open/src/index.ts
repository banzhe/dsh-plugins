/**
 * @banzhe/dsh-file-link-open — Host half. Two routes on the shared
 * authenticated `/api` channel, both behind the composition's `connection`
 * trust fence:
 *
 * - GET  /api/file-link-open/info    → the app ids this plugin's own resolution
 *   pass verified on this machine, so the browser can intersect them with the
 *   official open-in-app probe and never show an item that would answer 400.
 * - POST /api/file-link-open/launch  → open one existing file (or directory)
 *   in a whitelisted editor, optionally revealing a line. Resolution reuses the
 *   official `@deepseek-ai/dsh-host-open-in-app` resolver; the line and
 *   window-reuse edits on top of it live in `./launch-args.ts`.
 *
 * Bodies are bounded JSON, app ids are whitelist-checked, and paths must be
 * absolute and exist on disk. Launches spawn detached through the official
 * launcher with a credential-scrubbed environment.
 *
 * Implementation derived from https://github.com/cholf5/dsh-plugin-file-actions
 */

import { stat } from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { launchEnvironmentOf, launchedThroughSsh } from '@deepseek-ai/dsh-launch-environment'
import type { Context } from '@deepseek-ai/cordis'
import { EDITOR_IDS } from './editors.ts'
import { withLaunchArgs, type ResolvedLaunch } from './launch-args.ts'
import { INFO_PATH, LAUNCH_PATH } from './routes.ts'

/** Cordis function-plugin name. */
export const name = 'file-link-open'

/**
 * The route carrier, the trust fence guarding every route, and the subprocess
 * capability the official resolver uses for PATH lookups (the same service the
 * official open-in-app host injects).
 */
export const inject = ['webServer', 'connection', 'subprocess']

/** The editor whitelist; the arg tables in `launch-args.ts` are keyed by these ids. */
export { EDITOR_IDS }

/** Module layouts of the official resolver/catalog across published versions. */
const RESOLVER_LAYOUTS = ['lib/types/resolver.js', 'lib/resolver.js']
const CATALOG_LAYOUTS = ['lib/types/catalog.js', 'lib/catalog.js']

/**
 * The installed official package's root, reached through its exported
 * `./package.json` subpath: the package's exports map blocks deep specifier
 * imports, but a resolved file URL inside the package is a plain module import.
 */
function officialPackageRoot() {
  const require = createRequire(import.meta.url)
  try {
    return path.dirname(require.resolve('@deepseek-ai/dsh-host-open-in-app/package.json'))
  }
  catch (error) {
    throw new Error(
      'file-link-open: the official dependency @deepseek-ai/dsh-host-open-in-app is not resolvable from this plugin'
      + ' (for link: installs run `pnpm install` inside the plugin first; for registry/git installs reinstall with'
      + ' `dsh plugin --profile web update @banzhe/dsh-file-link-open -w`)',
      { cause: error },
    )
  }
}

async function importFirstLayout(root: string, candidates: string[]): Promise<unknown> {
  let lastError: unknown
  for (const candidate of candidates) {
    try {
      // Reached by resolved file URL, so the module's own type is not statically
      // visible; `loadOfficialOpenInApp` validates the shape it gets back.
      return (await import(pathToFileURL(path.join(root, candidate)).href)) as unknown
    }
    catch (error) {
      lastError = error
    }
  }
  throw new Error(
    `file-link-open: none of the official module layouts exist under ${root}: ${candidates.join(', ')}`,
    { cause: lastError },
  )
}

/** Trust surface consumed here; the browser-side connection package owns the full type. */
interface ConnectionLike {
  requestRejection(req: unknown): number | undefined
}

/**
 * One resolution's fields, as much of them as this plugin drives and reads: the
 * official resolver's own type is not statically visible across the file-URL
 * import (the package exports only its root and `./shared`), so the surface used
 * here is declared and then validated at load.
 */
interface OfficialResolver {
  resolveOpenInAppApps(timeoutMs: number, internals: ResolverInternals): Promise<Map<string, ResolvedLaunch>>
  /** Takes the catalog ROW, not its id: the official locator table comes from `app.platforms`. */
  resolveLaunch(app: OfficialCatalogEntry, timeoutMs: number, internals: ResolverInternals): Promise<ResolvedLaunch | null>
  launchResolved(target: ResolvedLaunch, path: string, timeoutMs: number, internals: ResolverInternals): Promise<LaunchOutcome>
}

/** How one official launch attempt ended; `missing` marks a stale resolution (ENOENT). */
type LaunchOutcome = 'launched' | 'missing' | 'failed'

/** One detached GUI launch: spawn, then watch the window for early failure. */
type LauncherHook = (command: string, args: readonly string[], options: {
  readonly watchMs: number
  readonly env?: Readonly<Record<string, string>> | undefined
  readonly windowsHide?: boolean | undefined
}) => Promise<void>

/** The resolver's injectable hooks; only the ones this plugin (or a spec) supplies. */
interface ResolverInternals {
  readonly ssh?: boolean | undefined
  readonly launch?: LauncherHook | undefined
  readonly resolveExecutable: (command: string) => Promise<string | null>
}

/**
 * One official catalog row. Only `id` is read here, but the resolver rebuilds a
 * row's locator table from `platforms`, so the row is carried through whole
 * rather than reconstructed from its id.
 */
interface OfficialCatalogEntry {
  readonly id: string
  readonly platforms: Readonly<Record<string, unknown>>
}

/** The official detection catalog: the rows and its own `{path}` placeholder. */
interface OfficialCatalog {
  readonly OPEN_IN_APP_CATALOG: readonly OfficialCatalogEntry[]
  readonly PATH_TOKEN: string
}

function isFunction(value: unknown): value is (...args: never[]) => unknown {
  return typeof value === 'function'
}

/** A usable row: `id` is what the menu intersects, `platforms` what a re-resolution reads. */
function isCatalogEntry(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false
  const row = value as { id?: unknown, platforms?: unknown }
  return typeof row.id === 'string' && typeof row.platforms === 'object' && row.platforms !== null
}

/** The resolver module, or null when it does not expose the three functions used here. */
function officialResolverOf(value: unknown): OfficialResolver | null {
  if (typeof value !== 'object' || value === null) return null
  const candidate = value as Record<string, unknown>
  if (
    !isFunction(candidate.resolveOpenInAppApps)
    || !isFunction(candidate.resolveLaunch)
    || !isFunction(candidate.launchResolved)
  ) {
    return null
  }
  return candidate as unknown as OfficialResolver
}

/** The catalog module, or null when its rows or path token are unusable. */
function officialCatalogOf(value: unknown): OfficialCatalog | null {
  if (typeof value !== 'object' || value === null) return null
  const { OPEN_IN_APP_CATALOG: rows, PATH_TOKEN: pathToken } = value as {
    OPEN_IN_APP_CATALOG?: unknown
    PATH_TOKEN?: unknown
  }
  if (!Array.isArray(rows) || !rows.every(isCatalogEntry)) return null
  if (typeof pathToken !== 'string' || pathToken === '') return null
  return { OPEN_IN_APP_CATALOG: rows as unknown as readonly OfficialCatalogEntry[], PATH_TOKEN: pathToken }
}

/**
 * Load the official open-in-app resolver and catalog from the installed
 * dependency — the exact detection and launch layer the official host routes
 * run, tried against every layout the published versions shipped.
 */
export async function loadOfficialOpenInApp(): Promise<{
  resolver: OfficialResolver
  catalog: readonly OfficialCatalogEntry[]
  pathToken: string
}> {
  const root = officialPackageRoot()
  const [resolverModule, catalogModule] = await Promise.all([
    importFirstLayout(root, RESOLVER_LAYOUTS),
    importFirstLayout(root, CATALOG_LAYOUTS),
  ])
  const resolver = officialResolverOf(resolverModule)
  const catalog = officialCatalogOf(catalogModule)
  if (resolver === null || catalog === null) {
    throw new Error('file-link-open: the official open-in-app package loaded but does not expose the expected resolver API')
  }
  return { resolver, catalog: catalog.OPEN_IN_APP_CATALOG, pathToken: catalog.PATH_TOKEN }
}

/** The Node request surface these routes read; an unread body is drained, not left open. */
interface RouteRequest extends AsyncIterable<Buffer> {
  readonly method?: string | undefined
  readonly headers: Record<string, string | string[] | undefined>
  resume(): void
}

/** The Node response surface these routes write. */
interface RouteResponse {
  statusCode: number
  setHeader(name: string, value: string): void
  end(body?: string): void
}

/** The subprocess capability the official resolver uses for PATH lookups. */
interface SubprocessLike {
  /** Resolves one command to its absolute path; throws when it is not on PATH. */
  resolveExecutable(command: string): Promise<string>
}

/** The route carrier; `register` returns this plugin's disposer. */
interface WebServerLike {
  register(route: {
    kind: 'exact'
    path: string
    handler: (req: RouteRequest, res: RouteResponse) => Promise<void>
  }): () => void
}

/**
 * The three Cordis services this plugin injects. `Context` is typed by the
 * packages a Bundle declares; these three arrive from the composition, so the
 * slice actually used is declared here and read through one cast each.
 */
function connectionOf(ctx: Context): ConnectionLike {
  return (ctx as unknown as { connection: ConnectionLike }).connection
}

function subprocessOf(ctx: Context): SubprocessLike {
  return (ctx as unknown as { subprocess: SubprocessLike }).subprocess
}

function webServerOf(ctx: Context): WebServerLike {
  return (ctx as unknown as { webServer: WebServerLike }).webServer
}

/** Answer an untrusted/unauthenticated request; true when it was rejected. */
function rejected(connection: ConnectionLike, req: unknown, res: RouteResponse) {
  const rejection = connection.requestRejection(req)
  if (rejection === undefined) return false
  res.statusCode = rejection
  res.end()
  return true
}

/** Open-route request bodies are tiny JSON objects; anything larger is hostile. */
const MAX_BODY_BYTES = 64 * 1024

/** JSON response (no-store: outcomes are live facts). */
function sendJson(res: RouteResponse, status: number, payload: unknown) {
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(JSON.stringify(payload))
}

/** 405 with the route's one supported method. */
function sendMethodNotAllowed(res: RouteResponse, allow: string) {
  res.statusCode = 405
  res.setHeader('allow', allow)
  res.end()
}

/**
 * Collect a bounded request body as UTF-8 text; null past the ceiling.
 *
 * A too-large body is drained rather than left unread: an unread stream holds
 * the socket open, and this route answers 413 immediately.
 */
async function readBoundedBody(req: RouteRequest): Promise<string | null> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.byteLength
    if (size > MAX_BODY_BYTES) {
      req.resume()
      return null
    }
    chunks.push(chunk)
  }
  return Buffer.concat(chunks, size).toString('utf8')
}

/** One validated launch request: an app id, an absolute path, and an optional line. */
interface LaunchRequest {
  readonly app: string
  readonly path: string
  /** 1-based line to reveal; absent when the link named no line. */
  readonly line?: number
}

/**
 * Validate one POST body at the wire: JSON object with string app/path and an
 * optional positive-integer line. Null means the shape or the line is invalid.
 */
export function parseBody(text: string): LaunchRequest | null {
  let body: unknown
  try {
    body = JSON.parse(text)
  }
  catch {
    return null
  }
  if (typeof body !== 'object' || body === null) return null
  const { app, path: bodyPath, line } = body as Record<string, unknown>
  if (typeof app !== 'string' || typeof bodyPath !== 'string') return null
  if (line === undefined) return { app, path: bodyPath }
  // A malformed line is rejected rather than dropped: silently opening at the
  // top would hide a client bug behind a plausible-looking launch.
  if (typeof line !== 'number' || !Number.isSafeInteger(line) || line < 1) return null
  return { app, path: bodyPath, line }
}

async function pathExists(absolute: string) {
  try {
    await stat(absolute)
    return true
  }
  catch {
    return false
  }
}

/** Register the info and launch routes behind the connection trust fence. */
export async function apply(ctx: Context) {
  const launchTimeoutMs = 10_000

  // SSH detection asks the Cordis context getter; a host without one simply
  // is not SSH (the official /apps probe stays the real visibility gate).
  const ssh = (() => {
    try {
      return launchedThroughSsh(launchEnvironmentOf(ctx))
    }
    catch {
      return false
    }
  })()

  /** The composition's PATH resolver, completed like the official host's. */
  const resolveExecutableOf = async (command: string): Promise<string | null> => {
    try {
      return await subprocessOf(ctx).resolveExecutable(command)
    }
    catch {
      return null
    }
  }

  /** Platform facts per resolver call; the resolver fills its own launcher default. */
  const internalsOf = () => ({
    ssh,
    launch: undefined,
    resolveExecutable: resolveExecutableOf,
  })

  /** The official resolver bundle, loaded once at activation. */
  const bundle = await loadOfficialOpenInApp()

  /**
   * Lazy once-per-plugin-life resolution; the map is the mutable authority.
   * Typed through this plugin's own launch shape because the resolver is loaded
   * dynamically, so its own type is not statically visible here.
   */
  let resolutionsTask: Promise<Map<string, ResolvedLaunch>> | undefined
  const availability = (): Promise<Map<string, ResolvedLaunch>> => resolutionsTask
    ??= bundle.resolver.resolveOpenInAppApps(launchTimeoutMs, internalsOf())

  /** Replace one stale resolution after a missing-executable launch, as the official host does. */
  const refreshResolution = async (app: OfficialCatalogEntry) => {
    const map = await availability()
    const fresh = await bundle.resolver.resolveLaunch(app, launchTimeoutMs, internalsOf())
    if (fresh === null) {
      map.delete(app.id)
      return undefined
    }
    map.set(app.id, fresh)
    return fresh
  }

  // Warm the detection pass at activation so the first info/launch after a
  // dsh web restart answers from the memoized map instead of a cold registry
  // sweep (fire-and-forget: every locator failure is swallowed inside the
  // resolver as "unavailable").
  availability().catch(() => {})

  /** Read + validate one JSON POST body, answering failures; null when invalid. */
  const readPost = async (req: RouteRequest, res: RouteResponse): Promise<LaunchRequest | null> => {
    const essence = String(req.headers['content-type']).split(';', 1)[0]?.trim().toLowerCase()
    if (essence !== 'application/json') {
      sendJson(res, 415, { code: 'unsupported-media-type', message: 'content-type must be application/json' })
      return null
    }
    let text: string | null
    try {
      text = await readBoundedBody(req)
    }
    catch {
      sendJson(res, 400, { code: 'bad-request', message: 'request body unreadable' })
      return null
    }
    if (text === null) {
      sendJson(res, 413, { code: 'payload-too-large', message: 'request body is too large' })
      return null
    }
    const parsed = parseBody(text)
    if (parsed === null) {
      sendJson(res, 400, { code: 'bad-request', message: 'request body does not match the route schema' })
      return null
    }
    return parsed
  }

  ctx.effect(() => webServerOf(ctx).register({
    kind: 'exact',
    path: INFO_PATH,
    handler: async (req: RouteRequest, res: RouteResponse) => {
      if (rejected(connectionOf(ctx), req, res)) return
      if (req.method !== 'GET') {
        sendMethodNotAllowed(res, 'GET')
        return
      }
      // The ids this plugin's own resolver pass verified. The browser
      // intersects them with the official probe result, so a version skew
      // between the two resolver copies can never show an item that would
      // answer 400.
      const available = await availability()
        .then((map) => [...map.keys()])
        .catch(() => [])
      sendJson(res, 200, { available })
    },
  }), `file-link-open: GET ${INFO_PATH}`)

  ctx.effect(() => webServerOf(ctx).register({
    kind: 'exact',
    path: LAUNCH_PATH,
    handler: async (req: RouteRequest, res: RouteResponse) => {
      if (rejected(connectionOf(ctx), req, res)) return
      if (req.method !== 'POST') {
        sendMethodNotAllowed(res, 'POST')
        return
      }
      const parsed = await readPost(req, res)
      if (parsed === null) return
      if (!path.isAbsolute(parsed.path)) {
        sendJson(res, 400, { code: 'bad-request', message: 'path must be absolute' })
        return
      }
      if (!await pathExists(parsed.path)) {
        sendJson(res, 404, { code: 'not-found', message: `path does not exist: ${parsed.path}` })
        return
      }
      if (ssh || !(EDITOR_IDS as readonly string[]).includes(parsed.app)) {
        sendJson(res, 400, { code: 'unavailable-app', message: `unknown or unavailable app: ${parsed.app}` })
        return
      }
      const app = bundle.catalog.find(entry => entry.id === parsed.app)
      const resolved = app === undefined ? undefined : (await availability()).get(app.id)
      if (app === undefined || resolved === undefined) {
        sendJson(res, 400, { code: 'unavailable-app', message: `unknown or unavailable app: ${parsed.app}` })
        return
      }
      // The line (if the link named one) and the window-reuse switch are applied
      // to the resolution's own argv; see launch-args.ts.
      const target = withLaunchArgs(resolved, parsed.app, parsed.line, bundle.pathToken)
      let outcome = await bundle.resolver.launchResolved(target, parsed.path, launchTimeoutMs, internalsOf())
      if (outcome === 'missing') {
        const fresh = await refreshResolution(app)
        outcome = fresh === undefined
          ? 'failed'
          : await bundle.resolver.launchResolved(
            withLaunchArgs(fresh, parsed.app, parsed.line, bundle.pathToken),
            parsed.path, launchTimeoutMs, internalsOf(),
          )
      }
      if (outcome === 'launched') sendJson(res, 200, { ok: true })
      else sendJson(res, 502, { code: 'launch-failed', message: `failed to launch ${parsed.app}` })
    },
  }), `file-link-open: POST ${LAUNCH_PATH}`)
}