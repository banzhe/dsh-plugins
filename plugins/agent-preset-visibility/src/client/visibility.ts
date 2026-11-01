/**
 * The hidden list and the roster it filters, as pure functions.
 *
 * "Hidden" is a list filter, never a registration change: a preset in this set
 * still registers with the Host, still composes a session, and still binds a
 * Home patch's `agentPreset:` reference — it only stops appearing in the web
 * roster that the picker, the session header and the Settings roster read.
 */
import type { AgentPresetRoster } from '@deepseek-ai/dsh-agent-preset-registry/types'

/**
 * The preset ids one settings section holds back.
 * @param section - the form value as the Host published it, possibly before the first read.
 * @returns every non-empty string id the section lists; empty when it lists none.
 */
export function hiddenIds(section: unknown): ReadonlySet<string> {
  if (typeof section !== 'object' || section === null) return new Set()
  const raw: unknown = Reflect.get(section, 'hidden')
  if (!Array.isArray(raw)) return new Set()
  const ids = new Set<string>()
  for (const id of raw) {
    if (typeof id === 'string' && id.length > 0) ids.add(id)
  }
  return ids
}

/**
 * The roster as a picker sees it.
 *
 * The answer keeps the Host's identity when nothing is filtered: a store or a
 * memo comparing snapshots then sees the same object it read before, instead of
 * an equal copy that re-renders every roster surface on each call.
 * @param roster - the roster the Host answered with.
 * @param hidden - preset ids to leave out.
 * @returns the roster without the hidden rows.
 */
export function visibleRoster(roster: AgentPresetRoster, hidden: ReadonlySet<string>): AgentPresetRoster {
  if (hidden.size === 0) return roster
  const presets = roster.presets.filter(preset => !hidden.has(preset.id))
  return presets.length === roster.presets.length ? roster : { ...roster, presets }
}

/**
 * The hidden list one row toggle produces.
 * @param hidden - the ids currently hidden, in written order.
 * @param id - the preset the row owns.
 * @param hide - whether that preset becomes hidden.
 * @returns the next written order: existing ids keep their place, an added id goes last.
 */
export function nextHidden(hidden: readonly string[], id: string, hide: boolean): string[] {
  const rest = hidden.filter(held => held !== id)
  return hide ? [...rest, id] : rest
}
