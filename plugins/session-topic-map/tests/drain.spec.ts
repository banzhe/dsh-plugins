import { afterEach, describe, expect, it, vi } from 'vitest'
import { DRAIN_INTERVAL_MS, runDrain, waitFor, type DrainDeps, type DrainStep } from '../src/client/drain.ts'

afterEach(() => {
  vi.useRealTimers()
})

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

function makeDeps(analyze: DrainDeps['analyze'], wait: DrainDeps['wait']) {
  const steps: DrainStep[] = []
  const failures: (string | null)[] = []
  const deps: DrainDeps = {
    analyze,
    wait,
    onStep: (step) => {
      steps.push(step)
    },
    onFailure: (message) => {
      failures.push(message)
    },
  }
  return { deps, steps, failures }
}

describe('drain scheduler', () => {
  it('exports a two second interval', () => {
    expect(DRAIN_INTERVAL_MS).toBe(2000)
  })

  it('drains consecutive non-empty steps without waiting', async () => {
    const controller = new AbortController()
    const wait = vi.fn(async () => undefined)
    let calls = 0
    const { deps, steps } = makeDeps(async () => {
      calls += 1
      if (calls === 3) controller.abort()
      return { messages: 2, topics: 1 }
    }, wait)

    await runDrain(deps, controller.signal)

    expect(calls).toBe(3)
    expect(steps).toEqual([{ messages: 2, topics: 1 }, { messages: 2, topics: 1 }])
    expect(wait).not.toHaveBeenCalled()
  })

  it('waits DRAIN_INTERVAL_MS after an empty step before analyzing again', async () => {
    const controller = new AbortController()
    const waits: number[] = []
    let calls = 0
    const { deps, steps } = makeDeps(async () => {
      calls += 1
      if (calls === 2) controller.abort()
      return { messages: 0, topics: 0 }
    }, async (ms) => {
      waits.push(ms)
    })

    await runDrain(deps, controller.signal)
    expect(waits).toEqual([DRAIN_INTERVAL_MS])
    expect(steps).toHaveLength(1)
  })

  it('reports the failure once with the Error message and ends the loop without waiting or retrying', async () => {
    const controller = new AbortController()
    const wait = vi.fn(async () => undefined)
    let calls = 0
    const { deps, failures, steps } = makeDeps(async () => {
      calls += 1
      if (calls === 1) return { messages: 1, topics: 1 }
      throw new Error('model stream failed')
    }, wait)

    await expect(runDrain(deps, controller.signal)).resolves.toBeUndefined()
    expect(calls).toBe(2)
    expect(steps).toEqual([{ messages: 1, topics: 1 }])
    expect(failures).toEqual(['model stream failed'])
    expect(wait).not.toHaveBeenCalled()
  })

  it('reports null for a non-Error rejection and ends the loop without waiting', async () => {
    const controller = new AbortController()
    const wait = vi.fn(async () => undefined)
    let calls = 0
    const { deps, failures } = makeDeps(async () => {
      calls += 1
      throw 'plain string'
    }, wait)

    await expect(runDrain(deps, controller.signal)).resolves.toBeUndefined()
    expect(calls).toBe(1)
    expect(failures).toEqual([null])
    expect(wait).not.toHaveBeenCalled()
  })

  it('stops with no further calls when aborted during analyze, and reports neither step nor failure', async () => {
    const controller = new AbortController()
    let calls = 0
    const { deps, failures, steps } = makeDeps(async () => {
      calls += 1
      controller.abort()
      throw new Error('aborted mid-flight')
    }, async () => undefined)

    await expect(runDrain(deps, controller.signal)).resolves.toBeUndefined()
    expect(calls).toBe(1)
    expect(steps).toEqual([])
    expect(failures).toEqual([])
  })

  it('stops with no further calls when aborted during the wait', async () => {
    const controller = new AbortController()
    let calls = 0
    const { deps, steps } = makeDeps(async () => {
      calls += 1
      return { messages: 0, topics: 0 }
    }, async (_ms, signal) => {
      controller.abort()
      await waitFor(DRAIN_INTERVAL_MS, signal)
    })

    await expect(runDrain(deps, controller.signal)).resolves.toBeUndefined()
    expect(calls).toBe(1)
    expect(steps).toHaveLength(1)
  })

  it('never has two analyze calls in flight', async () => {
    const controller = new AbortController()
    let inFlight = false
    let overlaps = 0
    let calls = 0
    const { deps } = makeDeps(async () => {
      if (inFlight) overlaps += 1
      inFlight = true
      calls += 1
      await flush()
      inFlight = false
      if (calls === 5) controller.abort()
      return { messages: 1, topics: 0 }
    }, async () => undefined)

    await runDrain(deps, controller.signal)
    expect(calls).toBe(5)
    expect(overlaps).toBe(0)
  })

  it('does not call analyze at all when the signal is already aborted', async () => {
    const controller = new AbortController()
    controller.abort()
    const analyze = vi.fn(async () => ({ messages: 0, topics: 0 }))
    const { deps } = makeDeps(analyze, async () => undefined)

    await runDrain(deps, controller.signal)
    expect(analyze).not.toHaveBeenCalled()
  })
})

describe('waitFor', () => {
  it('resolves after the given delay', async () => {
    vi.useFakeTimers()
    const controller = new AbortController()
    let settled = false
    const pending = waitFor(500, controller.signal).then(() => {
      settled = true
    })

    vi.advanceTimersByTime(499)
    await Promise.resolve()
    expect(settled).toBe(false)
    vi.advanceTimersByTime(1)
    await pending
    expect(settled).toBe(true)
  })

  it('resolves immediately when the signal aborts, and never rejects', async () => {
    vi.useFakeTimers()
    const controller = new AbortController()
    const pending = waitFor(DRAIN_INTERVAL_MS, controller.signal)
    controller.abort()
    await expect(pending).resolves.toBeUndefined()
    expect(vi.getTimerCount()).toBe(0)
  })
})
