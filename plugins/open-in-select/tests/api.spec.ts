/**
 * The two Host calls: what they request, and how each answer becomes a result the
 * control can render. No React, no DOM — the transport is injected.
 */
import { describe, expect, it, vi } from 'vitest'
import { launchApp, loadApps, refusalKey } from '../src/client/api.ts'
import { APPS_ROUTE, OPEN_ROUTE } from '../src/client/routes.ts'

interface Call {
  readonly url: string
  readonly init?: RequestInit
}

interface Answer {
  readonly status: number
  readonly body: unknown
}

/** The JSON body a spec posted, or null when the call carried none. */
function postedBody(call: Call | undefined): unknown {
  const raw = call?.init?.body
  return typeof raw === 'string' ? (JSON.parse(raw) as unknown) : null
}

/** A fetcher that answers the routes a spec names and records every call. */
function responder(answers: Record<string, Answer>, calls: Call[] = []) {
  return async (url: string, init?: RequestInit): Promise<Response> => {
    calls.push(init === undefined ? { url } : { url, init })
    const answer = answers[url]
    if (answer === undefined) throw new Error('unrouted ' + url)
    return {
      ok: answer.status >= 200 && answer.status < 300,
      status: answer.status,
      json: async () => answer.body,
    } as unknown as Response
  }
}

describe('loadApps', () => {
  it('asks the documented route and answers the ids in Host order', async () => {
    const calls: Call[] = []
    const fetcher = responder({ [APPS_ROUTE]: { status: 200, body: { apps: ['vscode', 'explorer'] } } }, calls)
    expect(await loadApps(fetcher)).toEqual(['vscode', 'explorer'])
    expect(calls).toEqual([{ url: APPS_ROUTE, init: { headers: { accept: 'application/json' } } }])
  })

  it('keeps only the entries that are application ids', async () => {
    const fetcher = responder({ [APPS_ROUTE]: { status: 200, body: { apps: ['vscode', 3, null, 'cursor'] } } })
    expect(await loadApps(fetcher)).toEqual(['vscode', 'cursor'])
  })

  it('answers an empty list when the route refuses', async () => {
    const fetcher = responder({ [APPS_ROUTE]: { status: 503, body: { apps: ['vscode'] } } })
    expect(await loadApps(fetcher)).toEqual([])
  })

  it('answers an empty list when the payload carries no id list', async () => {
    const wrongType = responder({ [APPS_ROUTE]: { status: 200, body: { apps: 'vscode' } } })
    const missing = responder({ [APPS_ROUTE]: { status: 200, body: {} } })
    expect(await loadApps(wrongType)).toEqual([])
    expect(await loadApps(missing)).toEqual([])
  })

  it('answers an empty list when the Host cannot be reached', async () => {
    expect(await loadApps(async () => { throw new Error('offline') })).toEqual([])
  })
})

describe('launchApp', () => {
  it('posts the application and the directory as JSON', async () => {
    const calls: Call[] = []
    const fetcher = responder({ [OPEN_ROUTE]: { status: 200, body: { ok: true } } }, calls)
    expect(await launchApp('vscode', '/work/demo', fetcher)).toEqual({ kind: 'opened' })
    expect(calls).toHaveLength(1)
    expect(calls[0]?.url).toBe(OPEN_ROUTE)
    expect(calls[0]?.init?.method).toBe('POST')
    expect(calls[0]?.init?.headers).toEqual({ 'content-type': 'application/json' })
    expect(postedBody(calls[0])).toEqual({ app: 'vscode', path: '/work/demo' })
  })

  it('reports the documented refusals with their status', async () => {
    for (const status of [400, 404, 413, 415, 502]) {
      const fetcher = responder({ [OPEN_ROUTE]: { status, body: { code: 'refused' } } })
      expect(await launchApp('vscode', '/work/demo', fetcher)).toEqual({ kind: 'refused', status })
    }
  })

  it('reports a refusal status the Host does not document unchanged', async () => {
    const fetcher = responder({ [OPEN_ROUTE]: { status: 500, body: null } })
    expect(await launchApp('vscode', '/work/demo', fetcher)).toEqual({ kind: 'refused', status: 500 })
  })

  it('reports an unreachable Host as its own outcome', async () => {
    expect(await launchApp('vscode', '/work/demo', async () => { throw new Error('offline') }))
      .toEqual({ kind: 'unreachable' })
  })
})

describe('refusalKey', () => {
  it('names the copy of every documented refusal', () => {
    expect(refusalKey(400)).toBe('error.invalid')
    expect(refusalKey(404)).toBe('error.missing')
    expect(refusalKey(413)).toBe('error.tooLong')
    expect(refusalKey(415)).toBe('error.unsupported')
    expect(refusalKey(502)).toBe('error.launch')
  })

  it('answers nothing for a status the Host does not document', () => {
    expect(refusalKey(500)).toBeNull()
    expect(refusalKey(200)).toBeNull()
    expect(refusalKey(0)).toBeNull()
  })
})

describe('the default transport', () => {
  it('reads and posts through the page fetch', async () => {
    const calls: Call[] = []
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit): Promise<Response> => {
      calls.push(init === undefined ? { url } : { url, init })
      return { ok: true, status: 200, json: async () => ({ apps: ['vscode'] }) } as unknown as Response
    })
    expect(await loadApps()).toEqual(['vscode'])
    expect(await launchApp('vscode', '/work/demo')).toEqual({ kind: 'opened' })
    expect(calls.map(call => call.url)).toEqual([APPS_ROUTE, OPEN_ROUTE])
    vi.unstubAllGlobals()
  })
})
