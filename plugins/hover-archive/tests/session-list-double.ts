/**
 * Test double for the Session list and Workspace archive surface.
 *
 * Both specs drive the same gate over the same shape: a `SessionSummary` with
 * the fields the plugin reads, and a `SessionListState` snapshot built from
 * them. Keeping one builder here (the repo's `tests/*-double.ts` convention)
 * means a change to the list contract is reflected in one place, and the specs
 * state only the fact each one is actually about.
 *
 * Production code never imports this: `src/` reads both services through the
 * published client types, which are type-only imports.
 */
import type { SessionListState, SessionSummary } from '@deepseek-ai/dsh-api-session-controller/client'
import { SessionId } from '@deepseek-ai/dsh-session/types'

/**
 * One listed Session, with only the fields this plugin's gate reads.
 * @param options - the session id and the two facts the gate filters on.
 * @returns a `SessionSummary`-shaped record.
 */
export function sessionSummary(options: {
  id: string
  blank?: boolean
  origin?: 'subagent'
}): SessionSummary {
  return {
    id: SessionId(options.id),
    displayTitle: options.id,
    running: false,
    blank: options.blank ?? false,
    updatedAt: 1,
    ...(options.origin === undefined ? {} : { origin: options.origin }),
  } as SessionSummary
}

/**
 * A list snapshot over the given Sessions.
 * @param sessions - the Sessions the snapshot contains.
 * @returns a `SessionListState` with the ids in the supplied order.
 */
export function sessionListOf(sessions: readonly SessionSummary[]): SessionListState {
  const byId: Record<string, SessionSummary> = {}
  for (const session of sessions) byId[session.id] = session
  return {
    ids: sessions.map(session => session.id),
    byId: byId as SessionListState['byId'],
    phase: 'ready',
    projectionsBySession: {},
  }
}
