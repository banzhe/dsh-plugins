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
import { createAttentionStore, deriveAttention } from '../src/client/attention.ts'
import { sessionListOf, sessionRow, sessionSources, sessionStatusOf } from './session-list-double.ts'

/** One status entry with only the fields this plugin reads. */
function status(running: boolean | undefined, completed: boolean): SessionStatus {
  return { running, pendingInteraction: undefined, completionUnread: completed }
}

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
