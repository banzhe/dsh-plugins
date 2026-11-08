/**
 * The suffixes and display labels that mark a derived preset, shared by both
 * halves of the Bundle.
 *
 * Two independent tracks exist: a `… (devContainer)` variant for repositories
 * that declare a Dev Container, and a `… (sbx)` variant for Docker Sandbox
 * (`sbx`) sessions. They differ only in the suffix, the label, and the
 * `DSH_*` marker the shell row injects; everything else about a derived preset
 * is identical, so one module owns the naming for both.
 *
 * The browser half needs these to keep derived presets out of its own picker
 * list, and must not import the Host modules to get them: this file has no
 * imports.
 */

/** Appended to a source preset id to name its Dev Container variant. */
export const DEVCONTAINER_VARIANT_SUFFIX = '-devcontainer'

/** Appended to a source preset id to name its Docker Sandbox variant. */
export const SBX_VARIANT_SUFFIX = '-sbx'

/** Appended to a source preset's display name for the Dev Container variant. */
export const DEVCONTAINER_NAME_SUFFIX = ' (devContainer)'

/** Appended to a source preset's display name for the Docker Sandbox variant. */
export const SBX_NAME_SUFFIX = ' (sbx)'

/** Which runtime a derived preset targets. */
export type VariantKind = 'devcontainer' | 'sbx'

/** Every kind, in the order the planner emits them. */
export const VARIANT_KINDS: readonly VariantKind[] = ['devcontainer', 'sbx']

/**
 * The id suffix of one track.
 * @param kind - the track.
 * @returns `-devcontainer` or `-sbx`.
 */
export function variantSuffixOf(kind: VariantKind): string {
  return kind === 'sbx' ? SBX_VARIANT_SUFFIX : DEVCONTAINER_VARIANT_SUFFIX
}

/**
 * The display-name suffix of one track.
 * @param kind - the track.
 * @returns ` (devContainer)` or ` (sbx)`.
 */
export function variantNameSuffixOf(kind: VariantKind): string {
  return kind === 'sbx' ? SBX_NAME_SUFFIX : DEVCONTAINER_NAME_SUFFIX
}

/**
 * The derived id of one source preset on one track.
 * @param source - the source preset id.
 * @param kind - the track the variant belongs to.
 * @returns the variant id.
 */
export function variantIdOf(source: string, kind: VariantKind): string {
  return `${source}${variantSuffixOf(kind)}`
}

/**
 * The track one variant id belongs to.
 * @param id - any preset id.
 * @returns the track, or undefined when the id names no derived preset.
 */
export function variantKindOf(id: string): VariantKind | undefined {
  // The Dev Container suffix is checked first: it is the older of the two, and
  // no id can carry both.
  if (id.endsWith(DEVCONTAINER_VARIANT_SUFFIX)) return 'devcontainer'
  if (id.endsWith(SBX_VARIANT_SUFFIX)) return 'sbx'
  return undefined
}

/**
 * Whether an id names a `… (devContainer)` preset.
 * @param id - any preset id.
 * @returns true when the id carries the Dev Container suffix.
 */
export function isDevcontainerVariantId(id: string): boolean {
  return id.endsWith(DEVCONTAINER_VARIANT_SUFFIX)
}

/**
 * Whether an id names a `… (sbx)` preset.
 * @param id - any preset id.
 * @returns true when the id carries the Docker Sandbox suffix.
 */
export function isSbxVariantId(id: string): boolean {
  return id.endsWith(SBX_VARIANT_SUFFIX)
}

/**
 * Whether an id names a preset this Bundle derived, on either track.
 * @param id - any preset id.
 * @returns true when the id carries either variant suffix.
 */
export function isAnyVariantId(id: string): boolean {
  return variantKindOf(id) !== undefined
}
