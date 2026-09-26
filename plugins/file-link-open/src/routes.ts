/**
 * @banzhe/dsh-file-link-open — This plugin's two route paths, published in the
 * same two forms the official `@deepseek-ai/dsh-host-open-in-app/shared` module
 * uses: the ABSOLUTE pathname the Host registers with `webServer`, beside the
 * DOCUMENT-RELATIVE form the browser addresses. A page resolves the relative
 * form against its own document base, so the same client half works under a
 * mount prefix; an absolute string would not.
 *
 * Browser-safe: constants only, imported by both halves. The host half imports
 * `_PATH`, the client half `_ROUTE` — never a literal.
 */

/** GET route path serving this plugin's local resolution report. */
export const INFO_PATH = '/api/file-link-open/info'

/** Browser-relative form of {@link INFO_PATH}. */
export const INFO_ROUTE = INFO_PATH.slice(1)

/** POST route path launching one file in a whitelisted editor. */
export const LAUNCH_PATH = '/api/file-link-open/launch'

/** Browser-relative form of {@link LAUNCH_PATH}. */
export const LAUNCH_ROUTE = LAUNCH_PATH.slice(1)
