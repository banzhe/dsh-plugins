/**
 * App-notification plugin, node half. Empty apply so the Bundle appears in the
 * Host Loader; the browser half ships through exports["./client"].
 */

export const name = 'app-notification'

/** Host plugin body — no Host-side behavior. */
export function apply(): void {}
