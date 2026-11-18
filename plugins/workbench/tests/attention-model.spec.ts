import { describe, expect, it } from 'vitest'
import type {
  SessionListState, SessionSummary,
} from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionStatusSnapshot } from '@deepseek-ai/dsh-client-ui-session/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { deriveAttention, type AttentionModel, type AttentionRow } from '../src/client/attention/model.ts'

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
 * is the fixture boundary: the fold reads ids and byId rows, so a partial row is
 * enough and no test asserts the rest.
 */
function listOf(rows: readonly RowSpec[]): SessionListState {
  const byId: Record<string, SessionSummary> = {}
  for (const row of rows) {
    byId[row.id] = {
      id: row.id,
      title: row.title ?? '',
      displayTitle: row.title ?? row.id,
      updatedAt: row.updatedAt,
      running: row.running === true,
      blank: row.blank === true,
      origin: row.origin ?? 'user',
      ...(row.parentId === undefined ? {} : { parentId: row.parentId }),
    } as never
  }
  return {
    ids: rows.map(row => row.id),
    byId,
    projectionsBySession: {},
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

/** The row facts the fold owns: which Session, under which title, pinned or not. */
const titled = (rows: readonly AttentionRow[]): { id: string; title: string; pinned: boolean }[] =>
  rows.map(row => ({ id: row.id, title: row.title, pinned: row.pinned }))

const NONE: ReadonlySet<SessionId> = new Set()

const pins = (...values: readonly string[]): ReadonlySet<SessionId> =>
  new Set<SessionId>(values.map(value => value as SessionId))

/**
 * Every id the model lists, flattened and sorted: a Session takes exactly one
 * group, and one group holds each Session once.
 */
const listed = (model: AttentionModel): string[] =>
  [...ids(model.unread), ...ids(model.pinned), ...ids(model.running)].sort()

describe('In work model', () => {
  it('is empty when nothing is running, unread or pinned', () => {
    const model = deriveAttention(listOf([]), statusOf({}), NONE, NONE)
    expect(model).toEqual({ running: [], unread: [], pinned: [], waiting: [] })
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
    expect(model.pinned).toEqual([])
  })

  it('lists a finished-unread Session under unread with a done row', () => {
    const model = deriveAttention(
      listOf([{ id: 'a', title: 'Alpha', updatedAt: 5 }]),
      statusOf({ a: { unread: true } }),
      NONE,
      NONE,
    )
    expect(model.running).toEqual([])
    expect(titled(model.unread)).toEqual([{ id: 'a', title: 'Alpha', pinned: false }])
    expect(model.pinned).toEqual([])
  })

  it('lists a pinned idle Session in the pinned group alone', () => {
    const model = deriveAttention(
      listOf([{ id: 'a', title: 'Alpha', updatedAt: 5 }]),
      statusOf({ a: {} }),
      NONE,
      pins('a'),
    )
    expect(model.running).toEqual([])
    expect(model.unread).toEqual([])
    expect(model.pinned).toHaveLength(1)
    expect(model.pinned[0]).toMatchObject({ id: 'a', title: 'Alpha', pinned: true })
  })

  it('lists a pinned unread Session under unread, not under the pin', () => {
    const model = deriveAttention(
      listOf([{ id: 'a', title: 'Alpha', updatedAt: 5 }]),
      statusOf({ a: { unread: true } }),
      NONE,
      pins('a'),
    )
    expect(titled(model.unread)).toEqual([{ id: 'a', title: 'Alpha', pinned: true }])
    expect(model.pinned).toEqual([])
    expect(model.running).toEqual([])
  })

  it('lists a pinned running Session under running, not under the pin', () => {
    const model = deriveAttention(
      listOf([{ id: 'a', title: 'Alpha', updatedAt: 5, running: true }]),
      statusOf({ a: { running: true, unread: true } }),
      NONE,
      pins('a'),
    )
    expect(titled(model.running)).toEqual([{ id: 'a', title: 'Alpha', pinned: true }])
    expect(model.unread).toEqual([])
    expect(model.pinned).toEqual([])
  })

  it('places every Session by its state, and a pin at rest by the pin', () => {
    const model = deriveAttention(
      listOf([
        { id: 'pin', updatedAt: 1 },
        { id: 'run', updatedAt: 9, running: true },
        { id: 'done', updatedAt: 5 },
      ]),
      statusOf({ pin: { unread: true }, run: { running: true }, done: { unread: true } }),
      NONE,
      pins('pin'),
    )
    // A pinned Session still reports its own work, and the pin leads the group it
    // lands in even when a newer unpinned row shares it.
    expect(ids(model.unread)).toEqual(['pin', 'done'])
    expect(ids(model.pinned)).toEqual([])
    expect(ids(model.running)).toEqual(['run'])
    // One Session, one group: its state and its pin together decide which.
    expect(listed(model)).toEqual(['done', 'pin', 'run'])
    expect(model.waiting).toEqual([])
  })

  it('leads each state group with its pinned rows, newest first on both sides', () => {
    const model = deriveAttention(
      listOf([
        { id: 'run-new', updatedAt: 9, running: true },
        { id: 'run-pin-old', updatedAt: 1, running: true },
        { id: 'done-new', updatedAt: 8 },
        { id: 'done-pin-old', updatedAt: 2 },
      ]),
      statusOf({
        'run-new': { running: true },
        'run-pin-old': { running: true },
        'done-new': { unread: true },
        'done-pin-old': { unread: true },
      }),
      NONE,
      pins('run-pin-old', 'done-pin-old'),
    )
    expect(ids(model.running)).toEqual(['run-pin-old', 'run-new'])
    expect(ids(model.unread)).toEqual(['done-pin-old', 'done-new'])
    expect(model.pinned).toEqual([])
  })

  it('files a pinned Session by its live state, then under the pin once both clear', () => {
    const rows = listOf([{ id: 'a', updatedAt: 5, running: true }])
    expect(ids(deriveAttention(rows, statusOf({ a: { running: true, unread: true } }), NONE, pins('a')).running))
      .toEqual(['a'])
    expect(ids(deriveAttention(rows, statusOf({ a: { unread: true } }), NONE, pins('a')).unread))
      .toEqual(['a'])
    expect(ids(deriveAttention(rows, statusOf({ a: {} }), NONE, pins('a')).pinned))
      .toEqual(['a'])
  })

  it('orders the pinned group newest first', () => {
    const model = deriveAttention(
      listOf([
        { id: 'older', updatedAt: 1 },
        { id: 'newer', updatedAt: 9 },
      ]),
      statusOf({}),
      NONE,
      pins('older', 'newer'),
    )
    expect(ids(model.pinned)).toEqual(['newer', 'older'])
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

  it('keeps Host list order for equal timestamps inside the pinned group', () => {
    const model = deriveAttention(
      listOf([
        { id: 'first', updatedAt: 5 },
        { id: 'second', updatedAt: 5 },
      ]),
      statusOf({}),
      NONE,
      pins('first', 'second'),
    )
    expect(ids(model.pinned)).toEqual(['first', 'second'])
  })

  it('lists every entry across the three groups without a display cap', () => {
    const rows: RowSpec[] = []
    const status: Record<string, { unread?: boolean }> = {}
    const pinned: string[] = []
    for (let index = 0; index < 12; index++) {
      const id = 'run' + String(index)
      rows.push({ id, updatedAt: 100 - index, running: true })
    }
    for (let index = 0; index < 5; index++) {
      const id = 'done' + String(index)
      rows.push({ id, updatedAt: 50 - index })
      status[id] = { unread: true }
    }
    for (let index = 0; index < 4; index++) {
      const id = 'pin' + String(index)
      rows.push({ id, updatedAt: 30 - index })
      pinned.push(id)
    }
    const model = deriveAttention(listOf(rows), statusOf(status), NONE, pins(...pinned))
    expect(model.running).toHaveLength(12)
    expect(model.unread).toHaveLength(5)
    expect(model.pinned).toHaveLength(4)
  })

  it('reports a blocked turn from every group once, without duplicating it', () => {
    const model = deriveAttention(
      listOf([
        { id: 'run', updatedAt: 3, running: true },
        { id: 'pin', updatedAt: 2 },
        { id: 'done', updatedAt: 1 },
      ]),
      statusOf({ run: { running: true, blocked: true }, pin: { blocked: true }, done: { unread: true, blocked: true } }),
      NONE,
      pins('pin'),
    )
    expect(ids(model.unread)).toEqual(['done'])
    expect(ids(model.pinned)).toEqual(['pin'])
    expect(ids(model.running)).toEqual(['run'])
    // 'waiting' is a notification set, not a fourth display group: only its
    // membership and one-entry-per-Session facts are contract.
    expect([...ids(model.waiting)].sort()).toEqual(['done', 'pin', 'run'])
    expect(new Set(ids(model.waiting)).size).toBe(model.waiting.length)
  })

  it('never lists a subagent Session in any group, pinned or not', () => {
    const model = deriveAttention(
      listOf([
        { id: 'lead', updatedAt: 2 },
        { id: 'run-child', updatedAt: 9, running: true, origin: 'subagent', parentId: 'lead' },
        { id: 'done-child', updatedAt: 8, origin: 'subagent', parentId: 'lead' },
        { id: 'pinned-child', updatedAt: 7, origin: 'subagent', parentId: 'lead' },
      ]),
      statusOf({ 'run-child': { running: true }, 'done-child': { unread: true } }),
      NONE,
      pins('pinned-child'),
    )
    // The Session that delegated the work is the only row, and it lists once.
    expect(ids(model.running)).toEqual(['lead'])
    expect(model.unread).toEqual([])
    expect(model.pinned).toEqual([])
    expect(model.waiting).toEqual([])
  })

  it('drops the blank placeholder and archived Sessions, pinned ones included', () => {
    const model = deriveAttention(
      listOf([
        { id: 'blank', updatedAt: 8, blank: true, running: true },
        { id: 'archived', updatedAt: 7, running: true },
        { id: 'pin-blank', updatedAt: 6, blank: true },
        { id: 'pin-archived', updatedAt: 5 },
      ]),
      statusOf({ blank: { running: true }, archived: { running: true } }),
      pins('archived', 'pin-archived'),
      pins('pin-blank', 'pin-archived'),
    )
    expect(model.running).toEqual([])
    expect(model.unread).toEqual([])
    expect(model.pinned).toEqual([])
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

  it('lists an idle lead over running subagent work once, without the child rows', () => {
    const model = deriveAttention(
      listOf([
        { id: 'lead', title: 'Lead', updatedAt: 6 },
        { id: 'first', updatedAt: 5, running: true, origin: 'subagent', parentId: 'lead' },
        { id: 'second', updatedAt: 4, running: true, origin: 'subagent', parentId: 'lead' },
      ]),
      statusOf({ first: { running: true }, second: { running: true } }),
      NONE,
      NONE,
    )
    expect(titled(model.running)).toEqual([{ id: 'lead', title: 'Lead', pinned: false }])
    expect(model.unread).toEqual([])
  })

  it('lists a pinned idle lead over running subagent work under running, without the child rows', () => {
    const model = deriveAttention(
      listOf([
        { id: 'lead', title: 'Lead', updatedAt: 6 },
        { id: 'first', updatedAt: 5, running: true, origin: 'subagent', parentId: 'lead' },
        { id: 'second', updatedAt: 4, running: true, origin: 'subagent', parentId: 'lead' },
      ]),
      statusOf({ first: { running: true }, second: { running: true } }),
      NONE,
      pins('lead'),
    )
    // Running subagent work below the lead is live work: the pin does not file it away.
    expect(titled(model.running)).toEqual([{ id: 'lead', title: 'Lead', pinned: true }])
    expect(model.pinned).toEqual([])
    expect(model.unread).toEqual([])
  })

  it('holds a delegation chain thousands of hops deep without a row per hop', () => {
    // Legal input: a subagent may delegate to another subagent. The walk that
    // finds running descendants uses an explicit stack, so the depth is bounded by
    // memory, not by the JavaScript call stack (~3000 frames on the default heap).
    const depth = 3200
    const rows: RowSpec[] = [{ id: 'root', title: 'Root', updatedAt: depth }]
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
    // The lead at rest carries the whole chain: one row, no descendants below it.
    expect(titled(model.running)).toEqual([{ id: 'root', title: 'Root', pinned: false }])
    expect(model.unread).toEqual([])
  })

  it('lists an untitled Session with an empty title', () => {
    const model = deriveAttention(
      listOf([{ id: 'draft', title: '', updatedAt: 5 }]),
      statusOf({ draft: { unread: true } }),
      NONE,
      NONE,
    )
    // The row carries the persistent title; the region decides what to draw for an
    // empty one, so the fold reports it as-is.
    expect(titled(model.unread)).toEqual([{ id: 'draft', title: '', pinned: false }])
  })

  it('lists the lead alone when only a subagent hop below a hop runs', () => {
    const model = deriveAttention(
      listOf([
        { id: 'root', title: 'Root', updatedAt: 4 },
        { id: 'idle', updatedAt: 3, origin: 'subagent', parentId: 'root' },
        { id: 'run', updatedAt: 2, running: true, origin: 'subagent', parentId: 'idle' },
      ]),
      statusOf({ run: { running: true } }),
      NONE,
      NONE,
    )
    expect(titled(model.running)).toEqual([{ id: 'root', title: 'Root', pinned: false }])
    expect(model.unread).toEqual([])
  })
})
