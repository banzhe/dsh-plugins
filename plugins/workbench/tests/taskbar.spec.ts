/**
 * Taskbar pulse projection: when the Windows progress bar should run in
 * indeterminate mode, and the presenter that writes that through the desktop
 * bridge without repeating the same on/off value.
 */
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AttentionModel, AttentionRow } from '../src/client/attention/model.ts'
import { shouldPulseTaskbar, TaskbarProgressPresenter } from '../src/client/attention/taskbar.ts'

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

function row(id: string, extra: Partial<AttentionRow> = {}): AttentionRow {
  return { id: id as SessionId, title: id, ...extra }
}

function attention(over: Partial<AttentionModel> = {}): AttentionModel {
  return {
    running: over.running ?? [],
    unread: over.unread ?? [],
    waiting: over.waiting ?? [],
  }
}

const running = attention({ running: [row('run')] })
const idle = attention()

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

describe('shouldPulseTaskbar', () => {
  it('returns false for an empty model', () => {
    expect(shouldPulseTaskbar(idle)).toBe(false)
  })

  it('returns true when only running Sessions are listed', () => {
    expect(shouldPulseTaskbar(running)).toBe(true)
  })

  it('returns true for a pinned running Session', () => {
    expect(shouldPulseTaskbar(attention({ running: [row('pin-run', { pinned: true })] }))).toBe(true)
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
    }))).toBe(false)
  })

  it('returns false when only unread Sessions are listed', () => {
    expect(shouldPulseTaskbar(attention({ unread: [row('done')] }))).toBe(false)
  })

  it('returns false when a blocked unread row is listed as waiting', () => {
    const blocked = row('wait')
    expect(shouldPulseTaskbar(attention({
      unread: [blocked],
      waiting: [blocked],
    }))).toBe(false)
  })

  it('returns false for a pinned Session listed at rest', () => {
    expect(shouldPulseTaskbar(attention({
      unread: [row('pinned', { container: true, pinned: true })],
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
    expect(() => { presenter.project(running) }).not.toThrow()
    expect(() => { presenter.clear() }).not.toThrow()
  })

  it('writes an indeterminate pulse on the first running projection', () => {
    const setProgressBar = vi.fn(async () => {})
    vi.stubGlobal('dshDesktop', { window: { setProgressBar } })
    new TaskbarProgressPresenter().project(running)
    expect(setProgressBar).toHaveBeenCalledTimes(1)
    expect(setProgressBar).toHaveBeenCalledWith(2)
  })

  it('writes a clear on the first idle projection', () => {
    const setProgressBar = vi.fn(async () => {})
    vi.stubGlobal('dshDesktop', { window: { setProgressBar } })
    new TaskbarProgressPresenter().project(idle)
    expect(setProgressBar).toHaveBeenCalledTimes(1)
    expect(setProgressBar).toHaveBeenCalledWith(-1)
  })

  it('does not rewrite the same pulse or clear', () => {
    const setProgressBar = vi.fn(async () => {})
    vi.stubGlobal('dshDesktop', { window: { setProgressBar } })
    const presenter = new TaskbarProgressPresenter()
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
    const presenter = new TaskbarProgressPresenter()
    presenter.project(running)
    presenter.project(idle)
    presenter.project(running)
    expect(setProgressBar.mock.calls).toEqual([[2], [-1], [2]])
  })

  it('clears a pulse and forgets it so a later clear is silent', () => {
    const setProgressBar = vi.fn(async () => {})
    vi.stubGlobal('dshDesktop', { window: { setProgressBar } })
    const presenter = new TaskbarProgressPresenter()
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
    const presenter = new TaskbarProgressPresenter()
    presenter.project(idle)
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
    expect(() => { presenter.project(running) }).not.toThrow()
    await flushMicrotasks()
    expect(warn).toHaveBeenCalledWith('ui-workspace: the shell refused the taskbar progress', error)
    presenter.project(running)
    expect(setProgressBar).toHaveBeenCalledTimes(1)
    presenter.project(idle)
    expect(setProgressBar.mock.calls).toEqual([[2], [-1]])
  })
})
