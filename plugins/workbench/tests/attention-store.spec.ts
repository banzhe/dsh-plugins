import { describe, expect, it, vi } from 'vitest'
import type { SessionListState } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionStatusSnapshot } from '@deepseek-ai/dsh-client-ui-session/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { createAttentionStore } from '../src/client/attention/model.ts'

/** A writable snapshot source the store can follow, with the notify bookkeeping a test needs. */
interface FakeSource<T> {
  getSnapshot(): T
  subscribe(listener: () => void): () => void
  set(next: T): void
  /** How many listeners are attached right now. */
  readonly listeners: number
}

function sourceOf<T>(initial: T): FakeSource<T> {
  let value = initial
  const attached = new Set<() => void>()
  return {
    getSnapshot: () => value,
    subscribe: (listener) => {
      attached.add(listener)
      return () => { attached.delete(listener) }
    },
    set: (next) => {
      value = next
      attached.forEach(listener => { listener() })
    },
    get listeners() { return attached.size },
  }
}

/** One list snapshot over the given rows; the fold reads ids, rows and the projection map. */
function listOf(rows: readonly { id: string; title?: string; updatedAt: number; running?: boolean }[]): SessionListState {
  const byId: Record<string, unknown> = {}
  for (const row of rows) {
    byId[row.id] = {
      id: row.id,
      title: row.title ?? '',
      displayTitle: row.title ?? row.id,
      updatedAt: row.updatedAt,
      running: row.running === true,
      blank: false,
      origin: 'user',
    }
  }
  return { ids: rows.map(row => row.id), byId, projectionsBySession: {} } as never
}

function statusOf(entries: Record<string, { running?: boolean; unread?: boolean }>): SessionStatusSnapshot {
  // `running` is omitted when the fixture does not state it, so the fold's own
  // fallback to the list row applies exactly as it does in the Host.
  return new Map(Object.entries(entries).map(([id, entry]) => [id, {
    ...(entry.running === true ? { running: true } : {}),
    completionUnread: entry.unread === true,
  }])) as never
}

const ids = (values: readonly string[]): ReadonlySet<SessionId> =>
  new Set<SessionId>(values.map(value => value as SessionId))
const NONE = ids([])

/** The four sources one store folds, each replaceable on its own. */
function harness() {
  const list = sourceOf(listOf([{ id: 'a', updatedAt: 1 }]))
  const status = sourceOf(statusOf({ a: {} }))
  const pinned = sourceOf<ReadonlySet<SessionId>>(NONE)
  const archived = sourceOf<ReadonlySet<SessionId>>(NONE)
  return { list, status, pinned, archived, store: createAttentionStore(list, status, pinned, archived) }
}

describe('In work store', () => {
  it('folds the current snapshots at construction', () => {
    const { store } = harness()
    expect(store.getSnapshot()).toEqual({ running: [], unread: [], pinned: [], waiting: [] })
  })

  it('notifies when the Session list changes', () => {
    const { store, list } = harness()
    const listener = vi.fn()
    store.subscribe(listener)
    list.set(listOf([{ id: 'a', updatedAt: 1, running: true }]))
    expect(listener).toHaveBeenCalledTimes(1)
    expect(store.getSnapshot().running.map(row => row.id)).toEqual(['a'])
  })

  it('notifies when the status map changes', () => {
    const { store, status } = harness()
    const listener = vi.fn()
    store.subscribe(listener)
    status.set(statusOf({ a: { unread: true } }))
    expect(listener).toHaveBeenCalledTimes(1)
    expect(store.getSnapshot().unread.map(row => row.id)).toEqual(['a'])
  })

  it('notifies when a Session is pinned into the pinned group, and again when the pin is released', () => {
    const { store, pinned } = harness()
    const listener = vi.fn()
    store.subscribe(listener)
    pinned.set(ids(['a']))
    expect(store.getSnapshot().pinned).toHaveLength(1)
    expect(store.getSnapshot().pinned[0]).toMatchObject({ id: 'a', pinned: true })
    expect(store.getSnapshot().unread).toEqual([])
    expect(store.getSnapshot().running).toEqual([])
    pinned.set(NONE)
    expect(listener).toHaveBeenCalledTimes(2)
    expect(store.getSnapshot()).toEqual({ running: [], unread: [], pinned: [], waiting: [] })
  })

  it('keeps a pinned running Session in the running group', () => {
    const { store, list, pinned } = harness()
    list.set(listOf([{ id: 'a', updatedAt: 1, running: true }]))
    expect(store.getSnapshot().running).toHaveLength(1)
    pinned.set(ids(['a']))
    // Live work outranks the pin: the row stays where its state put it, now marked pinned.
    expect(store.getSnapshot().running).toHaveLength(1)
    expect(store.getSnapshot().running[0]).toMatchObject({ id: 'a', pinned: true })
    expect(store.getSnapshot().pinned).toEqual([])
  })

  it('publishes nothing when a source re-emits the same pins', () => {
    const { store, pinned } = harness()
    const listener = vi.fn()
    store.subscribe(listener)
    pinned.set(ids(['a']))
    pinned.set(ids(['a']))
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('notifies when a Session is archived, which drops it without touching the list', () => {
    const { store, archived, list } = harness()
    list.set(listOf([{ id: 'a', updatedAt: 1, running: true }]))
    const listener = vi.fn()
    store.subscribe(listener)
    archived.set(ids(['a']))
    expect(listener).toHaveBeenCalledTimes(1)
    expect(store.getSnapshot().running).toEqual([])
  })

  it('publishes nothing when a source re-emits an identical model', () => {
    const { store, status } = harness()
    const listener = vi.fn()
    store.subscribe(listener)
    // A fresh status map that folds to the same empty model: an unrelated Session
    // ticking must not cost a render.
    status.set(statusOf({ unrelated: { running: true } }))
    expect(listener).not.toHaveBeenCalled()
  })

  it('stops notifying an unsubscribed listener and keeps the others', () => {
    const { store, status } = harness()
    const first = vi.fn()
    const second = vi.fn()
    const unsubscribe = store.subscribe(first)
    store.subscribe(second)
    unsubscribe()
    status.set(statusOf({ a: { unread: true } }))
    expect(first).not.toHaveBeenCalled()
    expect(second).toHaveBeenCalledTimes(1)
  })

  it('follows no source and notifies no one once disposed', () => {
    const { store, list, status, pinned, archived } = harness()
    const listener = vi.fn()
    store.subscribe(listener)
    store.dispose()
    expect([list.listeners, status.listeners, pinned.listeners, archived.listeners]).toEqual([0, 0, 0, 0])
    list.set(listOf([{ id: 'a', updatedAt: 1, running: true }]))
    status.set(statusOf({ a: { unread: true } }))
    pinned.set(ids(['a']))
    archived.set(ids(['a']))
    expect(listener).not.toHaveBeenCalled()
    // The last published model stays readable: dispose detaches, it does not blank.
    expect(store.getSnapshot()).toEqual({ running: [], unread: [], pinned: [], waiting: [] })
  })
})
