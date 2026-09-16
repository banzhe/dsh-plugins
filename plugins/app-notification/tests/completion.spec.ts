/**
 * Finished-unread fold: which rows the badge counts, and which of them are new
 * since the previous observation (the notification trigger). The first
 * observation must be state-only, because a page load sees sessions that
 * finished while no page was watching.
 */
import { describe, expect, it } from 'vitest'
import type { SessionListState, SessionSummary } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { CompletionObserver } from '../src/client/completion.ts'

function summary(id: string, over: Partial<SessionSummary> = {}): SessionSummary {
  return {
    id: id as SessionId,
    displayTitle: id,
    running: false,
    blank: false,
    updatedAt: 1,
    ...over,
  }
}

function list(rows: readonly SessionSummary[], current?: string): SessionListState {
  return {
    ids: rows.map(row => row.id),
    byId: Object.fromEntries(rows.map(row => [row.id, row])),
    current: current as SessionId | undefined,
    phase: 'ready',
    subagentsByParent: {},
    jobsBySession: {},
    currentAddress: undefined,
  }
}

describe('CompletionObserver', () => {
  it('reports state on the first observation without announcing anyone', () => {
    const observer = new CompletionObserver()
    const observation = observer.observe(list([
      summary('a', { completed: true }),
      summary('b', { running: true }),
    ]))
    expect(observation.completed.map(row => row.id)).toEqual(['a'])
    expect(observation.newlyCompleted).toEqual([])
  })

  it('announces only the rows that joined the finished set', () => {
    const observer = new CompletionObserver()
    observer.observe(list([summary('a', { running: true })]))
    const first = observer.observe(list([
      summary('a', { completed: true }),
      summary('b', { running: true }),
    ]))
    expect(first.newlyCompleted.map(row => row.id)).toEqual(['a'])
    const second = observer.observe(list([
      summary('a', { completed: true }),
      summary('b', { completed: true }),
    ]))
    expect(second.newlyCompleted.map(row => row.id)).toEqual(['b'])
    expect(second.completed.map(row => row.id)).toEqual(['a', 'b'])
  })

  it('does not re-announce a row that stays finished across observations', () => {
    const observer = new CompletionObserver()
    const rows = [summary('a', { completed: true })]
    observer.observe(list(rows))
    expect(observer.observe(list(rows)).newlyCompleted).toEqual([])
  })

  it('drops a row from the finished set when the user opens it', () => {
    const observer = new CompletionObserver()
    observer.observe(list([summary('a', { completed: true })]))
    const opened = observer.observe(list([summary('a', { running: false })]))
    expect(opened.completed).toEqual([])
    expect(opened.newlyCompleted).toEqual([])
  })

  it('announces a row that finishes again after being opened', () => {
    const observer = new CompletionObserver()
    observer.observe(list([summary('a', { completed: true })]))
    observer.observe(list([summary('a', { running: true })]))
    const again = observer.observe(list([summary('a', { completed: true })]))
    expect(again.newlyCompleted.map(row => row.id)).toEqual(['a'])
  })

  it('skips an id whose row is absent from the snapshot', () => {
    const observer = new CompletionObserver()
    const state = list([summary('a', { completed: true })])
    const observation = observer.observe({ ...state, ids: [...state.ids, 'ghost' as SessionId] })
    expect(observation.completed.map(row => row.id)).toEqual(['a'])
  })

  it('leaves a subagent child out of both the count and the announcements', () => {
    const observer = new CompletionObserver()
    const child = (): SessionSummary => summary('child', {
      origin: 'subagent', parentId: 'parent' as SessionId, completed: true,
    })
    // First fold: the child is already finished while the parent still runs.
    observer.observe(list([summary('parent', { running: true }), child()]))
    const observation = observer.observe(list([summary('parent', { completed: true }), child()]))
    expect(observation.completed.map(row => row.id)).toEqual(['parent'])
    expect(observation.newlyCompleted.map(row => row.id)).toEqual(['parent'])
  })

  it('does not announce a subagent child that finishes on its own', () => {
    const observer = new CompletionObserver()
    observer.observe(list([summary('parent', { running: true })]))
    const observation = observer.observe(list([
      summary('parent', { running: true }),
      summary('child', { origin: 'subagent', parentId: 'parent' as SessionId, completed: true }),
    ]))
    expect(observation.completed).toEqual([])
    expect(observation.newlyCompleted).toEqual([])
  })
})
