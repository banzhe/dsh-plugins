/**
 * Hover-archive plugin, node half. Empty apply so the Bundle appears in the
 * Host Loader; the browser half ships through exports["./client"].
 */

export const name = 'hover-archive'

/** Host plugin body — no Host-side behavior. */
export function apply(): void {}
