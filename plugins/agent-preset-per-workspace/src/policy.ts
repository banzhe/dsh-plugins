/**
 * The decisions this plugin makes, as pure functions.
 *
 * @module @banzhe/dsh-agent-preset-per-workspace/policy
 */

import type { SessionStartSource } from '@deepseek-ai/dsh-agent'
import type { SessionHeader } from '@deepseek-ai/dsh-session'
import type { PresetBinding } from './domain.ts'

/** Taken from the official header, so a renamed field is a compile error rather than a silent "top-level". */
export type SessionScope = Pick<SessionHeader, 'origin' | 'parentSession'>

/**
 * `agent/created` fires for subagents and forks too, and both must keep the
 * composition their parent handed them. `source` cannot stand in for this:
 * subagents arrive as `'startup'` as well.
 */
export function isTopLevelSession(header: SessionScope): boolean {
  return header.origin !== 'subagent' && header.parentSession === undefined
}

/**
 * Only a fresh creation is uncomposed. Resumes, clears and compactions carry a
 * composition that already exists, and `select` is refused after the first turn.
 */
export function shouldApplyOn(source: SessionStartSource): boolean {
  return source === 'startup'
}

/** The predicate return type is what lets the applier pass `remembered` straight to `select`. */
export function needsSelect(
  remembered: string | undefined,
  composed: string | undefined,
): remembered is string {
  return remembered !== undefined && remembered !== composed
}

/** The domain's `put` always writes, so a repeat of the remembered preset is skipped here. */
export function needsWrite(current: PresetBinding | undefined, next: string): boolean {
  return current?.agentPreset !== next
}
