/**
 * @banzhe/dsh-web-icons — Host half.
 *
 * Claims the Web icon pathnames with `webServer` exact routes, so the browser
 * chrome and the installable-app metadata come from this Bundle's snapshot
 * instead of whichever `dsh-web-frontend/dist` the running harness ships. An
 * exact route is matched before the fallback seat that owns the dist (see
 * `packages/host/webserver`), which is what makes the takeover total rather than
 * a second copy competing with the first.
 *
 * Two boundaries are deliberate. Seven of the eight pathnames are answered by
 * the Desktop shell for its own window (`dsh-app://app/`) before a request
 * reaches the Host, so those seven are invisible inside the application window;
 * `/favicon-dark.svg` is the one the shell does not claim, and the browser origin
 * is the surface that matters. And `favicon.svg` is never claimed: the source
 * retired that mark.
 *
 * The `webServer` service is reached through the local structural type below
 * rather than a dependency on `@deepseek-ai/dsh-host-webserver`: only the shape
 * of one method is needed, and a Bundle that never loads that package at runtime
 * should not widen its peer set for types alone.
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import { assertIconsPresent, ICON_ROUTES, inspectIcon, matchesEtag, readIcon, type IconRoute } from './icons.ts'

/** Cordis function-plugin name; also the Loader row id its patch declares. */
export const name = 'web-icons'

/** The route carrier; this plugin owns no other service. */
export const inject = ['webServer']

/** Structural face of the composition's `webServer` service (see the module note). */
interface WebServerFace {
  register(route: {
    kind: 'exact'
    path: string
    handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
  }): () => void
}

/**
 * Serve one snapshot route.
 *
 * The validator comes from the file's identity, so a conditional request and a
 * HEAD are answered with one `stat` and no read; the maskable pair alone is
 * 322 KB. `no-cache` with a validator, not `no-store`: revalidating costs a 304
 * while re-downloading would cost the whole set on every navigation.
 * @param route - the route whose asset this handler owns.
 * @returns The route handler.
 */
export function serveIcon(route: IconRoute) {
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { 'allow': 'GET, HEAD', 'cache-control': 'no-cache' })
      res.end()
      return
    }
    const file = await inspectIcon(route.asset)
    if (file === undefined) {
      res.writeHead(404, { 'cache-control': 'no-cache' })
      res.end()
      return
    }
    const validators = {
      'content-type': route.contentType,
      'cache-control': 'no-cache',
      'etag': file.etag,
    }
    if (matchesEtag(req.headers['if-none-match'], file.etag)) {
      // A 304 repeats the validators and carries no body, so it states no length.
      res.writeHead(304, validators)
      res.end()
      return
    }
    if (req.method === 'HEAD') {
      res.writeHead(200, { ...validators, 'content-length': file.size })
      res.end()
      return
    }
    const body = await readIcon(route.asset)
    if (body === undefined) {
      // Gone between the stat and the read: 404, never the dist's copy.
      res.writeHead(404, { 'cache-control': 'no-cache' })
      res.end()
      return
    }
    res.writeHead(200, { ...validators, 'content-length': body.byteLength })
    res.end(body)
  }
}

/**
 * Register every takeover route on the composition's web server.
 * @param ctx - Host context carrying the `webServer` service.
 */
export async function apply(ctx: Context): Promise<void> {
  const { webServer } = ctx as unknown as { webServer: WebServerFace }
  await assertIconsPresent()
  for (const route of ICON_ROUTES) {
    ctx.effect(() => webServer.register({ kind: 'exact', path: route.path, handler: serveIcon(route) }), `web-icons: ${route.path}`)
  }
}
