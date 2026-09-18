// @vitest-environment jsdom
/**
 * The archive gate: which listed Sessions the A gesture may archive.
 *
 * The row already yields an exact id, so this module is a membership check
 * against the authoritative list — it is the only place that knows whether a
 * Session is subagent-origin, since a row node carries no `origin`.
 */
import { describe, expect, it } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import { isArchivableSession } from '../src/client/match.ts'
import { sessionListOf, sessionSummary } from './session-list-double.ts'

describe('isArchivableSession', () => {
  it('admits an ordinary listed Session', () => {
    const list = sessionListOf([sessionSummary({ id: 'session-1' })])
    expect(isArchivableSession(SessionId('session-1'), list, [])).toBe(true)
  })

  it('rejects an id that is not in the list', () => {
    const list = sessionListOf([sessionSummary({ id: 'session-1' })])
    expect(isArchivableSession(SessionId('session-other'), list, [])).toBe(false)
  })

  it('rejects the blank provisional Session', () => {
    const list = sessionListOf([sessionSummary({ id: 'session-blank', blank: true })])
    expect(isArchivableSession(SessionId('session-blank'), list, [])).toBe(false)
  })

  it('rejects a subagent-origin Session', () => {
    const list = sessionListOf([sessionSummary({ id: 'session-child', origin: 'subagent' })])
    expect(isArchivableSession(SessionId('session-child'), list, [])).toBe(false)
  })

  it('rejects an already-archived Session', () => {
    const list = sessionListOf([sessionSummary({ id: 'session-1' })])
    expect(isArchivableSession(SessionId('session-1'), list, [SessionId('session-1')])).toBe(false)
  })

  it('admits the exact Session even when another shares its display title', () => {
    // The whole point of the fiber id: duplicate titles no longer skip.
    const list = sessionListOf([sessionSummary({ id: 'session-a' }), sessionSummary({ id: 'session-b' })])
    expect(isArchivableSession(SessionId('session-b'), list, [])).toBe(true)
  })
})
