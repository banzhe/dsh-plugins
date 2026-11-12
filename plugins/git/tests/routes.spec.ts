import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { Readable } from 'node:stream'
import type { Context } from '@deepseek-ai/cordis'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { apply, cwdOf, inject, parseCommit, parseMessage } from '../src/routes.ts'

/**
 * The routes talk to git, so the same isolation as `git.spec.ts` applies: no
 * developer git config, no repository discovered above %TEMP%, and an identity
 * that comes from the environment rather than from a config file.
 */
const overridden = [
  'GIT_CONFIG_GLOBAL',
  'GIT_CONFIG_NOSYSTEM',
  'GIT_CEILING_DIRECTORIES',
  'GIT_AUTHOR_NAME',
  'GIT_AUTHOR_EMAIL',
  'GIT_COMMITTER_NAME',
  'GIT_COMMITTER_EMAIL',
] as const

const previousEnvironment = new Map<string, string | undefined>()
let scratch = ''

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), 'dsh-git-routes-'))
  const emptyConfig = join(scratch, 'empty-gitconfig')
  await writeFile(emptyConfig, '')
  const values: Record<(typeof overridden)[number], string> = {
    GIT_CONFIG_GLOBAL: emptyConfig,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CEILING_DIRECTORIES: tmpdir(),
    GIT_AUTHOR_NAME: 'DSH Test',
    GIT_AUTHOR_EMAIL: 'dsh-test@example.invalid',
    GIT_COMMITTER_NAME: 'DSH Test',
    GIT_COMMITTER_EMAIL: 'dsh-test@example.invalid',
  }
  for (const name of overridden) {
    previousEnvironment.set(name, process.env[name])
    process.env[name] = values[name]
  }
})

afterEach(async () => {
  for (const name of overridden) {
    const value = previousEnvironment.get(name)
    if (value === undefined) Reflect.deleteProperty(process.env, name)
    else process.env[name] = value
  }
  previousEnvironment.clear()
  await rm(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
})

function git(cwd: string, ...args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, env: process.env }, (error, stdout) => {
      if (error !== null) {
        reject(new Error(error.message))
        return
      }
      resolve(stdout)
    })
  })
}

async function write(root: string, relative: string, content: string): Promise<void> {
  const target = join(root, relative)
  await mkdir(dirname(target), { recursive: true })
  await writeFile(target, content)
}

async function repository(name = 'repo'): Promise<string> {
  const root = join(scratch, name)
  await mkdir(root, { recursive: true })
  await git(root, 'init', '-b', 'main')
  await write(root, 'tracked.txt', 'base\n')
  await git(root, 'add', '--all')
  await git(root, 'commit', '-m', 'base')
  return root
}

interface ExactRoute {
  readonly kind: 'exact'
  readonly path: string
  readonly handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
}

interface Composition {
  readonly ctx: Context
  readonly routes: ExactRoute[]
  readonly disposers: Array<() => void>
}

interface CompositionOptions {
  readonly rejection?: (req: IncomingMessage) => number | undefined
  readonly workspaceFor?: (requested: string) => { readonly path: string } | undefined
  readonly services?: Readonly<Record<string, unknown>>
}

function fakeComposition(options: CompositionOptions = {}): Composition {
  const routes: ExactRoute[] = []
  const disposers: Array<() => void> = []
  const ctx = {
    effect: (install: () => () => void) => {
      const dispose = install()
      disposers.push(dispose)
      return () => { dispose() }
    },
    webServer: {
      register: (route: ExactRoute) => {
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
    connection: {
      requestRejection: (req: IncomingMessage): number | undefined => options.rejection?.(req),
    },
    workspaceRegistry: {
      resolveByPath: (requested: string) => options.workspaceFor?.(requested),
    },
    ...options.services,
  }
  return { ctx: ctx as unknown as Context, routes, disposers }
}

class Recorded {
  statusCode: number | undefined
  readonly headers: Record<string, unknown> = {}
  readonly chunks: Buffer[] = []
  ended = false
  setHeader(name: string, value: unknown): this {
    this.headers[name.toLowerCase()] = value
    return this
  }
  getHeader(name: string): unknown {
    return this.headers[name.toLowerCase()]
  }
  writeHead(status: number, headers?: Record<string, unknown>): this {
    this.statusCode = status
    for (const [name, value] of Object.entries(headers ?? {})) this.headers[name.toLowerCase()] = value
    return this
  }
  write(chunk: string | Buffer): boolean {
    this.chunks.push(Buffer.from(chunk))
    return true
  }
  end(chunk?: string | Buffer): this {
    if (chunk !== undefined) this.chunks.push(Buffer.from(chunk))
    this.ended = true
    return this
  }
  get status(): number | undefined {
    return this.statusCode
  }
  get body(): Buffer | undefined {
    return this.chunks.length === 0 ? undefined : Buffer.concat(this.chunks)
  }
  get text(): string | undefined {
    return this.body?.toString('utf8')
  }
  get writableEnded(): boolean {
    return this.ended
  }
}

interface RequestOptions {
  readonly method?: string
  readonly url?: string
  readonly headers?: Readonly<Record<string, string>>
  readonly body?: string | Buffer
  readonly failOnRead?: boolean
}

function request(options: RequestOptions = {}): { req: IncomingMessage; drained: { value: boolean } } {
  const drained = { value: false }
  const stream = options.failOnRead === true
    ? new Readable({ read() { this.destroy(new Error('body read failed')) } })
    : Readable.from(options.body === undefined ? [] : [Buffer.from(options.body)])
  const resume = stream.resume.bind(stream)
  stream.resume = () => {
    drained.value = true
    return resume()
  }
  const req = Object.assign(stream, {
    method: options.method ?? 'GET',
    url: options.url ?? '/',
    headers: options.headers ?? {},
  }) as unknown as IncomingMessage
  return { req, drained }
}

async function exchange(handler: ExactRoute['handler'], req: IncomingMessage): Promise<Recorded> {
  const res = new Recorded()
  await handler(req, res as unknown as ServerResponse)
  return res
}

function routeAt(composition: Composition, path: string): ExactRoute {
  const route = composition.routes.find(candidate => candidate.path === path)
  if (route === undefined) throw new Error(`no route registered for ${path}`)
  return route
}

function json(response: Recorded): Record<string, unknown> {
  const text = response.text
  if (text === undefined) throw new Error('the response carried no body')
  const parsed: unknown = JSON.parse(text)
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`expected a JSON object, got ${text}`)
  }
  return parsed as Record<string, unknown>
}

function errorOf(response: Recorded): Record<string, unknown> {
  const body = json(response)
  expect(typeof body['message']).toBe('string')
  expect(String(body['message']).length).toBeGreaterThan(0)
  return body
}

function byPath<T extends { path: string }>(changes: readonly T[]): T[] {
  return [...changes].sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0))
}

/**
 * The message route resolves a model before it reads the change context, so a
 * provider and one advertised model are what makes the "nothing to describe"
 * decision reachable. `sessions.get` answering nothing is tolerated, which keeps
 * these tests off the session and projection internals.
 */
function draftable(options: { readonly stream?: () => unknown } = {}): Record<string, unknown> {
  return {
    listProviders: () => [{ id: 'test-provider', name: 'Test Provider' }],
    listModels: async (provider: string) => [{ provider, id: 'test-model', name: 'Test Model' }],
    ...options,
  }
}

function injectedNames(declared: unknown): string[] {
  if (Array.isArray(declared)) return declared.map(name => String(name))
  if (typeof declared === 'object' && declared !== null) {
    const groups = declared as Record<string, unknown>
    const names: string[] = []
    for (const group of [groups['required'], groups['optional']]) {
      if (Array.isArray(group)) for (const name of group) names.push(String(name))
    }
    return names
  }
  throw new Error('inject is neither a list nor a required/optional map')
}

function composed(options: CompositionOptions = {}): Composition {
  const composition = fakeComposition(options)
  apply(composition.ctx)
  return composition
}

/** A workspace registry that hands back exactly these directories. */
function registered(...paths: readonly string[]): CompositionOptions {
  return {
    workspaceFor: (requested: string) => (paths.includes(requested) ? { path: requested } : undefined),
  }
}

it('reads an absolute workspace path from the query', () => {
  expect(cwdOf('/api/git/status?cwd=%2Fwork%2Frepo')).toBe('/work/repo')
})

it('answers null when the query carries no usable cwd', () => {
  expect(cwdOf(undefined)).toBeNull()
  expect(cwdOf('/api/git/status')).toBeNull()
  expect(cwdOf('/api/git/status?foo=1')).toBeNull()
  expect(cwdOf('/api/git/status?cwd=')).toBeNull()
  expect(cwdOf('/api/git/status?cwd=%20%20')).toBeNull()
})

it('returns the decoded cwd without trimming it', () => {
  expect(cwdOf('/api/git/status?cwd=%20%2Fwork%2Frepo')).toBe(' /work/repo')
})

it('accepts a message payload and drops keys it does not know', () => {
  expect(parseMessage(JSON.stringify({ cwd: '/work/repo', sessionId: 's-1', language: 'zh', extra: true }))).toEqual({
    cwd: '/work/repo',
    sessionId: 's-1',
    language: 'zh',
  })
  expect(parseMessage(JSON.stringify({ cwd: '/work/repo', sessionId: 's-1', language: 'en' }))).toEqual({
    cwd: '/work/repo',
    sessionId: 's-1',
    language: 'en',
  })
})

it('keeps message values exactly as sent', () => {
  expect(parseMessage(JSON.stringify({ cwd: ' /work/repo ', sessionId: ' s ', language: 'en' }))).toEqual({
    cwd: ' /work/repo ',
    sessionId: ' s ',
    language: 'en',
  })
})

it('rejects a message payload that is not a JSON object', () => {
  for (const text of ['', 'not json', '[]', 'null', '42', '"text"']) {
    expect(parseMessage(text)).toBeNull()
  }
})

it('rejects a message payload with a blank field or an unknown language', () => {
  const valid = { cwd: '/work/repo', sessionId: 's-1', language: 'en' }
  expect(parseMessage(JSON.stringify({ ...valid, cwd: '' }))).toBeNull()
  expect(parseMessage(JSON.stringify({ ...valid, cwd: '   ' }))).toBeNull()
  expect(parseMessage(JSON.stringify({ ...valid, sessionId: '' }))).toBeNull()
  expect(parseMessage(JSON.stringify({ ...valid, sessionId: '  ' }))).toBeNull()
  expect(parseMessage(JSON.stringify({ ...valid, language: 'fr' }))).toBeNull()
  expect(parseMessage(JSON.stringify({ ...valid, language: 'ZH' }))).toBeNull()
  expect(parseMessage(JSON.stringify({ sessionId: 's-1', language: 'zh' }))).toBeNull()
  expect(parseMessage(JSON.stringify({ cwd: '/work/repo', language: 'zh' }))).toBeNull()
  expect(parseMessage(JSON.stringify({ cwd: '/work/repo', sessionId: 's-1' }))).toBeNull()
})

it('accepts a commit payload and drops keys it does not know', () => {
  expect(parseCommit(JSON.stringify({ cwd: '/work/repo', message: 'feat: x', extra: 1 }))).toEqual({
    cwd: '/work/repo',
    message: 'feat: x',
  })
})

it('rejects a commit payload that is not a JSON object', () => {
  for (const text of ['', 'nope', '[]', 'false', '7']) {
    expect(parseCommit(text)).toBeNull()
  }
})

it('rejects a commit payload with a blank field', () => {
  expect(parseCommit(JSON.stringify({ cwd: '/work/repo', message: '' }))).toBeNull()
  expect(parseCommit(JSON.stringify({ cwd: '/work/repo', message: '   ' }))).toBeNull()
  expect(parseCommit(JSON.stringify({ cwd: '  ', message: 'feat: x' }))).toBeNull()
  expect(parseCommit(JSON.stringify({ message: 'feat: x' }))).toBeNull()
})

it('registers the three exact routes and releases them with the fiber', () => {
  const composition = fakeComposition()
  apply(composition.ctx)
  expect(composition.routes.map(route => ({ kind: route.kind, path: route.path }))).toEqual([
    { kind: 'exact', path: '/api/git/status' },
    { kind: 'exact', path: '/api/git/commit' },
    { kind: 'exact', path: '/api/git/message' },
  ])
  for (const dispose of composition.disposers) dispose()
  expect(composition.routes).toEqual([])
})

it('injects the services the routes use', () => {
  expect([...injectedNames(inject)].sort()).toEqual([
    'connection',
    'llm',
    'sessionProjections',
    'sessions',
    'webServer',
    'workspaceRegistry',
  ])
})

it('turns a numeric request rejection into an empty response of that status', async () => {
  const composition = composed({ rejection: () => 403 })
  const response = await exchange(routeAt(composition, '/api/git/status').handler, request({ url: '/api/git/status?cwd=%2Fwork' }).req)
  expect(response.status).toBe(403)
  expect(response.body).toBeUndefined()
})

it('refuses a method the route does not serve', async () => {
  const composition = composed()
  const onStatus = await exchange(routeAt(composition, '/api/git/status').handler, request({ method: 'POST', url: '/api/git/status' }).req)
  expect(onStatus.status).toBe(405)
  expect(String(onStatus.headers['allow'])).toContain('GET')
  for (const path of ['/api/git/commit', '/api/git/message']) {
    const response = await exchange(routeAt(composition, path).handler, request({ method: 'GET', url: path }).req)
    expect(response.status).toBe(405)
    expect(String(response.headers['allow'])).toContain('POST')
  }
})

it('refuses a POST body whose media type is not JSON', async () => {
  const composition = composed()
  for (const path of ['/api/git/commit', '/api/git/message']) {
    const built = request({
      method: 'POST',
      url: path,
      headers: { 'content-type': 'text/plain' },
      body: JSON.stringify({ cwd: '/work/repo', message: 'feat: x' }),
    })
    const response = await exchange(routeAt(composition, path).handler, built.req)
    expect(response.status).toBe(415)
    expect(errorOf(response)).toMatchObject({ code: 'unsupported-media-type' })
  }
})

it('accepts a JSON media type that carries parameters', async () => {
  const composition = composed()
  const built = request({
    method: 'POST',
    url: '/api/git/commit',
    headers: { 'content-type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ cwd: '/work/repo' }),
  })
  const response = await exchange(routeAt(composition, '/api/git/commit').handler, built.req)
  expect(response.status).toBe(400)
  expect(errorOf(response)).toMatchObject({ code: 'bad-request' })
})

it('answers 400 when the body cannot be read', async () => {
  const composition = composed()
  const built = request({
    method: 'POST',
    url: '/api/git/commit',
    headers: { 'content-type': 'application/json' },
    failOnRead: true,
  })
  const response = await exchange(routeAt(composition, '/api/git/commit').handler, built.req)
  expect(response.status).toBe(400)
  expect(errorOf(response)).toMatchObject({ code: 'bad-request' })
})

it('refuses a body past 64 KiB and drains it', async () => {
  const composition = composed()
  const built = request({
    method: 'POST',
    url: '/api/git/commit',
    headers: { 'content-type': 'application/json' },
    body: 'a'.repeat(70 * 1024),
  })
  const response = await exchange(routeAt(composition, '/api/git/commit').handler, built.req)
  expect(response.status).toBe(413)
  expect(errorOf(response)).toMatchObject({ code: 'payload-too-large' })
  expect(built.drained.value).toBe(true)
})

it('accepts a body up to 64 KiB', async () => {
  const composition = composed()
  const padding = 'a'.repeat(64 * 1024 - 64)
  const built = request({
    method: 'POST',
    url: '/api/git/commit',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ cwd: '/work/repo', message: 'feat: x', padding }),
  })
  const response = await exchange(routeAt(composition, '/api/git/commit').handler, built.req)
  expect(response.status).not.toBe(413)
})

it('answers 400 for a body that does not match the expected schema', async () => {
  const composition = composed()
  for (const body of ['', 'not json', '{"cwd":42}', '{}']) {
    const built = request({
      method: 'POST',
      url: '/api/git/message',
      headers: { 'content-type': 'application/json' },
      body,
    })
    const response = await exchange(routeAt(composition, '/api/git/message').handler, built.req)
    expect(response.status).toBe(400)
    expect(errorOf(response)).toMatchObject({ code: 'bad-request' })
  }
})

it('serves only a workspace the registry resolves', async () => {
  const composition = composed({ workspaceFor: () => undefined })
  const absent = join(scratch, 'not-registered')
  for (const requested of ['relative/path', absent]) {
    const response = await exchange(
      routeAt(composition, '/api/git/status').handler,
      request({ url: `/api/git/status?cwd=${encodeURIComponent(requested)}` }).req,
    )
    expect(response.status).toBe(404)
    expect(errorOf(response)).toMatchObject({ code: 'not-a-workspace' })
  }

  const built = request({
    method: 'POST',
    url: '/api/git/commit',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ cwd: 'relative/path', message: 'feat: x' }),
  })
  const response = await exchange(routeAt(composition, '/api/git/commit').handler, built.req)
  expect(response.status).toBe(404)
  expect(errorOf(response)).toMatchObject({ code: 'not-a-workspace' })
})

it('answers the workspace branch and changed files', async () => {
  const root = await repository()
  await write(root, 'notes.txt', 'note\n')
  await write(root, 'tracked.txt', 'changed\n')
  const composition = composed(registered(root))

  const response = await exchange(
    routeAt(composition, '/api/git/status').handler,
    request({ url: `/api/git/status?cwd=${encodeURIComponent(root)}` }).req,
  )
  expect(response.status).toBe(200)
  expect(String(response.headers['content-type'])).toContain('application/json')
  expect(String(response.headers['content-type'])).toContain('charset=utf-8')
  expect(response.headers['cache-control']).toBe('no-store')
  const body = json(response)
  expect(body['branch']).toBe('main')
  const changes = body['changes']
  if (!Array.isArray(changes)) throw new Error(`expected a changes list, got ${String(changes)}`)
  expect(byPath(changes as Array<{ path: string }>)).toEqual(
    byPath([
      { path: 'notes.txt', status: 'untracked' },
      { path: 'tracked.txt', status: 'modified' },
    ]),
  )
})

it('serves the path the registry resolved, not the one requested', async () => {
  const root = await repository()
  await write(root, 'notes.txt', 'note\n')
  const plain = join(scratch, 'plain')
  await mkdir(plain, { recursive: true })
  const composition = composed({ workspaceFor: (requested: string) => (requested === plain ? { path: root } : undefined) })

  const response = await exchange(
    routeAt(composition, '/api/git/status').handler,
    request({ url: `/api/git/status?cwd=${encodeURIComponent(plain)}` }).req,
  )
  expect(response.status).toBe(200)
  expect(json(response)).toMatchObject({ branch: 'main' })
})

it('answers 409 when the workspace is not a repository', async () => {
  const plain = join(scratch, 'plain-repo')
  await mkdir(plain, { recursive: true })
  const composition = composed(registered(plain))

  const response = await exchange(
    routeAt(composition, '/api/git/status').handler,
    request({ url: `/api/git/status?cwd=${encodeURIComponent(plain)}` }).req,
  )
  expect(response.status).toBe(409)
  expect(errorOf(response)).toMatchObject({ code: 'not-a-repository' })
})

it('commits the workspace and answers the new commit hash', async () => {
  const root = await repository()
  await write(root, 'notes.txt', 'note\n')
  const composition = composed(registered(root))

  const built = request({
    method: 'POST',
    url: '/api/git/commit',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ cwd: root, message: 'feat: notes' }),
  })
  const response = await exchange(routeAt(composition, '/api/git/commit').handler, built.req)
  expect(response.status).toBe(200)
  expect(String(response.headers['content-type'])).toContain('charset=utf-8')
  expect(response.headers['cache-control']).toBe('no-store')
  const body = json(response)
  expect(body['ok']).toBe(true)
  const hash = body['hash']
  expect(typeof hash).toBe('string')
  expect((await git(root, 'rev-parse', 'HEAD')).trim().startsWith(String(hash))).toBe(true)
  expect((await git(root, 'log', '-1', '--pretty=%s')).trim()).toBe('feat: notes')
})

it('answers 409 when the commit fails', async () => {
  const root = await repository()
  const composition = composed(registered(root))

  const built = request({
    method: 'POST',
    url: '/api/git/commit',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ cwd: root, message: 'feat: nothing' }),
  })
  const response = await exchange(routeAt(composition, '/api/git/commit').handler, built.req)
  expect(response.status).toBe(409)
  expect(errorOf(response)).toMatchObject({ code: 'commit-failed' })
})

it('answers 409 when there is nothing to describe', async () => {
  const root = await repository()
  const composition = composed({
    ...registered(root),
    services: { sessions: { get: () => undefined }, sessionProjections: {}, llm: draftable() },
  })

  const built = request({
    method: 'POST',
    url: '/api/git/message',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ cwd: root, sessionId: 's-1', language: 'en' }),
  })
  const response = await exchange(routeAt(composition, '/api/git/message').handler, built.req)
  expect(response.status).toBe(409)
  expect(errorOf(response)).toMatchObject({ code: 'nothing-to-describe' })
})

it('answers 409 when the draft cannot be produced', async () => {
  const root = await repository()
  await write(root, 'notes.txt', 'note\n')
  const composition = composed({
    ...registered(root),
    services: {
      sessions: { get: () => undefined },
      sessionProjections: {},
      llm: draftable({ stream: () => { throw new Error('model unavailable') } }),
    },
  })

  const built = request({
    method: 'POST',
    url: '/api/git/message',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ cwd: root, sessionId: 's-1', language: 'en' }),
  })
  const response = await exchange(routeAt(composition, '/api/git/message').handler, built.req)
  expect(response.status).toBe(409)
  expect(errorOf(response)).toMatchObject({ code: 'draft-failed' })
})
