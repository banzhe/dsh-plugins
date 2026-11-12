// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ANALYZE_TIMEOUT_MS, READ_TIMEOUT_MS, analyzeSession, readModels, readState } from '../src/client/api.ts'

const ANALYZE_PATH = '/api/session-topic-map/analyze'
const STATE_PATH = '/api/session-topic-map/state?sessionId=s-1'
const REQUEST = { sessionId: 's-1', provider: 'p', model: 'm', confirm: true as const }

type Handler = (path: string, init: RequestInit | undefined) => Promise<Response>

function pathOf(input: string | URL | Request): string {
  const raw = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
  const url = new URL(raw, 'http://localhost/')
  return url.pathname + url.search
}

function stubFetch(handler: Handler): ReturnType<typeof vi.fn> {
  const stub = vi.fn(async (input: string | URL | Request, init?: RequestInit) => handler(pathOf(input), init))
  vi.stubGlobal('fetch', stub)
  return stub
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

function neverSettles(): Promise<Response> {
  return new Promise<Response>(() => {})
}

function untilAborted(init: RequestInit | undefined): Promise<Response> {
  return new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => {
      reject(new DOMException('aborted', 'AbortError'))
    }, { once: true })
  })
}

async function flush(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0)
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('readModels', () => {
  it('resolves ok for a well-formed answer', async () => {
    stubFetch(async () => jsonResponse({ providers: [{ provider: 'p', name: 'P', models: [{ id: 'm', name: 'M' }] }] }))
    const result = await readModels(new AbortController().signal)
    expect(result).toMatchObject({ ok: true })
  })

  it('reports kind body for a 200 answer that is not the models payload', async () => {
    stubFetch(async () => jsonResponse({ nope: true }))
    const result = await readModels(new AbortController().signal)
    expect(result).toMatchObject({ ok: false, kind: 'body', status: 200 })
  })

  it('reports kind timeout with null status, code and message after READ_TIMEOUT_MS', async () => {
    stubFetch(async () => neverSettles())
    const pending = readModels(new AbortController().signal)
    await vi.advanceTimersByTimeAsync(READ_TIMEOUT_MS)
    const result = await pending
    expect(result).toMatchObject({ ok: false, kind: 'timeout', status: null, code: null, message: null })
  })

  it('reports kind network when fetch rejects', async () => {
    stubFetch(async () => {
      throw new TypeError('fetch failed')
    })
    const result = await readModels(new AbortController().signal)
    expect(result).toMatchObject({ ok: false, kind: 'network', status: null })
  })

  it('reports kind http with the Host code, message and status', async () => {
    stubFetch(async () => jsonResponse({ code: 'x-code', message: 'x message' }, 500))
    const result = await readModels(new AbortController().signal)
    expect(result).toMatchObject({ ok: false, kind: 'http', status: 500, code: 'x-code', message: 'x message' })
  })

  it('reports kind cancelled when the caller aborts its own signal', async () => {
    stubFetch(async (_path, init) => untilAborted(init))
    const controller = new AbortController()
    const pending = readModels(controller.signal)
    controller.abort()
    const result = await pending
    expect(result).toMatchObject({ ok: false, kind: 'cancelled' })
  })
})

describe('readState', () => {
  it('requests the state of the given session', async () => {
    const seen: string[] = []
    stubFetch(async (path) => {
      seen.push(path)
      return jsonResponse({ graph: { nodes: [], edges: [], checkpoint: -1, turn: 0 }, updatedAt: null })
    })
    const result = await readState('s-1', new AbortController().signal)
    expect(result).toMatchObject({ ok: true })
    expect(seen).toEqual([STATE_PATH])
  })

  it('times out after READ_TIMEOUT_MS and not before', async () => {
    stubFetch(async () => neverSettles())
    let settled = false
    const pending = readState('s-1', new AbortController().signal).then((result) => {
      settled = true
      return result
    })
    await vi.advanceTimersByTimeAsync(READ_TIMEOUT_MS - 1)
    expect(settled).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    const result = await pending
    expect(result).toMatchObject({ ok: false, kind: 'timeout', status: null })
  })

  it('reports kind body for a 200 answer whose text is not JSON', async () => {
    stubFetch(async () => new Response('<html>not json</html>', { status: 200 }))
    const result = await readState('s-1', new AbortController().signal)
    expect(result).toMatchObject({ ok: false, kind: 'body', status: 200 })
  })
})

describe('analyzeSession', () => {
  it('POSTs the request as JSON to the analyze route', async () => {
    const seen: { path: string; method: string | undefined; body: unknown }[] = []
    stubFetch(async (path, init) => {
      seen.push({ path, method: init?.method, body: typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined })
      return jsonResponse({ graph: { nodes: [], edges: [], checkpoint: 0, turn: 0 }, analyzed: { fromSeq: 0, toSeq: 0, messages: 0, topics: 0 } })
    })
    const result = await analyzeSession(REQUEST, new AbortController().signal)
    expect(result).toMatchObject({ ok: true })
    expect(seen).toEqual([{ path: ANALYZE_PATH, method: 'POST', body: REQUEST }])
  })

  it('times out after ANALYZE_TIMEOUT_MS, not at the shorter read timeout', async () => {
    stubFetch(async () => neverSettles())
    let settled = false
    const pending = analyzeSession(REQUEST, new AbortController().signal).then((result) => {
      settled = true
      return result
    })
    await vi.advanceTimersByTimeAsync(READ_TIMEOUT_MS)
    await flush()
    expect(settled).toBe(false)
    await vi.advanceTimersByTimeAsync(ANALYZE_TIMEOUT_MS - READ_TIMEOUT_MS - 1)
    expect(settled).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    const result = await pending
    expect(result).toMatchObject({ ok: false, kind: 'timeout', status: null, code: null, message: null })
  })

  it('reports kind http with the Host code and message', async () => {
    stubFetch(async () => jsonResponse({ code: 'analysis-failed', message: '模型暂时不可用' }, 409))
    const result = await analyzeSession(REQUEST, new AbortController().signal)
    expect(result).toMatchObject({ ok: false, kind: 'http', status: 409, code: 'analysis-failed', message: '模型暂时不可用' })
  })

  it('reports kind body when the answer is not JSON', async () => {
    stubFetch(async () => new Response('not json', { status: 200 }))
    const result = await analyzeSession(REQUEST, new AbortController().signal)
    expect(result).toMatchObject({ ok: false, kind: 'body', status: 200 })
  })

  it('reports kind network when fetch rejects', async () => {
    stubFetch(async () => {
      throw new TypeError('fetch failed')
    })
    const result = await analyzeSession(REQUEST, new AbortController().signal)
    expect(result).toMatchObject({ ok: false, kind: 'network' })
  })

  it('reports kind cancelled when the caller aborts while the request is in flight', async () => {
    stubFetch(async (_path, init) => untilAborted(init))
    const controller = new AbortController()
    const pending = analyzeSession(REQUEST, controller.signal)
    controller.abort()
    const result = await pending
    expect(result).toMatchObject({ ok: false, kind: 'cancelled' })
  })
})

