import { readFile } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { beforeEach, expect, it, vi } from 'vitest'
import { ASSET_DIRECTORY, ICON_ROUTES } from '../src/icons.ts'
import { apply, serveIcon } from '../src/index.ts'

/**
 * Counts the byte reads the handlers perform and can make one read vanish, which
 * is the one failure a stat cannot see. Everything else delegates to the real
 * reader, so the bytes under test are the snapshotted ones.
 */
const icons = vi.hoisted(() => ({ reads: 0, goneAfterRead: false }))

vi.mock('../src/icons.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/icons.ts')>()
  return {
    ...actual,
    readIcon: async (asset: string, directory?: string) => {
      icons.reads += 1
      if (icons.goneAfterRead) return undefined
      return await actual.readIcon(asset, directory)
    },
  }
})

/** One route as the fake composition's webServer received it. */
interface Registered {
  readonly kind: 'exact'
  readonly path: string
  readonly handler: (req: IncomingMessage, res: ServerResponse) => Promise<void>
}

/** A response recorder standing in for the socket that owns the real one. */
interface Recorder {
  status: number | undefined
  headers: Record<string, unknown>
  ended: boolean
  body: Buffer | undefined
  writeHead: (status: number, headers?: Record<string, unknown>) => void
  end: (body?: Buffer) => void
}

/** Compose the two ctx members the plugin touches, and keep what it registers. */
function fakeComposition() {
  const routes: Registered[] = []
  const disposers: Array<() => void> = []
  const ctx = {
    effect: (install: () => () => void) => {
      const dispose = install()
      disposers.push(dispose)
      return () => { dispose() }
    },
    webServer: {
      // Mirrors the real registry: a duplicate (kind, path) is a composition
      // error, so a fake that accepted one would hide exactly that.
      register: (route: Registered) => {
        if (routes.some(candidate => candidate.kind === route.kind && candidate.path === route.path)) {
          throw new Error(`webserver: duplicate ${route.kind} route "${route.path}"`)
        }
        routes.push(route)
        return () => {
          const at = routes.indexOf(route)
          if (at !== -1) routes.splice(at, 1)
        }
      },
    },
  }
  return { ctx: ctx as unknown as Context, routes, disposers }
}

/** One request/response exchange against a route handler. */
async function exchange(
  handler: Registered['handler'],
  method = 'GET',
  headers: Record<string, string> = {},
): Promise<Recorder> {
  const recorder: Recorder = {
    status: undefined,
    headers: {},
    ended: false,
    body: undefined,
    writeHead(status, responseHeaders) {
      this.status = status
      this.headers = responseHeaders ?? {}
    },
    end(body) {
      this.ended = true
      this.body = body
    },
  }
  await handler({ method, headers } as unknown as IncomingMessage, recorder as unknown as ServerResponse)
  return recorder
}

function routeNamed(routes: readonly Registered[], path: string): Registered {
  const route = routes.find(candidate => candidate.path === path)
  if (route === undefined) throw new Error(`no route registered for ${path}`)
  return route
}

/** A composition with every route registered, plus its favicon handler. */
async function served() {
  const composition = fakeComposition()
  await apply(composition.ctx)
  return { ...composition, favicon: routeNamed(composition.routes, '/favicon.ico').handler }
}

beforeEach(() => {
  icons.reads = 0
  icons.goneAfterRead = false
})

it('registers one exact route per claimed pathname and releases them with the fiber', async () => {
  const composition = fakeComposition()
  await apply(composition.ctx)
  expect(composition.routes.map(route => route.path)).toEqual(ICON_ROUTES.map(route => route.path))
  for (const dispose of composition.disposers) dispose()
  expect(composition.routes).toEqual([])
})

it('serves the snapshotted bytes with a revalidating validator', async () => {
  const { favicon } = await served()
  const response = await exchange(favicon)
  expect(response.status).toBe(200)
  expect(response.headers['content-type']).toBe('image/vnd.microsoft.icon')
  expect(response.headers['cache-control']).toBe('no-cache')
  expect(response.headers['etag']).toMatch(/^W\/"\d+-\d+"$/)
  expect(response.body).toEqual(await readFile(join(ASSET_DIRECTORY, 'favicon.ico')))
  expect(response.headers['content-length']).toBe(response.body?.byteLength)
  expect(icons.reads).toBe(1)
})

it('declares the manifest under its own media type', async () => {
  const { routes } = await served()
  const response = await exchange(routeNamed(routes, '/manifest.webmanifest').handler)
  expect(response.headers['content-type']).toBe('application/manifest+json')
  expect(JSON.parse(String(response.body))).toMatchObject({ name: 'DeepSeek Harness', short_name: 'DSH' })
})

it('answers HEAD with the stored length and no read', async () => {
  const { routes } = await served()
  const response = await exchange(routeNamed(routes, '/icon-192.png').handler, 'HEAD')
  expect(response.status).toBe(200)
  expect(response.ended).toBe(true)
  expect(response.body).toBeUndefined()
  expect(response.headers['content-length']).toBe((await readFile(join(ASSET_DIRECTORY, 'icon-192.png'))).byteLength)
  expect(icons.reads).toBe(0)
})

it('answers 304, without a length and without a read, for a validator the client holds', async () => {
  const { favicon } = await served()
  const first = await exchange(favicon)
  const revalidated = await exchange(favicon, 'GET', { 'if-none-match': String(first.headers['etag']) })
  expect(revalidated.status).toBe(304)
  expect(revalidated.headers['etag']).toBe(first.headers['etag'])
  expect(revalidated.headers).not.toHaveProperty('content-length')
  expect(revalidated.body).toBeUndefined()
  expect(icons.reads).toBe(1) // the first response only
  expect((await exchange(favicon, 'GET', { 'if-none-match': '*' })).status).toBe(304)
})

it('refuses a method that is neither GET nor HEAD', async () => {
  const { favicon } = await served()
  const response = await exchange(favicon, 'POST')
  expect(response.status).toBe(405)
  expect(response.headers['allow']).toBe('GET, HEAD')
  expect(response.headers['cache-control']).toBe('no-cache')
  expect(response.body).toBeUndefined()
  expect(icons.reads).toBe(0)
})

it('answers 404 for an asset that was never there instead of falling back to the dist copy', async () => {
  const response = await exchange(serveIcon({ path: '/gone.png', asset: 'gone.png', contentType: 'image/png' }))
  expect(response.status).toBe(404)
  expect(response.headers['cache-control']).toBe('no-cache')
  expect(response.body).toBeUndefined()
  expect(icons.reads).toBe(0)
})

it('answers 404 when the asset disappears between the stat and the read', async () => {
  const { favicon } = await served()
  icons.goneAfterRead = true
  const response = await exchange(favicon)
  expect(response.status).toBe(404)
  expect(response.body).toBeUndefined()
  expect(icons.reads).toBe(1)
})
