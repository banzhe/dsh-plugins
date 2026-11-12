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

  it('waits for the parent to run its own turn after the subagent settles, then announces once', () => {
    const observer = new CompletionObserver()
    const parent = (over: Partial<SessionRow> = {}): SessionRow =>
      sessionRow('parent', { catalog: [subagentCatalogEntry('child')], ...over })
    const child = (running: boolean): SessionRow =>
      subagentRow('child', { parentId: 'parent' as SessionId, running })

    // T0: the parent is working on the turn that will dispatch the subagent.
    expect(fold(observer, [parent()], NONE, { parent: true }).newlyCompleted).toEqual([])

    // T1: that turn ended unread, and the delegated child is running. Nothing to
    // announce: the parent is waiting, not done.
    const dispatched = fold(observer, [parent({ completed: true }), child(true)], NONE, { parent: false })
    expect(dispatched.completed).toEqual([])
    expect(dispatched.newlyCompleted).toEqual([])

    // T2: the child stopped. That only hands the report back — the parent has not
    // been woken yet, so its unread flag is not a completion to announce.
    const stopped = fold(observer, [parent({ completed: true }), child(false)], NONE, { parent: false })
    expect(stopped.completed).toEqual([])
    expect(stopped.newlyCompleted).toEqual([])

    // T3: the parent was woken and is writing the answer. Starting a turn clears
    // the host's unread flag, so the wake-up is visible as a running parent only.
    const woken = fold(observer, [parent(), child(false)], NONE, { parent: true })
    expect(woken.completed).toEqual([])
    expect(woken.newlyCompleted).toEqual([])

    // T4: that turn ended — the parent has answered with the subagent's report in
    // hand, which is the completion the notification is about.
    const answered = fold(observer, [parent({ completed: true }), child(false)], NONE, { parent: false })
    expect(answered.completed.map(row => row.id)).toEqual(['parent'])
    expect(answered.newlyCompleted.map(row => row.id)).toEqual(['parent'])

    // T5: settling there is not a second completion.
    const settled = fold(observer, [parent({ completed: true }), child(false)], NONE, { parent: false })
    expect(settled.completed.map(row => row.id)).toEqual(['parent'])
    expect(settled.newlyCompleted).toEqual([])
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

    it('announces a parent whose subagent stopped before the wave was ever seen running', () => {
      const observer = new CompletionObserver()
      // The child is already stopped on the first observation that shows the
      // parent idle, so this fold has no running descendant to hold on and no
      // wake-up to wait for: the parent is treated as any other finished Session.
      fold(observer, [parent({ running: true })], NONE, { child: false })
      const observation = fold(observer, [parent({ completed: true })], NONE, { child: false })
      expect(observation.completed.map(row => row.id)).toEqual(['parent'])
      expect(observation.newlyCompleted.map(row => row.id)).toEqual(['parent'])
    })

    it('holds the announcement until the parent has run again after the subagent stops', () => {
      const observer = new CompletionObserver()
      fold(observer, [parent({ running: true })], NONE, { child: true })
      const held = fold(observer, [parent({ completed: true })], NONE, { child: true })
      expect(held.completed).toEqual([])
      expect(held.newlyCompleted).toEqual([])

      // The child stopping only hands its report back: the parent is still idle,
      // waiting to be woken, so there is nothing to announce yet.
      const stopped = fold(observer, [parent({ completed: true })], NONE, { child: false })
      expect(stopped.completed).toEqual([])
      expect(stopped.newlyCompleted).toEqual([])

      // Woken: the parent is running, which is the turn the child's report bought.
      const woken = fold(observer, [parent()], NONE, { parent: true })
      expect(woken.completed).toEqual([])
      expect(woken.newlyCompleted).toEqual([])

      const answered = fold(observer, [parent({ completed: true })], NONE, { parent: false })
      expect(answered.completed.map(row => row.id)).toEqual(['parent'])
      expect(answered.newlyCompleted.map(row => row.id)).toEqual(['parent'])

      const settled = fold(observer, [parent({ completed: true })], NONE, { parent: false })
      expect(settled.completed.map(row => row.id)).toEqual(['parent'])
      expect(settled.newlyCompleted).toEqual([])
    })

    it('waits for another parent turn when that turn delegates again', () => {
      const observer = new CompletionObserver()
      const child = (running: boolean): SessionRow =>
        subagentRow('child', { parentId: 'parent' as SessionId, running })

      // First wave: dispatched, settled, and answered by a parent turn.
      fold(observer, [parent(), child(true)], NONE, { parent: false })
      fold(observer, [parent({ completed: true }), child(false)], NONE, { parent: false })
      fold(observer, [parent(), child(false)], NONE, { parent: true })

      // That turn dispatches instead of answering, which re-opens the handover:
      // the wake-up just observed belongs to a turn that has not finished yet.
      const redelegated = fold(observer, [parent({ completed: true }), child(true)], NONE, { parent: false })
      expect(redelegated.completed).toEqual([])
      expect(redelegated.newlyCompleted).toEqual([])

      const settledAgain = fold(observer, [parent({ completed: true }), child(false)], NONE, { parent: false })
      expect(settledAgain.completed).toEqual([])
      expect(settledAgain.newlyCompleted).toEqual([])

      fold(observer, [parent(), child(false)], NONE, { parent: true })
      const answered = fold(observer, [parent({ completed: true }), child(false)], NONE, { parent: false })
      expect(answered.newlyCompleted.map(row => row.id)).toEqual(['parent'])
    })

    it('keeps holding a published parent, and forgets one that leaves the sources', () => {
      /**
       * A parent held waiting for its own turn: it dispatched the child, the
       * child stopped, and the parent has not been woken yet.
       */
      const waiting = (): CompletionObserver => {
        const observer = new CompletionObserver()
        fold(observer, [parent({ running: true })], NONE, { child: true })
        fold(observer, [parent({ completed: true })], NONE, { child: true })
        fold(observer, [parent({ completed: true })], NONE, { child: false })
        return observer
      }
      const stopped = (observer: CompletionObserver): string[] =>
        fold(observer, [parent({ completed: true })], NONE, { child: false }).newlyCompleted.map(row => row.id)

      // Control: the parent stays published, so the hold its wave put on it
      // still stands and the same unread state is not a second completion.
      expect(stopped(waiting())).toEqual([])

      // Filed away by the archive set: the Session leaves the published
      // sources, so nothing of its handover is kept. The next stop is a
      // completion of its own — announced once, not once per observation.
      const archived = waiting()
      fold(archived, [parent({ completed: true })], new Set(['parent' as SessionId]), { child: false })
      expect(stopped(archived)).toEqual(['parent'])
      expect(stopped(archived)).toEqual([])

      // Dropped from the list and the status together: the same forgetting.
      const dropped = waiting()
      fold(dropped, [], NONE, {})
      expect(stopped(dropped)).toEqual(['parent'])
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

      // Both branches settled, but the parent has not been woken yet.
      const allStopped = fold(observer, [both({ completed: true })], NONE, { one: false, two: false })
      expect(allStopped.completed).toEqual([])
      expect(allStopped.newlyCompleted).toEqual([])

      fold(observer, [both()], NONE, { parent: true })
      const answered = fold(observer, [both({ completed: true })], NONE, { parent: false })
      expect(answered.newlyCompleted.map(row => row.id)).toEqual(['parent'])
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

      // The grandchild stopping only hands the report chain back.
      const stopped = fold(observer, rows(false))
      expect(stopped.completed).toEqual([])
      expect(stopped.newlyCompleted).toEqual([])

      fold(observer, [parentRow(), childRow(), grandchildRow({ running: false })], NONE, { parent: true })
      const answered = fold(observer, rows(false))
      expect(answered.completed.map(row => row.id)).toEqual(['parent'])
      expect(answered.newlyCompleted.map(row => row.id)).toEqual(['parent'])

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
      expect(allStopped.completed).toEqual([])
      expect(allStopped.newlyCompleted).toEqual([])

      fold(observer, rows(false), NONE, { parent: true, 'one-a': false, 'two-a': false })
      const answered = fold(observer, rows(true), NONE, { 'one-a': false, 'two-a': false })
      expect(answered.completed.map(row => row.id)).toEqual(['parent'])
      expect(answered.newlyCompleted.map(row => row.id)).toEqual(['parent'])
    })
  })
})
