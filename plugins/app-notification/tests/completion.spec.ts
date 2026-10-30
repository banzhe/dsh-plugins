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
  sessionListOf, sessionRow, sessionStatusOf, subagentCatalogEntry, subagentRow, type SessionRow,
} from './session-list-double.ts'

const NONE: ReadonlySet<SessionId> = new Set()

function fold(
  observer: CompletionObserver,
  rows: readonly SessionRow[],
  archived: ReadonlySet<SessionId> = NONE,
  running: Readonly<Record<string, boolean | undefined>> = {},
) {
  return observer.observe(sessionStatusOf(rows, running), sessionListOf(rows), archived)
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

  describe('a parent still waiting on its subagents', () => {
    const catalog = [subagentCatalogEntry('child')]
    const parent = (over: Partial<SessionRow> = {}): SessionRow =>
      sessionRow('parent', { catalog, ...over })

    it('holds a parent whose subagent catalog names a running child', () => {
      const observer = new CompletionObserver()
      fold(observer, [parent({ running: true })], NONE, { child: true })
      const observation = fold(observer, [parent({ completed: true })], NONE, { child: true })
      expect(observation.completed).toEqual([])
      expect(observation.newlyCompleted).toEqual([])
    })

    it('counts a parent whose catalog names no running subagent', () => {
      const observer = new CompletionObserver()
      fold(observer, [parent({ running: true })])
      const observation = fold(observer, [parent({ completed: true })])
      expect(observation.completed.map(row => row.id)).toEqual(['parent'])
      expect(observation.newlyCompleted.map(row => row.id)).toEqual(['parent'])
    })

    it('holds a parent whose retained subagent row is running', () => {
      const observer = new CompletionObserver()
      const child = (running: boolean): SessionRow =>
        subagentRow('child', { parentId: 'parent' as SessionId, running })
      fold(observer, [sessionRow('parent', { running: true }), child(true)])
      const observation = fold(observer, [sessionRow('parent', { completed: true }), child(true)])
      expect(observation.completed).toEqual([])
      expect(observation.newlyCompleted).toEqual([])
    })

    it('lets the status running flag outrank the retained subagent row', () => {
      const observer = new CompletionObserver()
      const child = subagentRow('child', { parentId: 'parent' as SessionId, running: false })
      fold(observer, [sessionRow('parent', { running: true }), child], NONE, { child: true })
      const observation = fold(
        observer,
        [sessionRow('parent', { completed: true }), child],
        NONE,
        { child: true },
      )
      expect(observation.completed).toEqual([])
      expect(observation.newlyCompleted).toEqual([])
    })

    it('treats a child listed in both the catalog and the retained rows the same way', () => {
      const observer = new CompletionObserver()
      const child = (): SessionRow =>
        subagentRow('child', { parentId: 'parent' as SessionId, running: true })
      fold(observer, [parent({ running: true }), child()])
      const observation = fold(observer, [parent({ completed: true }), child()])
      expect(observation.completed).toEqual([])
      expect(observation.newlyCompleted).toEqual([])
    })

    it('announces a parent whose subagent has already stopped', () => {
      const observer = new CompletionObserver()
      fold(observer, [parent({ running: true })], NONE, { child: false })
      const observation = fold(observer, [parent({ completed: true })], NONE, { child: false })
      expect(observation.completed.map(row => row.id)).toEqual(['parent'])
      expect(observation.newlyCompleted.map(row => row.id)).toEqual(['parent'])
    })

    it('holds the announcement until the subagent stops, then announces once', () => {
      const observer = new CompletionObserver()
      fold(observer, [parent({ running: true })], NONE, { child: true })
      const held = fold(observer, [parent({ completed: true })], NONE, { child: true })
      expect(held.completed).toEqual([])
      expect(held.newlyCompleted).toEqual([])

      const stopped = fold(observer, [parent({ completed: true })], NONE, { child: false })
      expect(stopped.completed.map(row => row.id)).toEqual(['parent'])
      expect(stopped.newlyCompleted.map(row => row.id)).toEqual(['parent'])

      const settled = fold(observer, [parent({ completed: true })], NONE, { child: false })
      expect(settled.completed.map(row => row.id)).toEqual(['parent'])
      expect(settled.newlyCompleted).toEqual([])
    })

    it('holds the parent while any of its subagents is still running', () => {
      const observer = new CompletionObserver()
      const both = (over: Partial<SessionRow> = {}): SessionRow => sessionRow('parent', {
        catalog: [subagentCatalogEntry('one'), subagentCatalogEntry('two')],
        ...over,
      })
      fold(observer, [both({ running: true })], NONE, { one: true, two: true })
      const oneStopped = fold(observer, [both({ completed: true })], NONE, { one: false, two: true })
      expect(oneStopped.completed).toEqual([])
      expect(oneStopped.newlyCompleted).toEqual([])

      const allStopped = fold(observer, [both({ completed: true })], NONE, { one: false, two: false })
      expect(allStopped.newlyCompleted.map(row => row.id)).toEqual(['parent'])
    })
  })

  describe('a parent still waiting on its descendants', () => {
    const parentRow = (over: Partial<SessionRow> = {}): SessionRow =>
      sessionRow('parent', { catalog: [subagentCatalogEntry('child')], ...over })
    const childRow = (over: Partial<SessionRow> = {}): SessionRow =>
      subagentRow('child', {
        parentId: 'parent' as SessionId,
        catalog: [subagentCatalogEntry('grandchild')],
        ...over,
      })
    const grandchildRow = (over: Partial<SessionRow> = {}): SessionRow =>
      subagentRow('grandchild', { parentId: 'child' as SessionId, ...over })

    it('holds a parent whose grandchild is still running', () => {
      const observer = new CompletionObserver()
      fold(observer, [
        parentRow({ running: true }), childRow(), grandchildRow({ running: true }),
      ])
      const observation = fold(observer, [
        parentRow({ completed: true }), childRow(), grandchildRow({ running: true }),
      ])
      expect(observation.completed).toEqual([])
      expect(observation.newlyCompleted).toEqual([])
    })

    it('holds the announcement until the grandchild stops, then announces once', () => {
      const observer = new CompletionObserver()
      const rows = (grandchildRunning: boolean): readonly SessionRow[] => [
        parentRow({ completed: true }),
        childRow(),
        grandchildRow({ running: grandchildRunning }),
      ]

      const held = fold(observer, rows(true))
      expect(held.completed).toEqual([])
      expect(held.newlyCompleted).toEqual([])

      const stopped = fold(observer, rows(false))
      expect(stopped.completed.map(row => row.id)).toEqual(['parent'])
      expect(stopped.newlyCompleted.map(row => row.id)).toEqual(['parent'])

      const settled = fold(observer, rows(false))
      expect(settled.completed.map(row => row.id)).toEqual(['parent'])
      expect(settled.newlyCompleted).toEqual([])
    })

    it('holds a parent whose running grandchild only the child catalog names', () => {
      const observer = new CompletionObserver()
      const rows = (over: Partial<SessionRow>): readonly SessionRow[] => [
        parentRow(over),
        childRow(),
      ]
      fold(observer, rows({ running: true }), NONE, { grandchild: true })
      const observation = fold(observer, rows({ completed: true }), NONE, { grandchild: true })
      expect(observation.completed).toEqual([])
      expect(observation.newlyCompleted).toEqual([])
    })

    it('holds a parent whose running grandchild is only a retained row', () => {
      const observer = new CompletionObserver()
      const child = subagentRow('child', { parentId: 'parent' as SessionId })
      const grandchild = grandchildRow({ running: true })
      fold(observer, [parentRow({ running: true }), child, grandchild])
      const observation = fold(observer, [parentRow({ completed: true }), child, grandchild])
      expect(observation.completed).toEqual([])
      expect(observation.newlyCompleted).toEqual([])
    })

    it('lets the status running flag outrank a stopped grandchild row', () => {
      const observer = new CompletionObserver()
      const grandchild = grandchildRow({ running: false })
      fold(observer, [parentRow({ running: true }), childRow(), grandchild], NONE, { grandchild: true })
      const observation = fold(
        observer,
        [parentRow({ completed: true }), childRow(), grandchild],
        NONE,
        { grandchild: true },
      )
      expect(observation.completed).toEqual([])
      expect(observation.newlyCompleted).toEqual([])
    })

    it('returns a finite result for a subagent that parents itself', () => {
      const observer = new CompletionObserver()
      const selfParented = subagentRow('child', {
        parentId: 'child' as SessionId,
        catalog: [subagentCatalogEntry('child')],
        running: false,
      })
      fold(observer, [parentRow({ running: true }), selfParented])
      const observation = fold(observer, [parentRow({ completed: true }), selfParented])
      expect(observation.completed.map(row => row.id)).toEqual(['parent'])
      expect(observation.newlyCompleted.map(row => row.id)).toEqual(['parent'])
    }, 1_000)

    it('holds a parent while any grandchild branch is still running', () => {
      const observer = new CompletionObserver()
      const rows = (parentCompleted: boolean): readonly SessionRow[] => [
        sessionRow('parent', {
          completed: parentCompleted,
          catalog: [subagentCatalogEntry('one'), subagentCatalogEntry('two')],
        }),
        subagentRow('one', {
          parentId: 'parent' as SessionId,
          catalog: [subagentCatalogEntry('one-a')],
        }),
        subagentRow('two', {
          parentId: 'parent' as SessionId,
          catalog: [subagentCatalogEntry('two-a')],
        }),
        subagentRow('one-a', { parentId: 'one' as SessionId }),
        subagentRow('two-a', { parentId: 'two' as SessionId }),
      ]

      fold(observer, rows(false), NONE, { 'one-a': true, 'two-a': false })
      const held = fold(observer, rows(true), NONE, { 'one-a': true, 'two-a': false })
      expect(held.completed).toEqual([])
      expect(held.newlyCompleted).toEqual([])

      const allStopped = fold(observer, rows(true), NONE, { 'one-a': false, 'two-a': false })
      expect(allStopped.completed.map(row => row.id)).toEqual(['parent'])
      expect(allStopped.newlyCompleted.map(row => row.id)).toEqual(['parent'])
    })
  })
})
