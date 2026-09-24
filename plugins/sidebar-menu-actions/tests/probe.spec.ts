// @vitest-environment jsdom
/**
 * `probeVscode`'s decision table over a stubbed `fetch`: exactly one GET of the
 * document-relative apps route, `false` without reading the body on a non-ok
 * response, `true` only when the payload's `apps` is an array containing
 * `'vscode'`, and a hard `false` for every thrown or rejected outcome — the
 * probe never propagates a failure upward.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { probeVscode } from '../src/client/workspaceMenu.ts'

/** The apps route the probe must address, document-relative (no leading slash). */
const APPS = 'open-in-app/apps'
/** The exact request header set the probe must send. */
const APPS_CALL = [APPS, { headers: { accept: 'application/json' } }] as const

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('probeVscode', () => {
  it('asks the apps route exactly once with a JSON accept header', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ apps: ['vscode'] }) }))
    vi.stubGlobal('fetch', fetchMock)
    await expect(probeVscode()).resolves.toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock).toHaveBeenCalledWith(...APPS_CALL)
  })

  it('answers false on a non-ok response without reading the body', async () => {
    const json = vi.fn(async () => ({ apps: ['vscode'] }))
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, json })))
    await expect(probeVscode()).resolves.toBe(false)
    expect(json).not.toHaveBeenCalled()
  })

  it('answers false when the payload carries no apps field', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({}) })))
    await expect(probeVscode()).resolves.toBe(false)
  })

  it('answers false when apps is present but not an array', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ apps: 'vscode' }) })))
    await expect(probeVscode()).resolves.toBe(false)
  })

  it('answers false when the apps array does not contain vscode', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ apps: ['cursor'] }) })))
    await expect(probeVscode()).resolves.toBe(false)
  })

  it('answers false when fetch throws synchronously', async () => {
    vi.stubGlobal('fetch', vi.fn((): Promise<never> => { throw new Error('offline') }))
    await expect(probeVscode()).resolves.toBe(false)
  })

  it('answers false when reading the body rejects with an Error', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async (): Promise<never> => { throw new Error('bad json') },
    })))
    await expect(probeVscode()).resolves.toBe(false)
  })

  it('answers false when reading the body rejects with a non-Error', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async (): Promise<never> => { throw 'nope' },
    })))
    await expect(probeVscode()).resolves.toBe(false)
  })
})
