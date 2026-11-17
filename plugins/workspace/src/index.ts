/**
 * Node half. Empty apply so the Bundle appears in the Host Loader; the browser
 * half ships through exports["./client"] and is discovered from the
 * package.json `dsh.client` declaration.
 */

export function apply(): void {}
