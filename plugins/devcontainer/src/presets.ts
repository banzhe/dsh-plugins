/**
 * Preset-variant transforms.
 *
 * A preset is a declarative plugin list, and the shipped presets pick their
 * shell tool with `disabled: !!js process.platform === 'win32'`: on Windows every
 * agent gets `pwsh` and no `bash`. Inside a Linux container that is backwards,
 * but a preset is config DATA, not a Loader row — a patch entry cannot reach
 * into `config.plugins`, and the registry has no mutation API. So this Bundle
 * reads a preset's declaration out of the Loader tree and registers a derived
 * one: same roster, shell tools flipped, subagent routes pointing at the derived
 * subagent presets.
 *
 * Every function here is pure, so the whole derivation is unit-tested without a
 * Cordis composition.
 * @module @banzhe/dsh-devcontainer/presets
 */

import { VARIANT_KINDS, variantIdOf, variantKindOf, variantNameSuffixOf } from './ids.ts'
import type { VariantKind } from './ids.ts'

/**
 * Every row that gives an agent a POSIX shell. The shipped presets pick between
 * these and their PowerShell twins with `disabled: !!js process.platform === 'win32'`,
 * and they do not always use the plain tool: `minimal` mounts
 * `tool-bash-persistent` / `tool-pwsh-persistent` plus `terminal-bash`, so a
 * variant that only flipped the plain pair would still come up with PowerShell.
 */
export const BASH_TOOL_MODULES: readonly string[] = [
  '@deepseek-ai/dsh-tool-bash',
  '@deepseek-ai/dsh-tool-bash-persistent',
  '@deepseek-ai/dsh-terminal-bash',
]

/** Every row that gives an agent a PowerShell shell. */
export const PWSH_TOOL_MODULES: readonly string[] = [
  '@deepseek-ai/dsh-tool-pwsh',
  '@deepseek-ai/dsh-tool-pwsh-persistent',
]

/**
 * Rows whose tool spawns and OWNS its shell process (a PTY, or a persistent
 * session) instead of asking `ctx.shell` for one.
 *
 * They cannot be part of a container variant: the process would start on the
 * host, which is exactly what this Bundle exists to avoid, and on Windows the
 * terminal backend collides with the one the platform already registered
 * ("a PTY backend named \"shell\" is already registered" — the derived preset
 * then mounts as `broken` and disappears from the picker).
 */
export const PERSISTENT_SHELL_MODULES: readonly string[] = [
  '@deepseek-ai/dsh-tool-bash-persistent',
  '@deepseek-ai/dsh-terminal-bash',
]

/** The plain bash tool row, kept as the historical single-name export. */
export const BASH_TOOL_MODULE = BASH_TOOL_MODULES[0] as string

/** The plain PowerShell tool row, kept as the historical single-name export. */
export const PWSH_TOOL_MODULE = PWSH_TOOL_MODULES[0] as string

/** Module specifier of a preset declaration row. */
export const PRESET_MODULE = '@deepseek-ai/dsh-agent-preset'

/** One row of a declarative preset plugin list. */
export interface PresetRow {
  readonly id?: string
  readonly name: string
  readonly group?: boolean | null
  readonly disabled?: unknown
  readonly config?: unknown
  readonly [key: string]: unknown
}

/** The fields of a preset declaration this Bundle reads and reproduces. */
export interface PresetDeclaration {
  readonly id: string
  readonly name?: string
  readonly description?: string
  readonly order?: number
  readonly plugins: readonly PresetRow[]
}

/**
 * The derived id for one source preset on one track.
 * @param sourceId - the declared preset id.
 * @param kind - the track; `(devContainer)` when omitted.
 * @returns the variant id, or the id itself when it already names a variant.
 */
export function variantId(sourceId: string, kind: VariantKind = 'devcontainer'): string {
  return variantKindOf(sourceId) === undefined ? variantIdOf(sourceId, kind) : sourceId
}

function isRow(value: unknown): value is PresetRow {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    && typeof (value as { name?: unknown }).name === 'string'
}

function childRows(row: PresetRow): readonly PresetRow[] | undefined {
  return row.group === true && Array.isArray(row.config) ? row.config.filter(isRow) : undefined
}

/** Deep-clone preset data (plain objects, arrays, and `!!js` marker objects). */
export function cloneRows(rows: readonly PresetRow[]): PresetRow[] {
  return rows.map((row) => {
    const cloned: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(row)) cloned[key] = cloneValue(value)
    return cloned as unknown as PresetRow
  })
}

function cloneValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(cloneValue)
  if (typeof value === 'object' && value !== null) {
    const cloned: Record<string, unknown> = {}
    for (const [key, entry] of Object.entries(value)) cloned[key] = cloneValue(entry)
    return cloned
  }
  return value
}

/**
 * Whether one row asks for a PowerShell shell.
 *
 * The module alone does not decide: `terminal-bash` carries BOTH dialects, and a
 * `shellDialect: pwsh` row left enabled is what collides with the bash backend.
 * @param row - the declared row.
 * @returns true for a PowerShell row in either form.
 */
function isPowerShellRow(row: PresetRow): boolean {
  if (PWSH_TOOL_MODULES.includes(row.name)) return true
  return typeof row.config === 'object' && row.config !== null
    && (row.config as { shellDialect?: unknown }).shellDialect === 'pwsh'
}

/**
 * Flip every shell tool row at any nesting depth, so the variant speaks bash
 * inside the container and nothing else.
 *
 * - a PowerShell row (by module or by `shellDialect`) is disabled;
 * - a persistent/terminal bash row cannot keep its module: it owns a host-side
 *   shell process, so it is rewritten into the ordinary `tool-bash` row, which
 *   goes through `ctx.shell` and therefore into the container;
 * - only ONE such row is rewritten, because a second would mount a duplicate
 *   `bash` tool; the rest are disabled;
 * - a row that already is `tool-bash`, or has no `disabled` field at all, gains
 *   an explicit one, so a preset can no longer inherit the platform guess.
 * @param rows - the declared plugin list.
 * @returns a new list; the input is never mutated.
 */
export function rewriteShellTools(rows: readonly PresetRow[]): PresetRow[] {
  const state = { plain: false, replaced: false }
  const scan = (list: readonly PresetRow[]): void => {
    for (const row of list) {
      if (row.name === BASH_TOOL_MODULE) state.plain = true
      const children = childRows(row)
      if (children !== undefined) scan(children)
    }
  }
  scan(rows)
  const rewrite = (list: readonly PresetRow[]): PresetRow[] => list.map((row) => {
    const next: Record<string, unknown> = { ...row }
    if (isPowerShellRow(row)) next.disabled = true
    else if (row.name === BASH_TOOL_MODULE) next.disabled = false
    else if (PERSISTENT_SHELL_MODULES.includes(row.name)) {
      if (state.plain || state.replaced) next.disabled = true
      else {
        state.replaced = true
        next.name = BASH_TOOL_MODULE
        next.disabled = false
        // Terminal knobs (`shellDialect`, PTY sizing) are not `tool-bash` fields.
        delete next.config
      }
    }
    const children = childRows(row)
    if (children !== undefined) next.config = rewrite(children)
    return next as unknown as PresetRow
  })
  return rewrite(rows)
}

/** The subagent presets one row's config names, in declaration order. */
function presetRefsOf(config: unknown): string[] {
  if (typeof config !== 'object' || config === null || Array.isArray(config)) return []
  const { agentPreset, allowedAgentPresets } = config as {
    agentPreset?: unknown
    allowedAgentPresets?: unknown
  }
  const found: string[] = []
  if (typeof agentPreset === 'string' && agentPreset !== '') found.push(agentPreset)
  if (Array.isArray(allowedAgentPresets)) {
    for (const entry of allowedAgentPresets) {
      if (typeof entry === 'string' && entry !== '') found.push(entry)
    }
  }
  return found
}

/**
 * Every preset id a plugin list routes a subagent to.
 *
 * A subagent row names its preset twice over: `agentPreset` fixes it, and
 * `allowedAgentPresets` (the array form `@deepseek-ai/dsh-tool-subagent` accepts)
 * lists the choices a caller may make. Both have to be derived, or a route can
 * point at a preset that has no container variant.
 * @param rows - the declared plugin list.
 * @returns the referenced preset ids, in first-seen order, without duplicates.
 */
export function referencedPresets(rows: readonly PresetRow[]): string[] {
  const found: string[] = []
  const collect = (list: readonly PresetRow[]): void => {
    for (const row of list) {
      for (const id of presetRefsOf(row.config)) {
        if (!found.includes(id)) found.push(id)
      }
      const children = childRows(row)
      if (children !== undefined) collect(children)
    }
  }
  collect(rows)
  return found
}

/**
 * Point every subagent route at its derived preset, and cut the routes that
 * have none.
 *
 * A route whose preset has no container variant must not survive as it is: the
 * subagent would start on the host with an ordinary preset while the calling
 * agent keeps believing every command runs in the container. Such a route is
 * removed instead — an `allowedAgentPresets` choice is dropped, and a single
 * fixed `agentPreset` disables its whole row, so the tool is absent rather than
 * silently host-bound. The blocked id stays in the disabled row's config, which
 * is where a reader looking for the cause will look.
 * @param rows - the declared plugin list.
 * @param map - source preset id → derived id, or undefined to leave the route alone.
 * @param blocked - whether one preset id has no variant and its routes must be cut.
 * @returns a new list; the input is never mutated.
 */
export function rewriteAgentPresetRefs(
  rows: readonly PresetRow[],
  map: (sourceId: string) => string | undefined,
  blocked: (sourceId: string) => boolean = () => false,
): PresetRow[] {
  const remap = (id: string): string => {
    const mapped = map(id)
    return mapped === undefined ? id : mapped
  }
  return rows.map((row) => {
    const next: Record<string, unknown> = { ...row }
    const config = row.config
    let cut = false
    if (typeof config === 'object' && config !== null && !Array.isArray(config)) {
      const record = config as { agentPreset?: unknown; allowedAgentPresets?: unknown }
      const rewritten: Record<string, unknown> = { ...record }
      let changed = false
      if (typeof record.agentPreset === 'string') {
        if (blocked(record.agentPreset)) cut = true
        else {
          const mapped = remap(record.agentPreset)
          if (mapped !== record.agentPreset) { rewritten.agentPreset = mapped; changed = true }
        }
      }
      if (Array.isArray(record.allowedAgentPresets)) {
        const ids = record.allowedAgentPresets.filter((entry): entry is string => typeof entry === 'string')
        const kept = ids.filter(id => !blocked(id))
        const mapped = kept.map(remap)
        if (kept.length !== ids.length || mapped.some((id, index) => id !== kept[index])) {
          rewritten.allowedAgentPresets = mapped
          changed = true
        }
        // The array form IS the route list: an emptied one leaves the tool with
        // nothing it may spawn, so the row goes with it.
        if (kept.length === 0) cut = true
      }
      if (changed) next.config = rewritten
    }
    if (cut) next.disabled = true
    const children = childRows(row)
    if (children !== undefined) next.config = rewriteAgentPresetRefs(children, map, blocked)
    return next as unknown as PresetRow
  })
}

/**
 * Read one preset declaration out of a Loader row's raw config.
 * @param config - the row's `config` value.
 * @returns the declaration, or undefined when the value is not one.
 */
export function asDeclaration(config: unknown): PresetDeclaration | undefined {
  if (typeof config !== 'object' || config === null || Array.isArray(config)) return undefined
  const record = config as Record<string, unknown>
  if (typeof record.id !== 'string' || record.id === '' || !Array.isArray(record.plugins)) return undefined
  const plugins = record.plugins.filter(isRow)
  if (plugins.length === 0) return undefined
  return {
    id: record.id,
    ...typeof record.name === 'string' ? { name: record.name } : {},
    ...typeof record.description === 'string' ? { description: record.description } : {},
    ...typeof record.order === 'number' ? { order: record.order } : {},
    plugins,
  }
}
/** One derived preset ready to register. */
export interface PlannedVariant {
  /** The derived preset id. */
  readonly id: string
  /** The source preset id this variant came from. */
  readonly source: string
  /** Which runtime the variant routes commands to. */
  readonly kind: VariantKind
  /** Display name shown in the preset picker. */
  readonly name: string
  /** Display description. */
  readonly description: string
  /** Sort order: the source's order plus the configured offset. */
  readonly order: number
  /** The rewritten plugin list. */
  readonly plugins: readonly PresetRow[]
}

/** Inputs of {@link planVariants}. */
export interface VariantPlan {
  /** Source declarations by preset id, as read from the Loader tree. */
  readonly declarations: ReadonlyMap<string, PresetDeclaration>
  /** Source preset ids to derive a `… (devContainer)` variant from, in registration order. */
  readonly sources: readonly string[]
  /** Source preset ids to derive a `… (sbx)` variant from, in registration order. */
  readonly sbxSources?: readonly string[]
  /** Added to the source order. */
  readonly orderOffset: number
  /** How deep a variant may follow its own subagent routes (default 4). */
  readonly maxDepth?: number
}

const DEFAULT_VARIANT_DEPTH = 4

/**
 * Build the description of one derived preset.
 * @param source - the source declaration.
 * @param kind - the track the variant belongs to.
 * @returns the source description with one added sentence.
 */
export function variantDescription(source: PresetDeclaration, kind: VariantKind = 'devcontainer'): string {
  const note = kind === 'sbx'
    ? 'Every command runs inside the Docker Sandbox mounted on this workspace.'
    : "Every command runs inside the repository's Linux Dev Container."
  return source.description === undefined ? note : `${source.description} ${note}`
}

/**
 * The sentence a variant's description gains when the depth cap cut one of its routes.
 * @param maxDepth - the route-following depth this plan was built with.
 * @returns the explanation appended to the source description.
 */
function depthBlockNote(maxDepth: number): string {
  return `Subagent routes deeper than ${maxDepth} nested levels are disabled: their presets would run on the host instead of inside the container.`
}

/**
 * Plan the derived preset set for one composition.
 *
 * The whole point is what it does NOT change: a source preset that mounts no
 * shell tool (the delegate main agent) derives to a preset that still mounts
 * none — only the subagent presets it routes to get bash. A source that does
 * mount the pair gets it flipped. Nothing is inserted, so no variant can gain a
 * capability its source never had.
 *
 * Routes are followed breadth-first and depth-bounded. A route to a preset this
 * composition never declares stays untouched rather than dangling. A route the
 * DEPTH CAP stops is cut instead of kept: the preset behind it would otherwise
 * start an agent on the host under an ordinary preset, which is exactly the
 * silent downgrade the derived presets exist to prevent. Route depth also bounds
 * recursion, so a cyclic route graph terminates here.
 *
 * Two tracks are planned side by side: `sources` derives the
 * `… (devContainer)` set, `sbxSources` the `… (sbx)` set. A track only ever
 * routes into itself — a sandbox subagent under a Dev Container root would run
 * commands in a different runtime than the agent that delegated to it — so the
 * same source can appear on both lists and derives two independent trees.
 *
 * Referenced variants are emitted BEFORE the preset that routes to them.
 *
 * @param input - declarations, both source lists, and the labelling offsets.
 * @returns the variants to register, in dependency order, Dev Container track first.
 */
export function planVariants(input: VariantPlan): PlannedVariant[] {
  const maxDepth = input.maxDepth ?? DEFAULT_VARIANT_DEPTH
  // The map IS the ordering: an entry is inserted after its dependencies were
  // visited, so iteration yields them first. (A plain "already planned" guard is
  // not enough: two routes that reach the same preset — a diamond, or a cycle
  // through its own subagent routes — each finish inside their own frame.) The
  // key carries the track, because one source id can be planned on both.
  const planned = new Map<string, PlannedVariant>()
  const keyOf = (kind: VariantKind, sourceId: string): string => `${kind}\u0000${sourceId}`
  const visit = (kind: VariantKind, sourceId: string, depth: number): void => {
    const key = keyOf(kind, sourceId)
    if (planned.has(key)) return
    const source = input.declarations.get(sourceId)
    if (source === undefined) return
    const id = variantId(sourceId, kind)
    const flipped = rewriteShellTools(cloneRows(source.plugins))
    const routes = new Map<string, string>()
    const blocked = new Set<string>()
    for (const referenced of referencedPresets(flipped)) {
      // A route back to its own preset is the derived preset itself, which is
      // bound to this runtime by construction; recursing into it would not terminate.
      if (referenced === sourceId) routes.set(referenced, id)
      else if (depth < maxDepth) {
        visit(kind, referenced, depth + 1)
        const derived = planned.get(keyOf(kind, referenced))
        if (derived !== undefined) routes.set(referenced, derived.id)
      } else if (planned.has(keyOf(kind, referenced))) routes.set(referenced, variantId(referenced, kind))
      // A declared preset that has no variant to reach is what the depth cap
      // leaves behind; an UNdeclared id keeps its route, because this plan
      // cannot register a variant for a preset it cannot read either.
      if (!routes.has(referenced) && input.declarations.has(referenced)) blocked.add(referenced)
    }
    const description = variantDescription(source, kind)
    planned.set(key, {
      id,
      source: sourceId,
      kind,
      name: `${source.name ?? source.id}${variantNameSuffixOf(kind)}`,
      description: blocked.size === 0 ? description : `${description} ${depthBlockNote(maxDepth)}`,
      order: (source.order ?? 0) + input.orderOffset,
      plugins: rewriteAgentPresetRefs(flipped, referenced => routes.get(referenced), referenced => blocked.has(referenced)),
    })
  }
  for (const kind of VARIANT_KINDS) {
    const sources = kind === 'sbx' ? input.sbxSources ?? [] : input.sources
    for (const sourceId of sources) visit(kind, sourceId, 0)
  }
  return [...planned.values()]
}
