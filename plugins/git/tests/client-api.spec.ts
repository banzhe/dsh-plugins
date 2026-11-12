import { afterEach, expect, it, vi } from 'vitest'
import { commitWorkspace, draftWorkspaceMessage, readWorkspaceStatus } from '../src/client/api.ts'

interface FetchCall {
  readonly url: string
  readonly method: string
  readonly contentType: string | undefined
  readonly body: string | undefined
}

/**
 * Replaces global `fetch` for one test. The recorder captures what the request
 * carried; `respond` decides the reply, so a spec states the wire answer it is
 * exercising instead of asserting against the real network.
 */
function stubFetch(respond: (call: FetchCall) => Response | Promise<Response>): FetchCall[] {
  const calls: FetchCall[] = []
  vi.stubGlobal('fetch', async (input: string | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers)
    const call: FetchCall = {
      url: String(input),
      method: init?.method ?? 'GET',
      contentType: headers.get('content-type') ?? undefined,
      body: typeof init?.body === 'string' ? init.body : undefined,
    }
    calls.push(call)
    return respond(call)
  })
  return calls
}

/**
 * The request paths are app-base relative by design: the browser resolves them
 * against the page URL it was served from. Resolving against a base that carries
 * a sub-path is what distinguishes that addressing from an origin-absolute one.
 */
const APP_BASE = 'http://harness.invalid/app/'

function resolved(url: string): string {
  return new URL(url, APP_BASE).toString()
}

function ok(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200 })
}

function failing(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status })
}

afterEach(() => {
  vi.unstubAllGlobals()
})

it('reads the workspace status over the cwd query', async () => {
  const calls = stubFetch(() => ok({
    branch: 'main',
    changes: [
      { path: 'src/a.ts', status: 'modified' },
      { path: 'notes.md', status: 'untracked' },
    ],
  }))
  const result = await readWorkspaceStatus('/work/repo', new AbortController().signal)
  expect(calls).toHaveLength(1)
  expect(calls[0]?.method).toBe('GET')
  expect(resolved(String(calls[0]?.url))).toBe(APP_BASE + 'api/git/status?cwd=' + encodeURIComponent('/work/repo'))
  expect(result).toEqual({
    ok: true,
    status: {
      branch: 'main',
      changes: [
        { path: 'src/a.ts', status: 'modified' },
        { path: 'notes.md', status: 'untracked' },
      ],
    },
  })
})

it('addresses the status endpoint relative to the application base', async () => {
  const calls = stubFetch(() => ok({ branch: 'main', changes: [] }))
  await readWorkspaceStatus('/work/repo', new AbortController().signal)
  expect(String(calls[0]?.url)).toBe('api/git/status?cwd=' + encodeURIComponent('/work/repo'))
  expect(resolved(String(calls[0]?.url))).toBe(APP_BASE + 'api/git/status?cwd=' + encodeURIComponent('/work/repo'))
})

it('drops change rows that are not part of the wire shape', async () => {
  stubFetch(() => ok({
    branch: null,
    changes: [
      { path: 'kept.ts', status: 'added' },
      { path: 7, status: 'added' },
      { status: 'deleted' },
      { path: 'unknown-status.ts', status: 'conflicted' },
      { path: 'also-kept.ts', status: 'renamed' },
    ],
  }))
  const result = await readWorkspaceStatus('/work/repo', new AbortController().signal)
  expect(result).toEqual({
    ok: true,
    status: {
      branch: null,
      changes: [
        { path: 'kept.ts', status: 'added' },
        { path: 'also-kept.ts', status: 'renamed' },
      ],
    },
  })
})

it('treats a branch that is neither text nor null as malformed', async () => {
  stubFetch(() => ok({ branch: 42, changes: [] }))
  const result = await readWorkspaceStatus('/work/repo', new AbortController().signal)
  expect(result).toEqual({ ok: false, message: null })
})

it('reports the server message when the status request is refused', async () => {
  stubFetch(() => failing(409, { code: 'not-a-repository', message: 'not a git repository' }))
  expect(await readWorkspaceStatus('/work/repo', new AbortController().signal)).toEqual({
    ok: false,
    message: 'not a git repository',
  })
})

it('reports no message when the refusal carries none', async () => {
  stubFetch(() => failing(404, { code: 'not-a-workspace' }))
  expect(await readWorkspaceStatus('/work/repo', new AbortController().signal)).toEqual({ ok: false, message: null })
})

it('reports no message when the reply is not JSON', async () => {
  stubFetch(() => new Response('not json', { status: 200 }))
  expect(await readWorkspaceStatus('/work/repo', new AbortController().signal)).toEqual({ ok: false, message: null })
})

it('reports no message when the request itself fails', async () => {
  vi.stubGlobal('fetch', async () => { throw new TypeError('network down') })
  expect(await readWorkspaceStatus('/work/repo', new AbortController().signal)).toEqual({ ok: false, message: null })
})

it('reports no message when the request is aborted', async () => {
  const controller = new AbortController()
  controller.abort()
  stubFetch(() => { throw new DOMException('aborted', 'AbortError') })
  expect(await readWorkspaceStatus('/work/repo', controller.signal)).toEqual({ ok: false, message: null })
})

it('drafts a message with the session identity and the requested language', async () => {
  const calls = stubFetch(() => ok({ ok: true, message: 'feat: drafted' }))
  const result = await draftWorkspaceMessage('/work/repo', 'zh', 'session-1', new AbortController().signal)
  expect(calls).toHaveLength(1)
  expect(calls[0]?.method).toBe('POST')
  expect(resolved(String(calls[0]?.url))).toBe(APP_BASE + 'api/git/message')
  expect(calls[0]?.contentType).toBe('application/json')
  expect(JSON.parse(String(calls[0]?.body))).toEqual({ cwd: '/work/repo', language: 'zh', sessionId: 'session-1' })
  expect(result).toEqual({ ok: true, message: 'feat: drafted' })
})

it('reports the server message when a draft is refused', async () => {
  stubFetch(() => failing(409, { code: 'nothing-to-describe', message: 'there are no changes to describe' }))
  expect(await draftWorkspaceMessage('/work/repo', 'en', 'session-1', new AbortController().signal)).toEqual({
    ok: false,
    message: 'there are no changes to describe',
  })
})

it('reports no message when a draft fails without one', async () => {
  stubFetch(() => failing(409, { code: 'draft-failed' }))
  expect(await draftWorkspaceMessage('/work/repo', 'en', 'session-1', new AbortController().signal)).toEqual({
    ok: false,
    message: null,
  })
})

it('reports no message when a draft is aborted', async () => {
  stubFetch(() => { throw new DOMException('aborted', 'AbortError') })
  expect(await draftWorkspaceMessage('/work/repo', 'en', 'session-1', new AbortController().signal)).toEqual({
    ok: false,
    message: null,
  })
})

it('commits the workspace with the typed message', async () => {
  const calls = stubFetch(() => ok({ ok: true, hash: 'abc1234' }))
  const result = await commitWorkspace('/work/repo', 'feat: everything')
  expect(calls).toHaveLength(1)
  expect(calls[0]?.method).toBe('POST')
  expect(resolved(String(calls[0]?.url))).toBe(APP_BASE + 'api/git/commit')
  expect(calls[0]?.contentType).toBe('application/json')
  expect(JSON.parse(String(calls[0]?.body))).toEqual({ cwd: '/work/repo', message: 'feat: everything' })
  expect(result).toEqual({ ok: true, hash: 'abc1234' })
})

it('reports the server message when a commit is refused', async () => {
  stubFetch(() => failing(409, { code: 'commit-failed', message: 'nothing to commit' }))
  expect(await commitWorkspace('/work/repo', 'feat: nothing')).toEqual({ ok: false, message: 'nothing to commit' })
})

it('reports no message when a commit fails without one', async () => {
  stubFetch(() => new Response('', { status: 500 }))
  expect(await commitWorkspace('/work/repo', 'feat: nothing')).toEqual({ ok: false, message: null })
})
