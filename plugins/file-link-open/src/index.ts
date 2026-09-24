/**
 * @banzhe/dsh-file-link-open — Host half.
 *
 * File-open complement for the right-click menu this plugin adds over file
 * links rendered inside session messages (file mentions and markdown file
 * links). Two routes on the shared authenticated `/api` channel:
 *
 * - GET  /api/file-link-open/info    → the editor whitelist and the app ids
 *   this plugin's own resolution pass verified on this machine, so the
 *   browser can intersect them with the official open-in-app probe and
 *   never show an item that would answer 400.
 * - POST /api/file-link-open/launch  → open one existing file (or directory)
 *   in a whitelisted editor/IDE. The app is resolved by the official
 *   `@deepseek-ai/dsh-host-open-in-app` resolver — the same locators the
 *   official routes use (macOS `.app` bundles, Windows `App Paths` registry /
 *   Uninstall records / `%ProgramFiles%` scans, Linux PATH names and desktop
 *   entries) — and launched with the file path appended.
 *
 * Security: every route asks the composition's `connection` service for a
 * rejection first (Host/Origin fence + browser authentication, the same
 * model as the official open-in-app host), bodies are bounded JSON, app ids
 * are whitelist-checked against the editor set, the resolver only resolves
 * catalog entries, and paths must be absolute and exist on disk. Launches
 * spawn detached through the official launcher with a credential-scrubbed
 * environment.
 *
 * Implementation derived from https://github.com/cholf5/dsh-plugin-file-actions
 */

import { stat } from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { launchEnvironmentOf, launchedThroughSsh } from '@deepseek-ai/dsh-launch-environment'
import type { Context } from '@deepseek-ai/cordis'

/** Cordis function-plugin name. */
export const name = 'file-link-open'

/**
 * The route carrier, the trust fence guarding every route, and the subprocess
 * capability the official resolver uses for PATH lookups (the same service the
 * official open-in-app host injects).
 */
export const inject = ['webServer', 'connection', 'subprocess']

/**
 * Official open-in-app catalog ids this plugin launches, with labels on the
 * browser side. File managers (finder/explorer/filemanager) are excluded: the
 * browser half offers them from the official probe alone and launches them
 * through the official POST /open-in-app/open route with the file's directory
 * — the exact call the session-header menu makes — because a file-manager
 * shell-open with the file path would open the file in its default app instead.
 */
export const EDITOR_IDS = [
  'cursor', 'vscode', 'vscodeinsiders', 'windsurf', 'zed', 'sublimetext',
  'androidstudio', 'intellij', 'pycharm', 'webstorm', 'phpstorm',
  'goland', 'rider', 'rustrover',
] as const

/** Module layouts of the official resolver/catalog across published versions. */
const RESOLVER_LAYOUTS = ['lib/types/resolver.js', 'lib/resolver.js']
const CATALOG_LAYOUTS = ['lib/types/catalog.js', 'lib/catalog.js']

/**
 * The installed official package's root, reached through its exported
 * `./package.json` subpath (the exports map blocks deep specifier imports,
 * but a resolved file URL inside the package is a plain module import).
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

/** Import the first module layout that exists among the candidates. */
async function importFirstLayout(root: string, candidates: string[]) {
  let lastError
  for (const candidate of candidates) {
    try {
      return await import(pathToFileURL(path.join(root, candidate)).href)
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
 * Load the official open-in-app resolver and catalog from the installed
 * dependency — the exact detection and launch layer the official host routes
 * run, tried against every layout the published versions shipped.
 */
export async function loadOfficialOpenInApp() {
  const root = officialPackageRoot()
  const [resolver, catalog] = await Promise.all([
    importFirstLayout(root, RESOLVER_LAYOUTS),
    importFirstLayout(root, CATALOG_LAYOUTS),
  ])
  if (
    typeof resolver.resolveOpenInAppApps !== 'function'
    || typeof resolver.resolveLaunch !== 'function'
    || typeof resolver.launchResolved !== 'function'
    || !Array.isArray(catalog.OPEN_IN_APP_CATALOG)
  ) {
    throw new Error('file-link-open: the official open-in-app package loaded but does not expose the expected resolver API')
  }
  return { resolver, catalog: catalog.OPEN_IN_APP_CATALOG }
}

/** Answer an untrusted/unauthenticated request; true when it was rejected. */
function rejected(connection: ConnectionLike, req: unknown, res: { statusCode: number, end(): void }) {
  const rejection = connection.requestRejection(req)
  if (rejection === undefined) return false
  res.statusCode = rejection
  res.end()
  return true
}

/** Open-route request bodies are tiny JSON objects; anything larger is hostile. */
const MAX_BODY_BYTES = 64 * 1024

/** JSON response (no-store: outcomes are live facts). */
function sendJson(res: any, status: number, payload: unknown) { // eslint-disable-line @typescript-eslint/no-explicit-any
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(JSON.stringify(payload))
}

/** 405 with the route's one supported method. */
function sendMethodNotAllowed(res: any, allow: string) { // eslint-disable-line @typescript-eslint/no-explicit-any
  res.statusCode = 405
  res.setHeader('allow', allow)
  res.end()
}

/** Collect a bounded request body as UTF-8 text; null past the ceiling (stream drained). */
async function readBoundedBody(req: any): Promise<string | null> { // eslint-disable-line @typescript-eslint/no-explicit-any
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

/** Validate one POST body at the wire: JSON object with string app/path. */
function parseBody(text: string): { app: string, path: string } | null {
  let body: unknown
  try {
    body = JSON.parse(text)
  }
  catch {
    return null
  }
  if (typeof body !== 'object' || body === null) return null
  const { app, path: bodyPath } = body as Record<string, unknown>
  return typeof app === 'string' && typeof bodyPath === 'string' ? { app, path: bodyPath } : null
}

/** Whether the path names an existing file or directory on disk. */
async function pathExists(absolute: string) {
  try {
    await stat(absolute)
    return true
  }
  catch {
    return false
  }
}

/**
 * Register the info and launch routes behind the connection trust fence.
 * @param ctx - Cordis context; `webServer`, `connection`, and `subprocess` are injected.
 */
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
      return await (ctx as any).subprocess.resolveExecutable(command) // eslint-disable-line @typescript-eslint/no-explicit-any
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

  /** Lazy once-per-plugin-life resolution; the map is the mutable authority. */
  let resolutionsTask: Promise<Map<string, unknown>> | undefined
  const availability = (): Promise<Map<string, unknown>> => resolutionsTask ??= bundle.resolver.resolveOpenInAppApps(launchTimeoutMs, internalsOf())

  /**
   * Replace one stale resolution after a missing-executable launch, exactly
   * like the official host: re-resolve the entry once, or drop it from the map.
   */
  const refreshResolution = async (id: string) => {
    const map = await availability()
    const fresh = await bundle.resolver.resolveLaunch(id, launchTimeoutMs, internalsOf())
    if (fresh === null) {
      map.delete(id)
      return undefined
    }
    map.set(id, fresh)
    return fresh
  }

  // Warm the detection pass at activation so the first info/launch after a
  // dsh web restart answers from the memoized map instead of a cold registry
  // sweep (fire-and-forget: every locator failure is swallowed inside the
  // resolver as "unavailable").
  availability().catch(() => {})

  /** Read + validate one JSON POST body, answering failures; null when invalid. */
  const readPost = async (req: any, res: any): Promise<{ app: string, path: string } | null> => { // eslint-disable-line @typescript-eslint/no-explicit-any
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

  ctx.effect(() => (ctx as any).webServer.register({ // eslint-disable-line @typescript-eslint/no-explicit-any
    kind: 'exact',
    path: '/api/file-link-open/info',
    handler: async (req: any, res: any) => { // eslint-disable-line @typescript-eslint/no-explicit-any
      if (rejected((ctx as unknown as { connection: ConnectionLike }).connection, req, res)) return
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
      sendJson(res, 200, {
        editors: [...EDITOR_IDS],
        available,
      })
    },
  }), 'file-link-open: GET /api/file-link-open/info')

  ctx.effect(() => (ctx as any).webServer.register({ // eslint-disable-line @typescript-eslint/no-explicit-any
    kind: 'exact',
    path: '/api/file-link-open/launch',
    handler: async (req: any, res: any) => { // eslint-disable-line @typescript-eslint/no-explicit-any
      if (rejected((ctx as unknown as { connection: ConnectionLike }).connection, req, res)) return
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
      const app = bundle.catalog.find((entry: { id: string }) => entry.id === parsed.app)
      const resolved = app === undefined ? undefined : (await availability()).get(app.id)
      if (app === undefined || resolved === undefined) {
        sendJson(res, 400, { code: 'unavailable-app', message: `unknown or unavailable app: ${parsed.app}` })
        return
      }
      let outcome = await bundle.resolver.launchResolved(resolved, parsed.path, launchTimeoutMs, internalsOf())
      if (outcome === 'missing') {
        const fresh = await refreshResolution(parsed.app)
        outcome = fresh === undefined
          ? 'failed'
          : await bundle.resolver.launchResolved(fresh, parsed.path, launchTimeoutMs, internalsOf())
      }
      if (outcome === 'launched') sendJson(res, 200, { ok: true })
      else sendJson(res, 502, { code: 'launch-failed', message: `failed to launch ${parsed.app}` })
    },
  }), 'file-link-open: POST /api/file-link-open/launch')
}