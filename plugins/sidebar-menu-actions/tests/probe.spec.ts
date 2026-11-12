// @vitest-environment jsdom
/**
 * The open-in-app catalog probe: `readAppCatalog`'s failure table (it never
 * rejects) and `createLaunchProbe`'s warm, memo, failure-retry and waiting
 * decisions. A failed read is never fatal here — it only means the launch rows
 * stay out of the menu.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  CATALOG_FAILURE_LOG,
  FIRST_ANSWER_WAIT_MS,
  LAUNCH_APP_IDS,
  createLaunchProbe,
  missingAppLog,
  readAppCatalog,
} from '../src/client/probe.ts'

const CATALOG = 'open-in-app/apps'

interface FakeResponse {
  readonly ok: boolean
  readonly status: number
  readonly json: () => Promise<unknown>
}

function answer(payload: unknown, status = 200): FakeResponse {
  return { ok: status >= 200 && status < 300, status, json: async () => payload }
}

function listing(apps: readonly string[]): FakeResponse {
  return answer({ apps })
}

function headerValue(init: RequestInit | undefined, name: string): string | undefined {
  const headers = init?.headers
  if (headers === undefined) return undefined
  const asHeaders = headers as Headers
  if (typeof asHeaders.get === 'function') return asHeaders.get(name) ?? undefined
  if (Array.isArray(headers)) {
    const pair = (headers as readonly (readonly string[])[]).find(entry => entry[0]?.toLowerCase() === name)
    return pair?.[1]
  }
  const record = headers as Record<string, string | undefined>
  const key = Object.keys(record).find(candidate => candidate.toLowerCase() === name)
  return key === undefined ? undefined : record[key]
}

type CatalogRead = Awaited<ReturnType<typeof readAppCatalog>>

function failureOf(read: CatalogRead): string {
  if (read.ok) throw new Error('expected the catalog read to fail')
  return read.detail
}

function probeOf() {
  const warn = vi.fn()
  const probe = createLaunchProbe({ warn })
  return { warn, probe, signal: new AbortController().signal }
}

/** The messages `warn` received, first argument only (a detail may follow). */
function warned(warn: ReturnType<typeof vi.fn>): string[] {
  return warn.mock.calls.map(call => String(call[0]))
}

function flush(): Promise<void> {
  return new Promise<void>((resolve) => { setTimeout(() => { resolve() }, 0) })
}

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('the published probe contract', () => {
  it('names the apps it can launch and the first-answer budget', () => {
    expect([...LAUNCH_APP_IDS]).toEqual(['vscode', 'explorer'])
    expect(FIRST_ANSWER_WAIT_MS).toBe(300)
    expect(CATALOG_FAILURE_LOG).toBe(
      'sidebar-menu-actions: the open-in-app catalog could not be read; the workspace menu omits the launch rows',
    )
    expect(missingAppLog('cursor')).toBe(
      'sidebar-menu-actions: cursor is not available on this host; the workspace menu omits that row',
    )
  })
})

describe('readAppCatalog', () => {
  it('asks the apps route for JSON exactly once', async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => listing(['vscode', 'explorer']))
    vi.stubGlobal('fetch', fetchMock)
    await readAppCatalog()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0] ?? []
    expect(url).toBe(CATALOG)
    expect(headerValue(init, 'accept')).toBe('application/json')
  })

  it('answers the app ids the host listed', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => listing(['vscode', 'explorer'])))
    await expect(readAppCatalog()).resolves.toEqual({ ok: true, apps: new Set(['vscode', 'explorer']) })
  })

  it('keeps only the ids the host actually listed', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => listing(['cursor'])))
    const read = await readAppCatalog()
    expect(read.ok).toBe(true)
    if (!read.ok) return
    expect([...read.apps]).toEqual(['cursor'])
    expect(read.apps.has('vscode')).toBe(false)
    expect(read.apps.has('explorer')).toBe(false)
  })

  it('reports a non-2xx status as HTTP <status>', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => answer({ apps: ['vscode'] }, 503)))
    expect(failureOf(await readAppCatalog())).toBe('HTTP 503')
  })

  it('reports an answer that carries no app list', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => answer({})))
    expect(failureOf(await readAppCatalog())).toBe('the answer carried no app list')
    vi.stubGlobal('fetch', vi.fn(async () => answer({ apps: 'vscode' })))
    expect(failureOf(await readAppCatalog())).toBe('the answer carried no app list')
  })

  it('reports a transport failure as the error message', async () => {
    vi.stubGlobal('fetch', vi.fn((): FakeResponse => { throw new Error('offline') }))
    expect(failureOf(await readAppCatalog())).toBe('offline')
  })

  it('reports a body failure as the error message', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async (): Promise<never> => { throw new Error('bad json') },
    })))
    expect(failureOf(await readAppCatalog())).toBe('bad json')
  })

  it('reports an unknown thrown value as its text', async () => {
    vi.stubGlobal('fetch', vi.fn((): FakeResponse => { throw 'boom' }))
    expect(failureOf(await readAppCatalog())).toBe('boom')
  })
})

describe('createLaunchProbe', () => {
  it('warms the answer and then serves every caller from memory', async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => listing(['vscode', 'explorer']))
    vi.stubGlobal('fetch', fetchMock)
    const { probe, signal } = probeOf()
    probe.warm()
    await flush()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    await expect(probe.appsFor(signal)).resolves.toEqual(new Set(['vscode', 'explorer']))
    await expect(probe.appsFor(signal)).resolves.toEqual(new Set(['vscode', 'explorer']))
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('starts one request however often it is warmed', async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => listing(['vscode']))
    vi.stubGlobal('fetch', fetchMock)
    const { probe, signal } = probeOf()
    probe.warm()
    probe.warm()
    await flush()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    await expect(probe.appsFor(signal)).resolves.toEqual(new Set(['vscode']))
    probe.warm()
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('starts the request itself when no warm-up happened', async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => listing(['vscode']))
    vi.stubGlobal('fetch', fetchMock)
    const { probe, signal } = probeOf()
    await expect(probe.appsFor(signal)).resolves.toEqual(new Set(['vscode']))
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('answers an empty set when the catalog cannot be read, and logs it once', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => answer({}, 500)))
    const { probe, signal, warn } = probeOf()
    await expect(probe.appsFor(signal)).resolves.toEqual(new Set())
    expect(warned(warn)).toEqual([CATALOG_FAILURE_LOG])
    expect(warn.mock.calls[0]?.[1]).toBe('HTTP 500')
  })

  it('does not warn about missing apps when the read failed', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => answer({}, 500)))
    const { probe, signal, warn } = probeOf()
    await probe.appsFor(signal)
    expect(warned(warn)).not.toContain(missingAppLog('vscode'))
    expect(warned(warn)).not.toContain(missingAppLog('explorer'))
  })

  it('retries the read on the next caller after a failed answer', async () => {
    let response = answer({}, 500)
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => response)
    vi.stubGlobal('fetch', fetchMock)
    const { probe, signal } = probeOf()
    await expect(probe.appsFor(signal)).resolves.toEqual(new Set())
    response = listing(['vscode'])
    await expect(probe.appsFor(signal)).resolves.toEqual(new Set(['vscode']))
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('warns once per launch app the host does not list', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => listing(['vscode'])))
    const { probe, signal, warn } = probeOf()
    await probe.appsFor(signal)
    await probe.appsFor(signal)
    expect(warned(warn)).toEqual([missingAppLog('explorer')])
  })

  it('warns about every missing launch app, in launch order', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => listing([])))
    const { probe, signal, warn } = probeOf()
    await probe.appsFor(signal)
    expect(warned(warn)).toEqual([missingAppLog('vscode'), missingAppLog('explorer')])
  })

  it('answers an empty set once the first-answer budget lapses, keeping the request in flight', async () => {
    const fetchMock = vi.fn((_url: string, _init?: RequestInit) => new Promise<FakeResponse>(() => {}))
    vi.stubGlobal('fetch', fetchMock)
    const { probe, signal } = probeOf()
    vi.useFakeTimers()
    const pending = probe.appsFor(signal)
    await vi.advanceTimersByTimeAsync(FIRST_ANSWER_WAIT_MS)
    await expect(pending).resolves.toEqual(new Set())
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('rejects an already aborted caller without asking the Host', async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => listing(['vscode']))
    vi.stubGlobal('fetch', fetchMock)
    const { probe } = probeOf()
    const controller = new AbortController()
    controller.abort()
    await expect(probe.appsFor(controller.signal)).rejects.toBe(controller.signal.reason)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('rejects a waiter that aborts, while the shared request survives it', async () => {
    let release: ((response: FakeResponse) => void) | undefined
    const fetchMock = vi.fn((_url: string, _init?: RequestInit) => new Promise<FakeResponse>((resolve) => { release = resolve }))
    vi.stubGlobal('fetch', fetchMock)
    const { probe } = probeOf()
    const controller = new AbortController()
    const abandoned = probe.appsFor(controller.signal)
    controller.abort()
    await expect(abandoned).rejects.toBe(controller.signal.reason)
    const waiting = probe.appsFor(new AbortController().signal)
    release?.(listing(['vscode']))
    await expect(waiting).resolves.toEqual(new Set(['vscode']))
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})
