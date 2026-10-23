// @vitest-environment jsdom
/**
 * `probeOpenInApps`'s decision table over a stubbed `fetch`: every thrown or
 * rejected outcome must answer an empty set — the probe never propagates a
 * failure upward, because a failed probe simply means the launch rows stay out.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { probeOpenInApps } from '../src/client/workspaceMenu.ts'

/** The apps route the probe must address, document-relative (no leading slash). */
const APPS = 'open-in-app/apps'
const APPS_CALL = [APPS, { headers: { accept: 'application/json' } }] as const

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('probeOpenInApps', () => {
  it('asks the apps route exactly once with a JSON accept header', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ apps: ['vscode', 'explorer'] }) }))
    vi.stubGlobal('fetch', fetchMock)
    await expect(probeOpenInApps()).resolves.toEqual(new Set(['vscode', 'explorer']))
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock).toHaveBeenCalledWith(...APPS_CALL)
  })

  it('answers an empty set on a non-ok response without reading the body', async () => {
    const json = vi.fn(async () => ({ apps: ['vscode'] }))
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, json })))
    await expect(probeOpenInApps()).resolves.toEqual(new Set())
    expect(json).not.toHaveBeenCalled()
  })

  it('answers an empty set when the payload carries no apps field', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({}) })))
    await expect(probeOpenInApps()).resolves.toEqual(new Set())
  })

  it('answers an empty set when apps is present but not an array', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ apps: 'vscode' }) })))
    await expect(probeOpenInApps()).resolves.toEqual(new Set())
  })

  it('keeps only the ids the Host actually listed', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ apps: ['cursor'] }) })))
    const apps = await probeOpenInApps()
    expect([...apps]).toEqual(['cursor'])
    expect(apps.has('vscode')).toBe(false)
    expect(apps.has('explorer')).toBe(false)
  })

  it('answers an empty set when fetch throws synchronously', async () => {
    vi.stubGlobal('fetch', vi.fn((): Promise<never> => { throw new Error('offline') }))
    await expect(probeOpenInApps()).resolves.toEqual(new Set())
  })

  it('answers an empty set when reading the body rejects with an Error', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async (): Promise<never> => { throw new Error('bad json') },
    })))
    await expect(probeOpenInApps()).resolves.toEqual(new Set())
  })

  it('answers an empty set when reading the body rejects with a non-Error', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async (): Promise<never> => { throw 'nope' },
    })))
    await expect(probeOpenInApps()).resolves.toEqual(new Set())
  })
})
