/**
 * Finished-unread fold: which rows the badge counts, and which of them are new
 * since the previous observation (the notification trigger). The first
 * observation must be state-only, because a page load sees sessions that
 * finished while no page was watching.
 *
 * The archive set is the third input: an archived Session is filed away, so it
 * counts for nothing — but it stays in the "already told" set, because archiving
 * does not clear the host's completion reminder and restoring must not re-announce.
 */
import { describe, expect, it } from 'vitest'
import type { SessionSummary } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { CompletionObserver } from '../src/client/completion.ts'
import {
  sessionListOf, sessionRow, sessionStatusOf, type SessionRow,
} from './session-list-double.ts'

const NONE: ReadonlySet<SessionId> = new Set()

function fold(
  observer: CompletionObserver,
  rows: readonly SessionRow[],
  archived: ReadonlySet<SessionId> = NONE,
) {
  return observer.observe(sessionStatusOf(rows), sessionListOf(rows), archived)
}

describe('CompletionObserver', () => {
  it('reports state on the first observation without announcing anyone', () => {
    const observer = new CompletionObserver()
    const observation = fold(observer, [
      sessionRow('a', { completed: true }),
      sessionRow('b', { running: true }),
    ])
    expect(observation.completed.map(row => row.id)).toEqual(['a'])
    expect(observation.newlyCompleted).toEqual([])
  })

  it('announces only the rows that joined the finished set', () => {
    const observer = new CompletionObserver()
    fold(observer, [sessionRow('a', { running: true })])
    const first = fold(observer, [
      sessionRow('a', { completed: true }),
      sessionRow('b', { running: true }),
    ])
    expect(first.newlyCompleted.map(row => row.id)).toEqual(['a'])
    const second = fold(observer, [
      sessionRow('a', { completed: true }),
      sessionRow('b', { completed: true }),
    ])
    expect(second.newlyCompleted.map(row => row.id)).toEqual(['b'])
    expect(second.completed.map(row => row.id)).toEqual(['a', 'b'])
  })

  it('does not re-announce a row that stays finished across observations', () => {
    const observer = new CompletionObserver()
    const rows = [sessionRow('a', { completed: true })]
    fold(observer, rows)
    expect(fold(observer, rows).newlyCompleted).toEqual([])
  })

  it('drops a row from the finished set when the user opens it', () => {
    const observer = new CompletionObserver()
    fold(observer, [sessionRow('a', { completed: true })])
    const opened = fold(observer, [sessionRow('a', { running: false })])
    expect(opened.completed).toEqual([])
    expect(opened.newlyCompleted).toEqual([])
  })

  it('announces a row that finishes again after being opened', () => {
    const observer = new CompletionObserver()
    fold(observer, [sessionRow('a', { completed: true })])
    fold(observer, [sessionRow('a', { running: true })])
    const again = fold(observer, [sessionRow('a', { completed: true })])
    expect(again.newlyCompleted.map(row => row.id)).toEqual(['a'])
  })

  it('skips a finished id whose row the list has not projected', () => {
    const observer = new CompletionObserver()
    const rows = [sessionRow('a', { completed: true })]
    // The status snapshot names a Session the list snapshot has no row for.
    const status = sessionStatusOf([...rows, sessionRow('ghost', { completed: true })])
    const observation = observer.observe(status, sessionListOf(rows), NONE)
    expect(observation.completed.map(row => row.id)).toEqual(['a'])
  })

  it('does not announce a finished Session that is already archived', () => {
    const observer = new CompletionObserver()
    fold(observer, [sessionRow('a', { running: true })])
    const observation = fold(
      observer,
      [sessionRow('a', { completed: true })],
      new Set(['a' as SessionId]),
    )
    expect(observation.completed).toEqual([])
    expect(observation.newlyCompleted).toEqual([])
  })

  it('stops counting a finished Session once it is archived', () => {
    const observer = new CompletionObserver()
    fold(observer, [sessionRow('a', { running: true })])
    expect(fold(observer, [sessionRow('a', { completed: true })]).completed).toHaveLength(1)
    // Archiving changes only the archive set; the status still says unread.
    expect(fold(observer, [sessionRow('a', { completed: true })], new Set(['a' as SessionId])).completed)
      .toEqual([])
  })

  it('counts a restored Session again without announcing it a second time', () => {
    const observer = new CompletionObserver()
    fold(observer, [sessionRow('a', { running: true })])
    const archived = new Set(['a' as SessionId])
    fold(observer, [sessionRow('a', { completed: true })], archived)
    const restored = fold(observer, [sessionRow('a', { completed: true })])
    expect(restored.completed.map(row => row.id)).toEqual(['a'])
    expect(restored.newlyCompleted).toEqual([])
  })

  it('leaves a subagent child out of both the count and the announcements', () => {
    const observer = new CompletionObserver()
    const child = (): SessionSummary => sessionRow('child', {
      origin: 'subagent', parentId: 'parent' as SessionId, completed: true,
    })
    fold(observer, [sessionRow('parent', { running: true }), child()])
    const observation = fold(observer, [sessionRow('parent', { completed: true }), child()])
    expect(observation.completed.map(row => row.id)).toEqual(['parent'])
    expect(observation.newlyCompleted.map(row => row.id)).toEqual(['parent'])
  })

  it('does not announce a subagent child that finishes on its own', () => {
    const observer = new CompletionObserver()
    fold(observer, [sessionRow('parent', { running: true })])
    const observation = fold(observer, [
      sessionRow('parent', { running: true }),
      sessionRow('child', { origin: 'subagent', parentId: 'parent' as SessionId, completed: true }),
    ])
    expect(observation.completed).toEqual([])
    expect(observation.newlyCompleted).toEqual([])
  })
})
