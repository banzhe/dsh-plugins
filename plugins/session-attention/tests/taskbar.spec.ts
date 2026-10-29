// @vitest-environment jsdom
/**
 * Taskbar pulse projection: when the Windows progress bar should run in
 * indeterminate mode, and the presenter that writes that through the desktop
 * bridge without repeating the same on/off value.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AttentionModel, AttentionRow } from '../src/client/attention.ts'
import { shouldPulseTaskbar, TaskbarProgressPresenter } from '../src/client/taskbar.ts'

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

function row(id: string, extra: Partial<AttentionRow> = {}): AttentionRow {
  return { id: id as SessionId, title: id, ...extra }
}

function attention(over: Partial<AttentionModel> = {}): AttentionModel {
  const running = over.running ?? []
  const unread = over.unread ?? []
  const waiting = over.waiting ?? []
  return {
    running,
    unread,
    waiting,
    total: over.total ?? running.length + unread.length,
  }
}

const running = attention({ running: [row('run')] })
const idle = attention()

function fakeLogger(): Context['logger'] {
  return { warn: vi.fn() } as unknown as Context['logger']
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

describe('shouldPulseTaskbar', () => {
  it('returns false for an empty model', () => {
    expect(shouldPulseTaskbar(attention({ total: 0 }))).toBe(false)
  })

  it('returns true when only running sessions are listed', () => {
    expect(shouldPulseTaskbar(running)).toBe(true)
  })

  it('returns false when running shares the model with unread', () => {
    expect(shouldPulseTaskbar(attention({
      running: [row('run')],
      unread: [row('done')],
    }))).toBe(false)
  })

  it('returns false when waiting duplicates a running row', () => {
    const listed = row('run')
    expect(shouldPulseTaskbar(attention({
      running: [listed],
      waiting: [listed],
      total: 1,
    }))).toBe(false)
  })

  it('returns false when only unread sessions are listed', () => {
    expect(shouldPulseTaskbar(attention({ unread: [row('done')] }))).toBe(false)
  })

  it('returns false when a blocked unread row is listed as waiting', () => {
    const blocked = row('wait')
    expect(shouldPulseTaskbar(attention({
      unread: [blocked],
      waiting: [blocked],
      total: 1,
    }))).toBe(false)
  })

  it('returns true for a container running row with no waiting or unread', () => {
    expect(shouldPulseTaskbar(attention({
      running: [row('run', { container: true })],
    }))).toBe(true)
  })

  it('does not consult total', () => {
    expect(shouldPulseTaskbar(attention({ running: [row('run')], total: 0 }))).toBe(true)
    expect(shouldPulseTaskbar(attention({ total: 99 }))).toBe(false)
  })
})

describe('TaskbarProgressPresenter', () => {
  it('is viable when the desktop window exposes setProgressBar', () => {
    vi.stubGlobal('dshDesktop', { window: { setProgressBar: vi.fn(async () => {}) } })
    expect(new TaskbarProgressPresenter(fakeLogger()).viable).toBe(true)
  })

  it('is not viable when the desktop bridge is absent', () => {
    expect(new TaskbarProgressPresenter(fakeLogger()).viable).toBe(false)
  })

  it('is not viable when the desktop window is absent', () => {
    vi.stubGlobal('dshDesktop', {})
    expect(new TaskbarProgressPresenter(fakeLogger()).viable).toBe(false)
  })

  it('is not viable when setProgressBar is not a function', () => {
    vi.stubGlobal('dshDesktop', { window: { setProgressBar: 1 } })
    expect(new TaskbarProgressPresenter(fakeLogger()).viable).toBe(false)
  })

  it('swallows writes when the bridge is not viable', () => {
    const presenter = new TaskbarProgressPresenter(fakeLogger())
    expect(presenter.viable).toBe(false)
    expect(() => { presenter.project(running) }).not.toThrow()
    expect(() => { presenter.clear() }).not.toThrow()
  })

  it('writes an indeterminate pulse on the first running projection', () => {
    const setProgressBar = vi.fn(async () => {})
    vi.stubGlobal('dshDesktop', { window: { setProgressBar } })
    new TaskbarProgressPresenter(fakeLogger()).project(running)
    expect(setProgressBar).toHaveBeenCalledTimes(1)
    expect(setProgressBar).toHaveBeenCalledWith(2)
  })

  it('writes a clear on the first idle projection', () => {
    const setProgressBar = vi.fn(async () => {})
    vi.stubGlobal('dshDesktop', { window: { setProgressBar } })
    new TaskbarProgressPresenter(fakeLogger()).project(idle)
    expect(setProgressBar).toHaveBeenCalledTimes(1)
    expect(setProgressBar).toHaveBeenCalledWith(-1)
  })

  it('does not rewrite the same pulse or clear', () => {
    const setProgressBar = vi.fn(async () => {})
    vi.stubGlobal('dshDesktop', { window: { setProgressBar } })
    const presenter = new TaskbarProgressPresenter(fakeLogger())
    presenter.project(running)
    presenter.project(running)
    expect(setProgressBar).toHaveBeenCalledTimes(1)
    presenter.project(idle)
    presenter.project(idle)
    expect(setProgressBar.mock.calls).toEqual([[2], [-1]])
  })

  it('writes a clear when a pulse turns idle and a pulse when idle turns running', () => {
    const setProgressBar = vi.fn(async () => {})
    vi.stubGlobal('dshDesktop', { window: { setProgressBar } })
    const presenter = new TaskbarProgressPresenter(fakeLogger())
    presenter.project(running)
    presenter.project(idle)
    presenter.project(running)
    expect(setProgressBar.mock.calls).toEqual([[2], [-1], [2]])
  })

  it('does not call the bridge from project when not viable', () => {
    const setProgressBar = vi.fn(async () => {})
    vi.stubGlobal('dshDesktop', { window: { reveal: vi.fn() } })
    const presenter = new TaskbarProgressPresenter(fakeLogger())
    expect(presenter.viable).toBe(false)
    presenter.project(running)
    presenter.project(idle)
    expect(setProgressBar).not.toHaveBeenCalled()
  })

  it('clears a pulse and forgets it so a later clear is silent', () => {
    const setProgressBar = vi.fn(async () => {})
    vi.stubGlobal('dshDesktop', { window: { setProgressBar } })
    const presenter = new TaskbarProgressPresenter(fakeLogger())
    presenter.project(running)
    presenter.clear()
    presenter.clear()
    expect(setProgressBar.mock.calls).toEqual([[2], [-1]])
    presenter.project(running)
    expect(setProgressBar.mock.calls).toEqual([[2], [-1], [2]])
  })

  it('does not write clear when the last projection was idle', () => {
    const setProgressBar = vi.fn(async () => {})
    vi.stubGlobal('dshDesktop', { window: { setProgressBar } })
    const presenter = new TaskbarProgressPresenter(fakeLogger())
    presenter.project(idle)
    presenter.clear()
    expect(setProgressBar.mock.calls).toEqual([[-1]])
  })

  it('does not write clear when nothing has been projected', () => {
    const setProgressBar = vi.fn(async () => {})
    vi.stubGlobal('dshDesktop', { window: { setProgressBar } })
    new TaskbarProgressPresenter(fakeLogger()).clear()
    expect(setProgressBar).not.toHaveBeenCalled()
  })

  it('does not write clear when not viable', () => {
    vi.stubGlobal('dshDesktop', {})
    expect(() => { new TaskbarProgressPresenter(fakeLogger()).clear() }).not.toThrow()
  })

  it('warns when the shell refuses progress and still remembers the attempted state', async () => {
    const error = new Error('refused')
    const setProgressBar = vi.fn(async () => {
      throw error
    })
    vi.stubGlobal('dshDesktop', { window: { setProgressBar } })
    const logger = fakeLogger()
    const presenter = new TaskbarProgressPresenter(logger)
    expect(() => { presenter.project(running) }).not.toThrow()
    await flushMicrotasks()
    expect(logger.warn).toHaveBeenCalledWith(
      'session-attention: the shell refused the taskbar progress',
      error,
    )
    presenter.project(running)
    expect(setProgressBar).toHaveBeenCalledTimes(1)
    presenter.project(idle)
    expect(setProgressBar.mock.calls).toEqual([[2], [-1]])
  })
})
