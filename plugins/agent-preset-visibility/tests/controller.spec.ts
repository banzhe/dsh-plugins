import type { RemoteResult } from '@deepseek-ai/dsh-api-remotes/client'
import type { AgentPresetRoster } from '@deepseek-ai/dsh-agent-preset-registry/types'
import type { ConfigForm, ConfigFormSnapshot } from '@deepseek-ai/dsh-client-ui-settings/client'
import { describe, expect, it, vi } from 'vitest'
import {
  PresetVisibilityController, type PresetVisibilityFace, type PresetVisibilitySettings, type PresetVisibilityState,
} from '../src/client/controller.ts'
import type { PresetRosterFilter, PresetListing } from '../src/client/remote.ts'

const ROSTER: AgentPresetRoster = {
  presets: [
    { id: 'standard', isDefault: true },
    { id: 'minimal', isDefault: false },
    { id: 'subagent-coder', isDefault: false, name: 'Coder', broken: 'waiting for nothing' },
  ],
}

/**
 * A settings form double: it records every write, and can hold writes so a spec
 * can act while one is in flight. An accepted write settles the section the way
 * the shared mirror does — new value, bumped revision, subscribers notified.
 */
function fakeForm(options: {
  value?: PresetVisibilitySettings
  status?: ConfigFormSnapshot<PresetVisibilitySettings>['status']
  writable?: boolean
  accept?: boolean
  reject?: boolean
} = {}) {
  let snapshot: ConfigFormSnapshot<PresetVisibilitySettings> = {
    status: options.status ?? 'ready',
    value: options.value,
    base: {},
    user: undefined,
    revision: 0,
    writable: options.writable ?? true,
  }
  const listeners = new Set<() => void>()
  const writes: string[][] = []
  let gate: Promise<void> | undefined
  let release: (() => void) | undefined
  return {
    getSnapshot: () => snapshot,
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    set: async (field: string, value: unknown): Promise<boolean> => {
      expect(field).toBe('hidden')
      const list = [...(value as readonly string[])]
      writes.push(list)
      if (gate !== undefined) await gate
      if (options.reject === true) throw new Error('the write was rejected')
      if (options.accept === false) return false
      snapshot = { ...snapshot, value: { hidden: list }, revision: (snapshot.revision ?? 0) + 1 }
      for (const listener of listeners) listener()
      return true
    },
    /** Hold every write issued from now on, until `release()`. */
    hold: () => { gate = new Promise<void>(resolve => { release = resolve }) },
    release: () => { const open = release; release = undefined; gate = undefined; open?.() },
    writes,
  }
}

/** A roster seam whose reads are answered by the spec. */
function fakeSource(readAll: PresetListing): PresetRosterFilter {
  return { readAll, install: () => () => {} }
}

const source = fakeSource(async () => ({ ok: true, value: ROSTER }))

function faceOf(
  form: ReturnType<typeof fakeForm>,
  seam: PresetRosterFilter = source,
): PresetVisibilityFace {
  const form_ = form as unknown as ConfigForm<PresetVisibilitySettings>
  return new PresetVisibilityController(form_, seam).inject()
}

function stateOf(face: PresetVisibilityFace): PresetVisibilityState {
  return face.hooks.presetVisibility.getSnapshot()
}

describe('PresetVisibilityController', () => {
  it('renders every declared preset with its name fallback and its state', async () => {
    const face = faceOf(fakeForm({ value: { hidden: ['minimal'] } }))
    await face.load()
    const state = stateOf(face)
    expect(state.status).toBe('ready')
    expect(state.rows).toEqual([
      { id: 'standard', name: 'standard', hidden: false, isDefault: true, broken: false },
      { id: 'minimal', name: 'minimal', hidden: true, isDefault: false, broken: false },
      { id: 'subagent-coder', name: 'Coder', hidden: false, isDefault: false, broken: true },
    ])
    expect(state.hiddenCount).toBe(1)
    expect(state.saving).toBe(false)
    expect(state.failure).toBeNull()
  })

  it('shows every preset when the namespace has stored no list yet', async () => {
    const face = faceOf(fakeForm())
    await face.load()
    expect(stateOf(face).rows.every(row => !row.hidden)).toBe(true)
    expect(stateOf(face).hiddenCount).toBe(0)
  })

  it('reports a failed roster read and drops the rows it could not confirm', async () => {
    const failure = {
      ok: false,
      error: { code: 'gateway/internal', message: 'offline', details: {} },
    } as unknown as RemoteResult<AgentPresetRoster>
    const face = faceOf(fakeForm(), fakeSource(async () => failure))
    await face.load()
    const state = stateOf(face)
    expect(state.status).toBe('error')
    expect(state.failure).toBe('load')
    expect(state.rows).toEqual([])
  })

  it('reports a namespace this deployment does not serve, and one still loading', async () => {
    const unavailable = faceOf(fakeForm({ status: 'unavailable' }))
    await unavailable.load()
    expect(stateOf(unavailable).status).toBe('unavailable')

    const loading = faceOf(fakeForm({ status: 'loading' }))
    await loading.load()
    expect(stateOf(loading).status).toBe('loading')
  })

  it('publishes the roster of the newest load only', async () => {
    const pending: Array<(result: RemoteResult<AgentPresetRoster>) => void> = []
    const face = faceOf(fakeForm(), {
      readAll: () => new Promise<RemoteResult<AgentPresetRoster>>(resolve => { pending.push(resolve) }),
      install: () => () => {},
    })
    const first = face.load()
    const second = face.load()
    const newer: AgentPresetRoster = { presets: [{ id: 'ptc', isDefault: true }] }
    pending[1]!({ ok: true, value: newer })
    await second
    pending[0]!({ ok: true, value: ROSTER })
    await first
    expect(stateOf(face).rows.map(row => row.id)).toEqual(['ptc'])
  })

  it('writes the whole hidden list and shows the new state', async () => {
    const form = fakeForm()
    const face = faceOf(form)
    await face.load()
    face.setHidden('minimal', true)
    await vi.waitFor(() => { expect(form.writes).toEqual([['minimal']]) })
    await vi.waitFor(() => {
      expect(stateOf(face).rows.find(row => row.id === 'minimal')?.hidden).toBe(true)
      expect(stateOf(face).hiddenCount).toBe(1)
      expect(stateOf(face).saving).toBe(false)
    })
    face.setHidden('minimal', false)
    await vi.waitFor(() => { expect(form.writes).toEqual([['minimal'], []]) })
  })

  it('queues a toggle that lands while a write is in flight', async () => {
    const form = fakeForm()
    const face = faceOf(form)
    await face.load()
    form.hold()
    face.setHidden('minimal', true)
    face.setHidden('subagent-coder', true)
    const mid = stateOf(face)
    expect(mid.saving).toBe(true)
    expect(mid.rows.filter(row => row.hidden).map(row => row.id)).toEqual(['minimal', 'subagent-coder'])
    form.release()
    // The queued list is the whole intent, not just the second click.
    await vi.waitFor(() => { expect(form.writes).toEqual([['minimal'], ['minimal', 'subagent-coder']]) })
    await vi.waitFor(() => {
      expect(stateOf(face).saving).toBe(false)
      expect(stateOf(face).hiddenCount).toBe(2)
    })
  })

  it('drops the queue when the Host refuses the write, and says so', async () => {
    const form = fakeForm({ accept: false })
    const face = faceOf(form)
    await face.load()
    face.setHidden('minimal', true)
    face.setHidden('subagent-coder', true)
    await vi.waitFor(() => { expect(stateOf(face).failure).toBe('write') })
    // The queue is dropped: the second toggle was derived from a list the Host never stored.
    expect(form.writes).toEqual([['minimal']])
    expect(stateOf(face).rows.every(row => !row.hidden)).toBe(true)
    expect(stateOf(face).saving).toBe(false)
  })

  it('reports a rejected write and stops saving instead of hanging', async () => {
    const form = fakeForm({ reject: true })
    const face = faceOf(form)
    await face.load()
    face.setHidden('minimal', true)
    await vi.waitFor(() => { expect(stateOf(face).failure).toBe('write') })
    // A rejection must not leave the page permanently saving.
    expect(stateOf(face).saving).toBe(false)
    expect(stateOf(face).rows.every(row => !row.hidden)).toBe(true)
    // The next toggle retries with a fresh write rather than staying stuck.
    face.setHidden('minimal', true)
    await vi.waitFor(() => { expect(form.writes).toHaveLength(2) })
  })

  it('ignores a toggle while the namespace is read-only', async () => {
    const form = fakeForm({ writable: false })
    const face = faceOf(form)
    await face.load()
    expect(stateOf(face).writable).toBe(false)
    face.setHidden('minimal', true)
    await Promise.resolve()
    expect(form.writes).toEqual([])
  })

  it('stops publishing, stops writing, and stops reading once disposed', async () => {
    const form = fakeForm()
    const controller = new PresetVisibilityController(
      form as unknown as ConfigForm<PresetVisibilitySettings>, source,
    )
    const face = controller.inject()
    await face.load()
    const before = stateOf(face)
    controller.dispose()
    face.setHidden('minimal', true)
    await controller.load()
    expect(form.writes).toEqual([])
    expect(stateOf(face)).toBe(before)
  })

  it('finishes a write already in flight, but publishes nothing after a dispose', async () => {
    const form = fakeForm()
    const controller = new PresetVisibilityController(
      form as unknown as ConfigForm<PresetVisibilitySettings>, source,
    )
    const face = controller.inject()
    await face.load()
    form.hold()
    face.setHidden('minimal', true)
    const frozen = stateOf(face)
    controller.dispose()
    form.release()
    await vi.waitFor(() => { expect(form.writes).toEqual([['minimal']]) })
    await Promise.resolve()
    expect(stateOf(face)).toBe(frozen)
  })
})
