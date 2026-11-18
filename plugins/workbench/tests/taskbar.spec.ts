/**
 * Taskbar pulse projection: when the Windows progress bar should run in
 * indeterminate mode, and the presenter that writes that through the desktop
 * bridge without repeating the same on/off value.
 */
import type {
  SessionListState, SessionSummary,
} from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionStatusSnapshot } from '@deepseek-ai/dsh-client-ui-session/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { deriveAttention, type AttentionModel } from '../src/client/attention/model.ts'
import { shouldPulseTaskbar, TaskbarProgressPresenter } from '../src/client/attention/taskbar.ts'

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

/** One host row as the fold reads it. Everything else the real type carries is unused here. */
interface RowSpec {
  readonly id: string
  readonly title?: string
  readonly updatedAt: number
  readonly running?: boolean
  readonly blank?: boolean
  readonly origin?: 'user' | 'subagent'
  readonly parentId?: string
}

function listOf(rows: readonly RowSpec[]): SessionListState {
  const byId: Record<string, SessionSummary> = {}
  for (const row of rows) {
    byId[row.id] = {
      id: row.id,
      displayTitle: row.title ?? row.id,
      updatedAt: row.updatedAt,
      running: row.running === true,
      blank: row.blank === true,
      origin: row.origin ?? 'user',
      ...(row.parentId === undefined ? {} : { parentId: row.parentId }),
    } as never
  }
  return { ids: rows.map(row => row.id), byId, projectionsBySession: {} } as never
}

function statusOf(entries: Record<string, { running?: boolean; unread?: boolean; blocked?: boolean }>): SessionStatusSnapshot {
  return new Map(Object.entries(entries).map(([id, entry]) => [id, {
    running: entry.running === true,
    completionUnread: entry.unread === true,
    ...(entry.blocked === true ? { pendingInteraction: { kind: 'approval' } } : {}),
  }])) as never
}

const pins = (...values: readonly string[]): ReadonlySet<SessionId> =>
  new Set<SessionId>(values.map(value => value as SessionId))

/**
 * The model the Host folds for one Session situation. Pulse cases are stated as
 * that situation instead of a hand-built row array, so a pinned Session carries
 * whatever its real state means rather than a flag this spec would invent.
 */
function modelOf(options: {
  readonly rows: readonly RowSpec[]
  readonly status?: Record<string, { running?: boolean; unread?: boolean; blocked?: boolean }>
  readonly pinned?: readonly string[]
}): AttentionModel {
  return deriveAttention(
    listOf(options.rows),
    statusOf(options.status ?? {}),
    new Set<SessionId>(),
    pins(...(options.pinned ?? [])),
  )
}

const IDLE = modelOf({ rows: [] })
const RUNNING = modelOf({
  rows: [{ id: 'run', updatedAt: 2, running: true }],
  status: { run: { running: true } },
})

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

describe('shouldPulseTaskbar', () => {
  it('returns false for an empty model', () => {
    expect(shouldPulseTaskbar(IDLE)).toBe(false)
  })

  it('returns true when only running Sessions are listed', () => {
    expect(shouldPulseTaskbar(RUNNING)).toBe(true)
  })

  it('returns false when running shares the model with unread', () => {
    expect(shouldPulseTaskbar(modelOf({
      rows: [
        { id: 'run', updatedAt: 3, running: true },
        { id: 'done', updatedAt: 2 },
      ],
      status: { run: { running: true }, done: { unread: true } },
    }))).toBe(false)
  })

  it('returns false when the only running turn is blocked', () => {
    expect(shouldPulseTaskbar(modelOf({
      rows: [{ id: 'run', updatedAt: 2, running: true }],
      status: { run: { running: true, blocked: true } },
    }))).toBe(false)
  })

  it('returns false when only unread Sessions are listed', () => {
    expect(shouldPulseTaskbar(modelOf({
      rows: [{ id: 'done', updatedAt: 2 }],
      status: { done: { unread: true } },
    }))).toBe(false)
  })

  it('returns false when a blocked unread turn is pending', () => {
    expect(shouldPulseTaskbar(modelOf({
      rows: [{ id: 'wait', updatedAt: 2 }],
      status: { wait: { unread: true, blocked: true } },
    }))).toBe(false)
  })

  it('returns true for a pinned Session that is really running', () => {
    expect(shouldPulseTaskbar(modelOf({
      rows: [{ id: 'pin-run', updatedAt: 2, running: true }],
      status: { 'pin-run': { running: true } },
      pinned: ['pin-run'],
    }))).toBe(true)
  })

  it('returns false for a pinned Session at rest', () => {
    expect(shouldPulseTaskbar(modelOf({
      rows: [{ id: 'pin-idle', updatedAt: 2 }],
      pinned: ['pin-idle'],
    }))).toBe(false)
  })

  it('returns false for a pinned Session that is really unread', () => {
    expect(shouldPulseTaskbar(modelOf({
      rows: [{ id: 'pin-done', updatedAt: 2 }],
      status: { 'pin-done': { unread: true } },
      pinned: ['pin-done'],
    }))).toBe(false)
  })

  it('returns false when a really running pinned Session shares the model with unread', () => {
    expect(shouldPulseTaskbar(modelOf({
      rows: [
        { id: 'pin-run', updatedAt: 3, running: true },
        { id: 'done', updatedAt: 2 },
      ],
      status: { 'pin-run': { running: true }, done: { unread: true } },
      pinned: ['pin-run'],
    }))).toBe(false)
  })

  it('returns false when a really running pinned Session is blocked', () => {
    expect(shouldPulseTaskbar(modelOf({
      rows: [{ id: 'pin-run', updatedAt: 2, running: true }],
      status: { 'pin-run': { running: true, blocked: true } },
      pinned: ['pin-run'],
    }))).toBe(false)
  })
})

describe('TaskbarProgressPresenter', () => {
  it('is viable when the desktop window exposes setProgressBar', () => {
    vi.stubGlobal('dshDesktop', { window: { setProgressBar: vi.fn(async () => {}) } })
    expect(new TaskbarProgressPresenter().viable).toBe(true)
  })

  it('is not viable when the desktop bridge is absent', () => {
    expect(new TaskbarProgressPresenter().viable).toBe(false)
  })

  it('is not viable when the desktop window is absent', () => {
    vi.stubGlobal('dshDesktop', {})
    expect(new TaskbarProgressPresenter().viable).toBe(false)
  })

  it('is not viable when setProgressBar is not a function', () => {
    vi.stubGlobal('dshDesktop', { window: { setProgressBar: 1 } })
    expect(new TaskbarProgressPresenter().viable).toBe(false)
  })

  it('swallows writes when the bridge is not viable', () => {
    const presenter = new TaskbarProgressPresenter()
    expect(presenter.viable).toBe(false)
    expect(() => { presenter.project(RUNNING) }).not.toThrow()
    expect(() => { presenter.clear() }).not.toThrow()
  })

  it('writes an indeterminate pulse on the first running projection', () => {
    const setProgressBar = vi.fn(async () => {})
    vi.stubGlobal('dshDesktop', { window: { setProgressBar } })
    new TaskbarProgressPresenter().project(RUNNING)
    expect(setProgressBar).toHaveBeenCalledTimes(1)
    expect(setProgressBar).toHaveBeenCalledWith(2)
  })

  it('writes an indeterminate pulse for a really running pinned Session', () => {
    const setProgressBar = vi.fn(async () => {})
    vi.stubGlobal('dshDesktop', { window: { setProgressBar } })
    new TaskbarProgressPresenter().project(modelOf({
      rows: [{ id: 'pin-run', updatedAt: 2, running: true }],
      status: { 'pin-run': { running: true } },
      pinned: ['pin-run'],
    }))
    expect(setProgressBar.mock.calls).toEqual([[2]])
  })

  it('writes a clear on the first idle projection', () => {
    const setProgressBar = vi.fn(async () => {})
    vi.stubGlobal('dshDesktop', { window: { setProgressBar } })
    new TaskbarProgressPresenter().project(IDLE)
    expect(setProgressBar).toHaveBeenCalledTimes(1)
    expect(setProgressBar).toHaveBeenCalledWith(-1)
  })

  it('does not rewrite the same pulse or clear', () => {
    const setProgressBar = vi.fn(async () => {})
    vi.stubGlobal('dshDesktop', { window: { setProgressBar } })
    const presenter = new TaskbarProgressPresenter()
    presenter.project(RUNNING)
    presenter.project(RUNNING)
    expect(setProgressBar).toHaveBeenCalledTimes(1)
    presenter.project(IDLE)
    presenter.project(IDLE)
    expect(setProgressBar.mock.calls).toEqual([[2], [-1]])
  })

  it('writes a clear when a pulse turns idle and a pulse when idle turns running', () => {
    const setProgressBar = vi.fn(async () => {})
    vi.stubGlobal('dshDesktop', { window: { setProgressBar } })
    const presenter = new TaskbarProgressPresenter()
    presenter.project(RUNNING)
    presenter.project(IDLE)
    presenter.project(RUNNING)
    expect(setProgressBar.mock.calls).toEqual([[2], [-1], [2]])
  })

  it('clears a pulse and forgets it so a later clear is silent', () => {
    const setProgressBar = vi.fn(async () => {})
    vi.stubGlobal('dshDesktop', { window: { setProgressBar } })
    const presenter = new TaskbarProgressPresenter()
    presenter.project(RUNNING)
    presenter.clear()
    presenter.clear()
    expect(setProgressBar.mock.calls).toEqual([[2], [-1]])
    presenter.project(RUNNING)
    expect(setProgressBar.mock.calls).toEqual([[2], [-1], [2]])
  })

  it('does not write clear when the last projection was idle', () => {
    const setProgressBar = vi.fn(async () => {})
    vi.stubGlobal('dshDesktop', { window: { setProgressBar } })
    const presenter = new TaskbarProgressPresenter()
    presenter.project(IDLE)
    presenter.clear()
    expect(setProgressBar.mock.calls).toEqual([[-1]])
  })

  it('does not write clear when nothing has been projected', () => {
    const setProgressBar = vi.fn(async () => {})
    vi.stubGlobal('dshDesktop', { window: { setProgressBar } })
    new TaskbarProgressPresenter().clear()
    expect(setProgressBar).not.toHaveBeenCalled()
  })

  it('does not write clear when not viable', () => {
    vi.stubGlobal('dshDesktop', {})
    expect(() => { new TaskbarProgressPresenter().clear() }).not.toThrow()
  })

  it('warns when the shell refuses progress and still remembers the attempted state', async () => {
    const error = new Error('refused')
    const setProgressBar = vi.fn(async () => {
      throw error
    })
    vi.stubGlobal('dshDesktop', { window: { setProgressBar } })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const presenter = new TaskbarProgressPresenter()
    expect(() => { presenter.project(RUNNING) }).not.toThrow()
    await flushMicrotasks()
    expect(warn).toHaveBeenCalledWith('ui-workspace: the shell refused the taskbar progress', error)
    presenter.project(RUNNING)
    expect(setProgressBar).toHaveBeenCalledTimes(1)
    presenter.project(IDLE)
    expect(setProgressBar.mock.calls).toEqual([[2], [-1]])
  })
})
