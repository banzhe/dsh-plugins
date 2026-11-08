/**
 * The settings page's data rules, as pure functions.
 *
 * Each derivative track has its own stored list and its own derived ids:
 * `sources` is the `(devContainer)` track and `sbxSources` the `(sbx)` track, so a
 * row's "derived" answer is always relative to the track that asked.
 *
 * The page lists the presets a person can derive from, which is the roster
 * MINUS every variant this Bundle already registered: offering
 * `standard-devcontainer` as a source would derive `standard-devcontainer-devcontainer`.
 */
import type { AgentPresetRow, AgentPresetRoster } from '@deepseek-ai/dsh-agent-preset-registry/types'
import { isAnyVariantId, variantIdOf, type VariantKind } from '../ids.ts'

/**
 * The two stored source lists, one per derivative track.
 *
 * These are field names of the `devcontainer` settings namespace, and the Host
 * row reads exactly the same pair.
 */
export const SOURCE_FIELDS = {
  devcontainer: 'sources',
  sbx: 'sbxSources',
} as const satisfies Record<VariantKind, string>

/** One selectable source row. */
export interface SelectablePreset {
  /** Stable preset id: what the checkbox writes. */
  readonly id: string
  /** The preset's published name, or the id when it published none. */
  readonly name: string
  /** The preset's own one-line description, when it published one. */
  readonly description: string
  /** Whether THIS track's variant is registered right now. */
  readonly derived: boolean
  /**
   * The registry's diagnostic for this track's variant, when it registered but
   * could not mount. A variant the picker hides must never read as "available".
   */
  readonly variantBroken?: string
  /** Whether this track's stored list asks for its variant. */
  readonly checked: boolean
  /** The registry's activation diagnostic, when this preset could not be mounted. */
  readonly broken?: string
}

/**
 * The stored ids of one track.
 * @param section - the namespace value as the Host published it, possibly before the first read.
 * @param field - the settings field holding that track's list.
 * @returns every non-empty string id it lists, in written order.
 */
function idsOf(section: unknown, field: string): string[] {
  if (typeof section !== 'object' || section === null) return []
  const raw: unknown = Reflect.get(section, field)
  if (!Array.isArray(raw)) return []
  return raw.filter((id): id is string => typeof id === 'string' && id.length > 0)
}

/**
 * The stored `(devContainer)` source list of one form value.
 * @param section - the namespace value as the Host published it, possibly before the first read.
 * @returns every non-empty string id it lists, in written order.
 */
export function sourcesOf(section: unknown): string[] {
  return idsOf(section, SOURCE_FIELDS.devcontainer)
}

/**
 * The stored `(sbx)` source list of one form value.
 * @param section - the namespace value as the Host published it, possibly before the first read.
 * @returns every non-empty string id it lists, in written order.
 */
export function sbxSourcesOf(section: unknown): string[] {
  return idsOf(section, SOURCE_FIELDS.sbx)
}

/**
 * The variant ids the roster currently carries.
 * @param roster - the roster the Host answered with.
 * @returns the derived preset ids it contains.
 */
function rowsOf(roster: unknown): readonly AgentPresetRow[] {
  if (roster === null || typeof roster !== 'object') return []
  const presets: unknown = (roster as { presets?: unknown }).presets
  return Array.isArray(presets) ? presets as readonly AgentPresetRow[] : []
}

/**
 * The rows one track offers.
 *
 * Source presets keep the Host's roster order; a variant of either track never
 * appears as a source. `checked` follows the STORED list rather than the roster,
 * because a registration that failed still needs a row a person can uncheck.
 * @param roster - the full roster from the Host.
 * @param sources - the stored list of source ids on this track.
 * @param kind - the derivative track whose variants the rows report.
 * @returns one row per selectable preset.
 */
export function selectablePresets(
  roster: AgentPresetRoster,
  sources: readonly string[],
  kind: VariantKind = 'devcontainer',
): SelectablePreset[] {
  const wanted = new Set(sources)
  const rows = rowsOf(roster)
  const byId = new Map(rows.map(preset => [preset.id, preset]))
  return rows
    .filter(preset => !isAnyVariantId(preset.id))
    .map((preset) => {
      const variant = byId.get(variantIdOf(preset.id, kind))
      return {
        id: preset.id,
        name: preset.name ?? preset.id,
        description: preset.description ?? '',
        derived: variant !== undefined,
        checked: wanted.has(preset.id),
        ...preset.broken === undefined ? {} : { broken: preset.broken },
        ...variant?.broken === undefined ? {} : { variantBroken: variant.broken },
      }
    })
}

/**
 * Whether one row may be checked: a preset the registry could not mount derives
 * a variant that cannot mount either, so offering it would only strand the page.
 * @param row - the row to test.
 * @returns false when the row is broken and not already stored.
 */
export function selectable(row: SelectablePreset): boolean {
  return row.broken === undefined || row.checked
}

/**
 * The stored list one checkbox produces.
 * @param sources - the ids currently stored, in written order.
 * @param id - the preset the row owns.
 * @param checked - whether that preset's variant is now wanted.
 * @returns the next stored order: existing ids keep their place, an added id goes last.
 */
export function nextSources(sources: readonly string[], id: string, checked: boolean): string[] {
  if (!checked) return sources.filter(held => held !== id)
  return sources.includes(id) ? [...sources] : [...sources, id]
}
