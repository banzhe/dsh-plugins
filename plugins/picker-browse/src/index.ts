/**
 * Node half. Empty apply so the Bundle appears in the Host Loader; the browser
 * half ships through exports["./client"]. The listing and creation primitives
 * it drives live in `@deepseek-ai/dsh-host-directory-picker-browse`.
 */

/** Loader-facing plugin name for this Bundle's host row. */
export const name = 'picker-browse'

/** Host plugin body — no host-side behavior for this surface plugin. */
export function apply(): void {}
