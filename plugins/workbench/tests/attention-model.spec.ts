import { describe, expect, it } from 'vitest'
import type {
  SessionListState, SessionSummary,
} from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionStatusSnapshot } from '@deepseek-ai/dsh-client-ui-session/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { deriveAttention, type AttentionRow } from '../src/client/attention/model.ts'

/** One host row as the fold reads it. Everything else the real type carries is unused here. */
interface RowSpec {
  readonly id: string
  readonly title?: string
  readonly updatedAt: number
  readonly running?: boolean
  readonly blank?: boolean
  readonly origin?: 'user' | 'subagent'
  readonly parentId?: string
}

/**
 * A list snapshot over the given rows, in the order the host lists them. The cast
 * is the fixture boundary: the fold reads ids, byId rows and the two projection
 * maps, so a partial row is enough and no test asserts the rest.
 */
function listOf(rows: readonly RowSpec[], catalog?: Record<string, readonly string[]>): SessionListState {
  const byId: Record<string, SessionSummary> = {}
  const projectionsBySession: Record<string, unknown> = {}
  for (const row of rows) {
    byId[row.id] = {
      id: row.id,
      displayTitle: row.title ?? row.id,
      updatedAt: row.updatedAt,
      running: row.running === true,
      blank: row.blank === true,
      origin: row.origin ?? 'user',
      ...(row.parentId === undefined ? {} : { parentId: row.parentId }),
    } as never
  }
  for (const [parent, children] of Object.entries(catalog ?? {})) {
    projectionsBySession[parent] = { values: { subagentCatalog: children.map(id => ({ id })) } }
  }
  return {
    ids: rows.map(row => row.id),
    byId,
    projectionsBySession,
  } as never
}

/** The per-Session status map the fold reads. */
function statusOf(entries: Record<string, { running?: boolean; unread?: boolean; blocked?: boolean }>): SessionStatusSnapshot {
  return new Map(Object.entries(entries).map(([id, entry]) => [id, {
    running: entry.running === true,
    completionUnread: entry.unread === true,
    ...(entry.blocked === true ? { pendingInteraction: { kind: 'approval' } } : {}),
  }])) as never
}

const ids = (rows: readonly AttentionRow[]): string[] => rows.map(row => row.id)

const NONE: ReadonlySet<SessionId> = new Set()

describe('In work model', () => {
  it('is empty when nothing is running, unread or pinned', () => {
    const model = deriveAttention(listOf([]), statusOf({}), NONE, NONE)
    expect(model).toEqual({ running: [], unread: [], waiting: [] })
  })

  it('lists running Sessions newest first', () => {
    const model = deriveAttention(
      listOf([
        { id: 'a', title: 'Alpha', updatedAt: 10, running: true },
        { id: 'b', title: 'Beta', updatedAt: 20, running: true },
      ]),
      statusOf({ a: { running: true }, b: { running: true } }),
      NONE,
      NONE,
    )
    expect(ids(model.running)).toEqual(['b', 'a'])
    expect(model.unread).toEqual([])
  })

  it('lists a finished-unread Session under unread with a done row', () => {
    const model = deriveAttention(
      listOf([{ id: 'a', title: 'Alpha', updatedAt: 5 }]),
      statusOf({ a: { unread: true } }),
      NONE,
      NONE,
    )
    expect(model.running).toEqual([])
    expect(model.unread).toEqual([{ id: 'a', title: 'Alpha' }])
  })

  it('puts a pinned idle Session under unread even without a completion flag', () => {
    const model = deriveAttention(
      listOf([{ id: 'a', title: 'Alpha', updatedAt: 5 }]),
      statusOf({ a: {} }),
      NONE,
      new Set<SessionId>(['a' as SessionId]),
    )
    expect(model.running).toEqual([])
    expect(model.unread).toEqual([{ id: 'a', title: 'Alpha', container: true, pinned: true }])
  })

  it('lists a pinned unread Session once under unread and keeps its pin', () => {
    const model = deriveAttention(
      listOf([
        { id: 'pinned', updatedAt: 1 },
        { id: 'newer', updatedAt: 9 },
      ]),
      statusOf({ pinned: { unread: true }, newer: { unread: true } }),
      NONE,
      new Set<SessionId>(['pinned' as SessionId]),
    )
    expect(ids(model.unread)).toEqual(['pinned', 'newer'])
    expect(model.unread[0]).toMatchObject({ id: 'pinned', pinned: true })
    expect(model.running).toEqual([])
  })

  it('keeps a pinned running Session only under running, even when it is also unread', () => {
    const model = deriveAttention(
      listOf([{ id: 'both', updatedAt: 1, running: true }]),
      statusOf({ both: { running: true, unread: true } }),
      NONE,
      new Set<SessionId>(['both' as SessionId]),
    )
    expect(model.running).toEqual([{ id: 'both', title: 'both', pinned: true }])
    expect(model.unread).toEqual([])
  })

  it('puts the pinned priority inside unread before newer unpinned rows', () => {
    const model = deriveAttention(
      listOf([
        { id: 'newer', updatedAt: 99 },
        { id: 'pin-older', updatedAt: 1 },
        { id: 'pin-newer', updatedAt: 2 },
      ]),
      statusOf({ newer: { unread: true }, 'pin-older': { unread: true }, 'pin-newer': { unread: true } }),
      NONE,
      new Set<SessionId>(['pin-older' as SessionId, 'pin-newer' as SessionId]),
    )
    expect(ids(model.unread)).toEqual(['pin-newer', 'pin-older', 'newer'])
  })

  it('keeps running order by recency without fronting a pinned running Session', () => {
    const model = deriveAttention(
      listOf([
        { id: 'pin-older', updatedAt: 1, running: true },
        { id: 'newer', updatedAt: 9, running: true },
      ]),
      statusOf({ 'pin-older': { running: true }, newer: { running: true } }),
      NONE,
      new Set<SessionId>(['pin-older' as SessionId]),
    )
    expect(ids(model.running)).toEqual(['newer', 'pin-older'])
    expect(model.running[1]).toMatchObject({ id: 'pin-older', pinned: true })
    expect(model.unread).toEqual([])
  })

  it('keeps Host list order for equal timestamps inside one group', () => {
    const model = deriveAttention(
      listOf([
        { id: 'first', updatedAt: 5 },
        { id: 'second', updatedAt: 5 },
      ]),
      statusOf({ first: { unread: true }, second: { unread: true } }),
      NONE,
      NONE,
    )
    expect(ids(model.unread)).toEqual(['first', 'second'])
  })

  it('lists every entry across both groups without a display cap', () => {
    const rows: RowSpec[] = []
    const status: Record<string, { unread?: boolean }> = {}
    for (let index = 0; index < 12; index++) {
      const id = 'run' + String(index)
      rows.push({ id, updatedAt: 100 - index, running: true })
    }
    for (let index = 0; index < 5; index++) {
      const id = 'done' + String(index)
      rows.push({ id, updatedAt: 50 - index })
      status[id] = { unread: true }
    }
    const model = deriveAttention(listOf(rows), statusOf(status), NONE, NONE)
    expect(model.running).toHaveLength(12)
    expect(model.unread).toHaveLength(5)
  })

  it('reports a blocked turn in the display order of the two groups', () => {
    const model = deriveAttention(
      listOf([
        { id: 'run', updatedAt: 2, running: true },
        { id: 'done', updatedAt: 1 },
      ]),
      statusOf({ run: { running: true, blocked: true }, done: { unread: true, blocked: true } }),
      NONE,
      NONE,
    )
    expect(ids(model.running)).toEqual(['run'])
    expect(ids(model.unread)).toEqual(['done'])
    expect(ids(model.waiting)).toEqual(['run', 'done'])
  })

  it('drops subagent rows, the blank placeholder and archived Sessions', () => {
    const model = deriveAttention(
      listOf([
        { id: 'child', updatedAt: 9, running: true, origin: 'subagent', parentId: 'parent' },
        { id: 'blank', updatedAt: 8, blank: true, running: true },
        { id: 'archived', updatedAt: 7, running: true },
      ]),
      statusOf({ child: { running: true }, blank: { running: true }, archived: { running: true } }),
      new Set<SessionId>(['archived' as SessionId]),
      NONE,
    )
    expect(model.running).toEqual([])
    expect(model.unread).toEqual([])
  })

  it('drops a running child whose parent is archived', () => {
    const model = deriveAttention(
      listOf([
        { id: 'parent', updatedAt: 4 },
        { id: 'child', updatedAt: 3, running: true, origin: 'subagent', parentId: 'parent' },
      ]),
      statusOf({ parent: {}, child: { running: true } }),
      new Set<SessionId>(['parent' as SessionId]),
      NONE,
    )
    expect(model.running).toEqual([])
    expect(model.unread).toEqual([])
  })

  it('nests running subagent work under an idle parent, in catalog order', () => {
    const model = deriveAttention(
      listOf([
        { id: 'parent', updatedAt: 6 },
        { id: 'first', updatedAt: 5, running: true, origin: 'subagent', parentId: 'parent' },
        { id: 'second', updatedAt: 4, running: true, origin: 'subagent', parentId: 'parent' },
      ], { parent: ['first', 'second'] }),
      statusOf({ first: { running: true }, second: { running: true } }),
      NONE,
      NONE,
    )
    expect(model.running).toHaveLength(1)
    const [parent] = model.running
    expect(parent).toMatchObject({ id: 'parent', container: true })
    expect(ids(parent?.children ?? [])).toEqual(['first', 'second'])
    expect(model.unread).toEqual([])
  })

  it('nests a delegation chain thousands of hops deep without using the call stack', () => {
    // Legal input: a subagent may delegate to another subagent. The fold walks
    // lineage with an explicit stack, so the depth is bounded by memory, not by
    // the JavaScript call stack (~3000 frames on the default V8 heap).
    const depth = 3200
    const rows: RowSpec[] = [{ id: 'root', updatedAt: depth }]
    const statuses: Record<string, { running?: boolean }> = {}
    for (let hop = 1; hop <= depth; hop++) {
      rows.push({
        id: 'n' + String(hop),
        updatedAt: depth - hop,
        running: true,
        origin: 'subagent',
        parentId: hop === 1 ? 'root' : 'n' + String(hop - 1),
      })
      statuses['n' + String(hop)] = { running: true }
    }
    const model = deriveAttention(listOf(rows), statusOf(statuses), NONE, NONE)
    expect(model.running).toHaveLength(1)
    const root = model.running[0]
    // The listed Session does not run itself, so it stands for its descendants.
    expect(root).toMatchObject({ id: 'root', container: true })
    // Asserting the shape with a loop for the same reason the fold uses one.
    let node = root
    let hops = 0
    while (node?.children !== undefined) {
      node = node.children[0]
      hops += 1
    }
    expect(hops).toBe(depth)
    expect(node?.id).toBe('n' + String(depth))
    // Only the idle root is a container; a running descendant keeps its own id.
    expect(root?.children?.[0]?.container).toBeUndefined()
    expect(node?.container).toBeUndefined()
  })

  it('turns an idle hop over running work below it into a container', () => {
    const model = deriveAttention(
      listOf([
        { id: 'root', updatedAt: 4 },
        { id: 'idle', updatedAt: 3, origin: 'subagent', parentId: 'root' },
        { id: 'run', updatedAt: 2, running: true, origin: 'subagent', parentId: 'idle' },
      ]),
      statusOf({ run: { running: true } }),
      NONE,
      NONE,
    )
    const root = model.running[0]
    const idle = root?.children?.[0]
    expect(root).toMatchObject({ id: 'root', container: true })
    expect(idle).toMatchObject({ id: 'idle', container: true })
    expect(idle?.children?.[0]).toMatchObject({ id: 'run' })
    expect(idle?.children?.[0]?.container).toBeUndefined()
  })
})
