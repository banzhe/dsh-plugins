import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { RemoteResult } from '@deepseek-ai/dsh-api-remotes/client'
import type { AgentPresetRoster } from '@deepseek-ai/dsh-agent-preset-registry/types'
import { describe, expect, it } from 'vitest'
import { presetRosterFilter, type PresetListing } from '../src/client/remote.ts'

const ROSTER: AgentPresetRoster = {
  presets: [
    { id: 'standard', isDefault: true },
    { id: 'minimal', isDefault: false },
  ],
}

/**
 * A namespace service shaped like the gateway's: `list` is an own CONFIGURABLE
 * accessor handing back a fresh listing per read
 * (`packages/api/gateway/src/client/index.ts:687-701`) — so a caller reads the
 * property, then calls what it returned.
 */
function gatewayNamespace(answer: () => Promise<RemoteResult<AgentPresetRoster>>): Record<string, unknown> {
  const namespace: Record<string, unknown> = {}
  Object.defineProperty(namespace, 'list', {
    configurable: true,
    enumerable: true,
    get: () => () => answer(),
  })
  return namespace
}

function contextOf(namespace: object): ClientContext {
  return { remote: { agentPresets: namespace } } as unknown as ClientContext
}

/** One roster read the way a picker makes it: read the property, call the listing. */
function readOf(namespace: Record<string, unknown>): PresetListing {
  return () => (namespace.list as PresetListing)()
}

describe('presetRosterFilter', () => {
  it('declines a namespace whose listing is not a replaceable accessor', () => {
    expect(presetRosterFilter(contextOf({ list: () => ROSTER }))).toBeUndefined()
    expect(presetRosterFilter(contextOf({}))).toBeUndefined()
  })

  it('reads the host roster unfiltered before anything is installed', async () => {
    const seam = presetRosterFilter(contextOf(gatewayNamespace(async () => ({ ok: true, value: ROSTER }))))
    expect(seam).toBeDefined()
    expect(await seam!.readAll()).toEqual({ ok: true, value: ROSTER })
  })

  it('drops hidden rows from what a picker reads, and only from there', async () => {
    const namespace = gatewayNamespace(async () => ({ ok: true, value: ROSTER }))
    const seam = presetRosterFilter(contextOf(namespace))!
    const read = readOf(namespace)
    let hidden = new Set(['minimal'])
    const dispose = seam.install(() => hidden)
    const listed = await read()
    expect(listed.ok && listed.value.presets.map(row => row.id)).toEqual(['standard'])
    // The unfiltered read the page uses is unaffected by the install.
    expect(await seam.readAll()).toEqual({ ok: true, value: ROSTER })
    hidden = new Set()
    const again = await read()
    expect(again.ok && again.value.presets).toHaveLength(2)
    dispose()
  })

  it('follows the live hidden set rather than the one captured at install', async () => {
    const namespace = gatewayNamespace(async () => ({ ok: true, value: ROSTER }))
    const seam = presetRosterFilter(contextOf(namespace))!
    const read = readOf(namespace)
    const hidden = new Set<string>()
    const dispose = seam.install(() => hidden)
    expect((await read()).ok).toBe(true)
    hidden.add('standard')
    const after = await read()
    expect(after.ok && after.value.presets.map(row => row.id)).toEqual(['minimal'])
    dispose()
  })

  it('passes a host failure through untouched', async () => {
    const failure = {
      ok: false,
      error: { code: 'gateway/internal', message: 'offline', details: {} },
    } as unknown as RemoteResult<AgentPresetRoster>
    const namespace = gatewayNamespace(async () => failure)
    const seam = presetRosterFilter(contextOf(namespace))!
    const dispose = seam.install(() => new Set(['minimal']))
    expect(await readOf(namespace)()).toBe(failure)
    dispose()
  })

  it('restores the host listing on unload, and leaves a replaced property alone', async () => {
    const namespace = gatewayNamespace(async () => ({ ok: true, value: ROSTER }))
    const seam = presetRosterFilter(contextOf(namespace))!
    const read = readOf(namespace)
    const dispose = seam.install(() => new Set(['minimal']))
    const filtered = await read()
    expect(filtered.ok && filtered.value.presets).toHaveLength(1)
    dispose()
    const restored = await read()
    expect(restored.ok && restored.value.presets).toHaveLength(2)
    // A second owner replaced the property; the stale disposer must not clobber it.
    const second = seam.install(() => new Set())
    Object.defineProperty(namespace, 'list', { configurable: true, value: () => 'other' })
    second()
    expect(Reflect.get(namespace, 'list')).toBeTypeOf('function')
  })
})
