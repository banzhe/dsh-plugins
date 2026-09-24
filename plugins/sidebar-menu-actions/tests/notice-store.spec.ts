// @vitest-environment jsdom
/**
 * `createNoticeStore`'s contract: one pending notice at a time, `show`
 * replacing it under a fresh, strictly higher `seq` (the banner's React key, so
 * a repeat restarts the hold rather than extending it), `snapshot` returning a
 * stable reference that only changes with the notice, subscribers woken on
 * every change and removed by exactly the disposer `subscribe` handed out, and
 * `dismiss` dropping the showing it names while a stale `seq` — a notice
 * already replaced — leaves its successor up.
 */
import { describe, expect, it, vi } from 'vitest'
import { createNoticeStore } from '../src/client/noticeStore.ts'

describe('createNoticeStore', () => {
  it('answers null until the first notice', () => {
    const store = createNoticeStore()
    expect(store.snapshot()).toBeNull()
  })

  it('shows the first notice under the first sequence', () => {
    const store = createNoticeStore()
    store.show('first')
    expect(store.snapshot()).toEqual({ seq: 1, text: 'first' })
  })

  it('replaces the pending notice with a higher sequence', () => {
    const store = createNoticeStore()
    store.show('first')
    const first = store.snapshot()
    store.show('second')
    expect(store.snapshot()).toEqual({ seq: 2, text: 'second' })
    expect(store.snapshot()).not.toBe(first)
  })

  it('still bumps the sequence for a repeat of the same text', () => {
    const store = createNoticeStore()
    store.show('again')
    const first = store.snapshot()
    store.show('again')
    expect(store.snapshot()?.seq).toBe(2)
    expect(store.snapshot()).not.toBe(first)
  })

  it('wakes every subscriber per change and stops at the returned disposer', () => {
    const store = createNoticeStore()
    const removed = vi.fn()
    const kept = vi.fn()
    const dispose = store.subscribe(removed)
    store.subscribe(kept)
    store.show('shown')
    expect(removed).toHaveBeenCalledTimes(1)
    expect(kept).toHaveBeenCalledTimes(1)
    dispose()
    store.dismiss(1)
    expect(removed).toHaveBeenCalledTimes(1)
    expect(kept).toHaveBeenCalledTimes(2)
  })

  it('dismisses the notice it names', () => {
    const store = createNoticeStore()
    store.show('shown')
    store.dismiss(1)
    expect(store.snapshot()).toBeNull()
  })

  it('leaves the current notice up when a stale sequence is dismissed', () => {
    const store = createNoticeStore()
    store.show('first')
    store.show('second')
    store.dismiss(1)
    expect(store.snapshot()).toEqual({ seq: 2, text: 'second' })
  })

  it('dismisses nothing, and wakes nobody, when no notice is pending', () => {
    const store = createNoticeStore()
    const listener = vi.fn()
    store.subscribe(listener)
    store.dismiss(1)
    expect(store.snapshot()).toBeNull()
    expect(listener).not.toHaveBeenCalled()
  })
})
