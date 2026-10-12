/**
 * The attention fold and its store: which sessions are listed, in what order,
 * and the snapshot-identity contract the overlay entry renders against.
 *
 * Pure data work — no DOM and no React — so these specs drive the snapshots
 * directly through the same doubles the browser-half spec uses.
 */
import type { SessionStatus, SessionStatusSnapshot } from '@deepseek-ai/dsh-client-ui-session/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { describe, expect, it, vi } from 'vitest'
import {
  createAttentionStore, deriveAttention, formatDuration, runElapsed,
} from '../src/client/attention.ts'
import type { SessionRow } from './session-list-double.ts'
import {
  parentWithChildren, sessionListOf, sessionRow, sessionSources,
  sessionStatusOf, subagentRow,
} from './session-list-double.ts'

/** One status entry with only the fields this plugin reads. */
function status(running: boolean | undefined, completed: boolean): SessionStatus {
  return { running, pendingInteraction: undefined, completionUnread: completed }
}

describe('formatDuration', () => {
  it('formats m:ss below an hour and h:mm:ss from there', () => {
    expect(formatDuration(0)).toBe('0:00')
    expect(formatDuration(999)).toBe('0:00')
    expect(formatDuration(65_000)).toBe('1:05')
    expect(formatDuration(3_600_000)).toBe('1:00:00')
    expect(formatDuration(3_975_000)).toBe('1:06:15')
  })
})

describe('runElapsed', () => {
  it('measures from the latest human prompt, and is undefined before it is read', () => {
    const running = { id: 'r' as SessionId, title: 'r', lastPromptAt: 10_000 }
    const pending = { id: 'p' as SessionId, title: 'p' }
    expect(runElapsed(running, 12_500)).toBe(2500)
    expect(runElapsed(pending, 12_500)).toBeUndefined()
  })

  it('never goes negative when the clock moved backwards', () => {
    const row = { id: 'r' as SessionId, title: 'r', lastPromptAt: 10_000 }
    expect(runElapsed(row, 5_000)).toBe(0)
  })
})

describe('deriveAttention', () => {
  it('splits running from finished-unread and drops everything else', () => {
    const rows = [
      sessionRow('older-run', { running: true, updatedAt: 1 }),
      sessionRow('newer-run', { running: true, updatedAt: 5 }),
      sessionRow('finished', { completed: true, updatedAt: 3 }),
      sessionRow('idle', { updatedAt: 9 }),
    ]
    const model = deriveAttention(sessionListOf(rows), sessionStatusOf(rows))
    // Newest first inside each section.
    expect(model.running).toEqual([
      { id: 'newer-run', title: 'newer-run' },
      { id: 'older-run', title: 'older-run' },
    ])
    expect(model.unread).toEqual([{ id: 'finished', title: 'finished' }])
    expect(model.total).toBe(3)
  })

  it('keeps the Host list order when timestamps tie', () => {
    const rows = [
      sessionRow('first', { running: true, updatedAt: 7 }),
      sessionRow('second', { running: true, updatedAt: 7 }),
    ]
    const model = deriveAttention(sessionListOf(rows), sessionStatusOf(rows))
    expect(model.running.map(row => row.id)).toEqual(['first', 'second'])
  })

  it('never lists subagent children, New-Session placeholders, or unprojected ids', () => {
    const subagent = sessionRow('child', { running: true, origin: 'subagent', parentId: 'parent' as SessionId })
    const blank = sessionRow('placeholder', { completed: true, blank: true })
    const projected = sessionRow('real', { running: true })
    const list = sessionListOf([subagent, blank, projected])
    // A Host-listed id with no row yet: nothing to label, so nothing to show.
    list.ids.push('ghost' as SessionId)
    // A row that exists only in `byId` (a retained subagent fallback) is not a
    // Host-list member and must stay out for the same reason.
    list.byId['retained' as SessionId] = sessionRow('retained', { completed: true })

    const model = deriveAttention(list, sessionStatusOf([subagent, blank, projected]))
    expect(model.running).toEqual([{ id: 'real', title: 'real' }])
    expect(model.unread).toEqual([])
    expect(model.total).toBe(1)
  })

  it('prefers the status snapshot and falls back to the row', () => {
    const rows = [
      // The status source is authoritative when it has an answer.
      sessionRow('list-says-running', { running: true, updatedAt: 1 }),
      // The row is the display fallback for a Session whose baseline never arrived.
      sessionRow('no-baseline', { running: true, updatedAt: 2 }),
      // Neither fact is present: not an attention row.
      sessionRow('quiet', { updatedAt: 3 }),
      // Both facts at once: still working is the more actionable answer.
      sessionRow('both', { completed: true, running: true, updatedAt: 4 }),
    ]
    const statuses: SessionStatusSnapshot = new Map([
      ['list-says-running' as SessionId, status(false, true)],
      ['no-baseline' as SessionId, status(undefined, false)],
      ['quiet' as SessionId, status(undefined, false)],
      ['both' as SessionId, status(true, true)],
    ])
    const model = deriveAttention(sessionListOf(rows), statuses)
    expect(model.running).toEqual([{ id: 'both', title: 'both' }, { id: 'no-baseline', title: 'no-baseline' }])
    expect(model.unread).toEqual([{ id: 'list-says-running', title: 'list-says-running' }])
    expect(model.total).toBe(3)
  })

  it('falls back to the row when the status source knows nothing at all', () => {
    const rows = [sessionRow('running', { running: true })]
    const model = deriveAttention(sessionListOf(rows), new Map())
    expect(model.running).toEqual([{ id: 'running', title: 'running' }])
  })

  it('reports a blocked row as waiting, beside the section it already joined', () => {
    const rows = [
      sessionRow('blocked-run', { running: true, blocked: true, updatedAt: 2 }),
      sessionRow('plain-run', { running: true, updatedAt: 1 }),
      sessionRow('blocked-unread', { completed: true, blocked: true, updatedAt: 3 }),
    ]
    const model = deriveAttention(sessionListOf(rows), sessionStatusOf(rows))
    // `waiting` is read off the listed rows, never a third section: both of its
    // members keep the row the panel renders, and `total` counts each once.
    expect(model.running).toEqual([
      { id: 'blocked-run', title: 'blocked-run' },
      { id: 'plain-run', title: 'plain-run' },
    ])
    expect(model.unread).toEqual([{ id: 'blocked-unread', title: 'blocked-unread' }])
    expect(model.waiting).toEqual([
      { id: 'blocked-unread', title: 'blocked-unread' },
      { id: 'blocked-run', title: 'blocked-run' },
    ])
    expect(model.total).toBe(3)
  })

  it('never lets a blocked unlisted row into waiting', () => {
    // A subagent child holding a pending interaction is still not Host-list work,
    // and a Session the host reports as neither running nor unread has no row in
    // the panel: the outline must not report a state with no row behind it. The
    // real flows cannot reach that second shape — a pending interaction is a live
    // Host request holding the turn open — so this is the fold's backstop.
    const child = sessionRow('child', { origin: 'subagent', blocked: true })
    const idle = sessionRow('idle', { blocked: true })
    const model = deriveAttention(sessionListOf([child, idle]), sessionStatusOf([child, idle]))
    expect(model.waiting).toEqual([])
    expect(model.total).toBe(0)
  })

  it('never lists subagent children of their own, at rest or running', () => {
    // The old spec pinned children out of the panel entirely; the tree keeps
    // that rule for the row itself and mounts a running child under its parent.
    const rows = parentWithChildren(sessionRow('parent', { running: true }), [
      ['child-1', { running: true }],
      ['child-2', {}],
      ['child-3', { completed: true }],
    ])
    const model = deriveAttention(sessionListOf(rows), sessionStatusOf(rows))
    expect(model.running).toEqual([{
      id: 'parent',
      title: 'parent',
      children: [{ id: 'child-1', title: 'child-1' }],
    }])
    // One panel row for the parent: the children ride it, not the count.
    expect(model.total).toBe(1)
    expect(model.unread).toEqual([])
  })

  it('lists an idle parent carrying only running subagents, as a container row', () => {
    const rows = parentWithChildren(sessionRow('parent'), [
      ['child-1', { running: true }],
      ['child-2', {}],
    ])
    const model = deriveAttention(sessionListOf(rows), sessionStatusOf(rows))
    expect(model.running).toEqual([{
      id: 'parent', title: 'parent', container: true,
      children: [{ id: 'child-1', title: 'child-1' }],
    }])
    expect(model.total).toBe(1)
  })

  it('does not list an idle parent whose subagents have all settled', () => {
    const rows = parentWithChildren(sessionRow('parent'), [
      ['child-1', { completed: true }],
      ['child-2', {}],
    ])
    const model = deriveAttention(sessionListOf(rows), sessionStatusOf(rows))
    expect(model.running).toEqual([])
    expect(model.unread).toEqual([])
    expect(model.total).toBe(0)
  })

  it('falls a running child back to the row flag when the status knows nothing', () => {
    // The parent is idle: its only listing fact is the child's own row flag.
    const rows = parentWithChildren(sessionRow('parent'), [['child-1', { running: true }]])
    const model = deriveAttention(sessionListOf(rows), new Map())
    expect(model.running).toEqual([{
      id: 'parent', title: 'parent', container: true,
      children: [{ id: 'child-1', title: 'child-1' }],
    }])
  })

  it('orders children by the parent catalog, then retained rows in list order', () => {
    const rows = parentWithChildren(sessionRow('parent', { running: true }), [
      ['cat-1', { running: true }],
      ['cat-2', { running: true }],
    ])
    // A retained fallback row the catalog does not know: it appends last.
    const list = sessionListOf(rows)
    const retained = subagentRow('retained', { parentId: 'parent' as SessionId, running: true })
    list.ids.push(retained.id)
    list.byId[retained.id] = retained

    const model = deriveAttention(list, sessionStatusOf([...rows, retained]))
    expect(model.running[0]?.children).toEqual([
      { id: 'cat-1', title: 'cat-1' },
      { id: 'cat-2', title: 'cat-2' },
      { id: 'retained', title: 'retained' },
    ])
  })

  it('labels a catalog child from its title projection, then the catalog label', () => {
    const rows = parentWithChildren(sessionRow('parent', { running: true }), [
      ['titled', { running: true, title: 'Projected' }],
      ['labelled', { running: true }],
    ])
    const model = deriveAttention(sessionListOf(rows), sessionStatusOf(rows))
    expect(model.running[0]?.children).toEqual([
      { id: 'titled', title: 'Projected' },
      { id: 'labelled', title: 'labelled' },
    ])
  })

  it('keeps the prompt time on an idle container row that has one', () => {
    // A container row is not a running run, so the panel renders no duration
    // even when the metadata projection still carries an old prompt time.
    const rows = parentWithChildren(sessionRow('parent', { lastPromptAt: 42 }), [
      ['child-1', { running: true }],
    ])
    const model = deriveAttention(sessionListOf(rows), sessionStatusOf(rows))
    expect(model.running).toEqual([{
      id: 'parent',
      title: 'parent',
      lastPromptAt: 42,
      container: true,
      children: [{ id: 'child-1', title: 'child-1' }],
    }])
  })

  it('carries the child open-turn start as the child row anchor', () => {
    const rows = parentWithChildren(sessionRow('parent', { running: true }), [
      ['child-1', { running: true, activeSince: 500 }],
    ])
    const model = deriveAttention(sessionListOf(rows), sessionStatusOf(rows))
    expect(model.running).toEqual([{
      id: 'parent',
      title: 'parent',
      children: [{ id: 'child-1', title: 'child-1', turnedAt: 500 }],
    }])

    // A child whose timing projection has not been read renders no anchor.
    const unreadTiming = parentWithChildren(sessionRow('parent', { running: true }), [
      ['child-1', { running: true }],
    ])
    expect(deriveAttention(sessionListOf(unreadTiming), sessionStatusOf(unreadTiming)).running)
      .toEqual([{ id: 'parent', title: 'parent', children: [{ id: 'child-1', title: 'child-1' }] }])
  })

  it('counts a child row from its open turn, not its parent prompt', () => {
    expect(runElapsed({ id: 'c' as SessionId, title: 'c', turnedAt: 10_000 }, 13_500)).toBe(3500)
    // The anchor is the child's own: a parent field never leaks in.
    expect(runElapsed({ id: 'c' as SessionId, title: 'c' }, 13_500)).toBeUndefined()
  })

  it('re-anchors a child row when a new turn opens under the same parent', () => {
    // A settled child's `active` leaves and a new turn opens with a newer
    // `since`: the child's anchor moves, which is a re-key the store repaints.
    const rows = parentWithChildren(sessionRow('parent', { running: true }), [
      ['child-1', { running: true, activeSince: 500 }],
    ])
    const model = deriveAttention(sessionListOf(rows), sessionStatusOf(rows))
    expect(model.running[0]?.children).toEqual([{ id: 'child-1', title: 'child-1', turnedAt: 500 }])

    const rows2 = parentWithChildren(sessionRow('parent', { running: true }), [
      ['child-1', { running: true, activeSince: 9000 }],
    ])
    const model2 = deriveAttention(sessionListOf(rows2), sessionStatusOf(rows2))
    expect(model2.running[0]?.children).toEqual([{ id: 'child-1', title: 'child-1', turnedAt: 9000 }])
  })

  it('stamps running rows with the durable prompt time and leaves unread rows without one', () => {
    const rows = [
      sessionRow('run', { running: true, updatedAt: 1, lastPromptAt: 100 }),
      sessionRow('run-unread', { running: true, updatedAt: 2, lastPromptAt: null }),
      sessionRow('done', { completed: true, updatedAt: 3, lastPromptAt: 100 }),
    ]
    const model = deriveAttention(sessionListOf(rows), sessionStatusOf(rows))
    expect(model.running).toEqual([
      { id: 'run-unread', title: 'run-unread' },
      { id: 'run', title: 'run', lastPromptAt: 100 },
    ])
    expect(model.unread).toEqual([{ id: 'done', title: 'done' }])
  })

  it('follows the projection forward: absent time, real time, and a new prompt restarting the count', () => {
    const sources = sessionSources([sessionRow('run', { running: true, updatedAt: 1 })])
    const store = createAttentionStore(sources.list, sources.status)
    // Before the projection is read the row is listed with no duration fact.
    expect(store.getSnapshot().running).toEqual([{ id: 'run', title: 'run' }])

    // The projection read lands with the current prompt time.
    const base = 1_720_000_000_000
    sources.update((draft) => {
      draft.byId['run' as SessionId] = sessionRow('run', {
        running: true, updatedAt: 2, lastPromptAt: base,
      })
    })
    expect(store.getSnapshot().running).toEqual([{ id: 'run', title: 'run', lastPromptAt: base }])

    // Activity pushes move `updatedAt` but never the prompt time: the count
    // must not restart with the work.
    sources.update((draft) => {
      draft.byId['run' as SessionId] = sessionRow('run', {
        running: true, updatedAt: 99, lastPromptAt: base,
      })
    })
    expect(store.getSnapshot().running[0]?.lastPromptAt).toBe(base)

    // A new prompt is a new run: the count restarts from the new time.
    sources.update((draft) => {
      draft.byId['run' as SessionId] = sessionRow('run', {
        running: true, updatedAt: 100, lastPromptAt: base + 5000,
      })
    })
    expect(store.getSnapshot().running[0]?.lastPromptAt).toBe(base + 5000)
  })

  it('does not let one list snapshot start leak into another fold', () => {
    const rows = [sessionRow('run', { running: true, updatedAt: 1, lastPromptAt: 42 })]
    // Two folds over two list snapshot objects read the same durable fact:
    // both rows carry the prompt time, and neither holds stale client state.
    const first = deriveAttention(sessionListOf(rows), sessionStatusOf(rows))
    const second = deriveAttention(sessionListOf(rows), sessionStatusOf(rows))
    expect(first.running[0]?.lastPromptAt).toBe(42)
    expect(second.running[0]?.lastPromptAt).toBe(42)
  })

  it('repaints when a subagent starts under a parent whose other facts stand still', () => {
    const rows = parentWithChildren(sessionRow('parent', { running: true, updatedAt: 1 }), [
      ['child-1', {}],
    ])
    const model = deriveAttention(sessionListOf(rows), sessionStatusOf(rows))
    expect(model.running).toEqual([{ id: 'parent', title: 'parent' }])

    // The child starts: same parent row fields, new children block.
    const started: SessionRow[] = rows.map(row => row.id === 'parent'
      ? sessionRow('parent', { running: true, updatedAt: 1 })
      : row.id === ('child-1' as SessionId)
        ? subagentRow('child-1', { running: true })
        : row)
    const startedModel = deriveAttention(sessionListOf(started), sessionStatusOf(started))
    expect(startedModel.running).toEqual([{
      id: 'parent',
      title: 'parent',
      children: [{ id: 'child-1', title: 'child-1' }],
    }])
  })
})

describe('createAttentionStore', () => {
  it('keeps the snapshot object while the content stands still, and republishes when it moves', () => {
    const sources = sessionSources([sessionRow('a', { running: true })])
    const store = createAttentionStore(sources.list, sources.status)
    const first = store.getSnapshot()
    expect(first.total).toBe(1)
    const listener = vi.fn()
    const unsubscribe = store.subscribe(listener)

    // An unrelated list write: an idle row arrives, the content is unchanged.
    sources.update((draft) => {
      draft.ids.push('idle' as SessionId)
      draft.byId['idle' as SessionId] = sessionRow('idle', { updatedAt: 4 })
    })
    expect(listener).not.toHaveBeenCalled()
    expect(store.getSnapshot()).toBe(first)

    // The running Session finishes while out of view. The Host publishes the
    // list and the status separately, so the fold runs twice: first against the
    // new row with the previous status (still running, new label), then against
    // both. Two publishes for one transition is the honest cost of two sources.
    sources.update((draft) => {
      draft.byId['a' as SessionId] = sessionRow('a', {
        completed: true, updatedAt: 2, displayTitle: 'Alpha',
      })
    })
    expect(listener).toHaveBeenCalledTimes(2)
    const moved = store.getSnapshot()
    expect(moved).not.toBe(first)
    expect(moved.running).toEqual([])
    expect(moved.unread).toEqual([{ id: 'a', title: 'Alpha' }])

    // A label change alone is a change too.
    sources.update((draft) => {
      draft.byId['a' as SessionId] = sessionRow('a', { completed: true, updatedAt: 2, displayTitle: 'Renamed' })
    })
    expect(listener).toHaveBeenCalledTimes(3)
    expect(store.getSnapshot().unread).toEqual([{ id: 'a', title: 'Renamed' }])

    unsubscribe()
    sources.update((draft) => {
      draft.byId['a' as SessionId] = sessionRow('a', { running: true, updatedAt: 3 })
    })
    expect(listener).toHaveBeenCalledTimes(3)
  })

  it('stops following both sources once disposed', () => {
    const sources = sessionSources([sessionRow('a', { running: true })])
    const store = createAttentionStore(sources.list, sources.status)
    const published = store.getSnapshot()
    store.dispose()
    sources.update((draft) => {
      draft.ids.push('b' as SessionId)
      draft.byId['b' as SessionId] = sessionRow('b', { completed: true, updatedAt: 2 })
    })
    expect(store.getSnapshot()).toBe(published)
  })
})
