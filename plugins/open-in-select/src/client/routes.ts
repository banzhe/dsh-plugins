/**
 * The open-in-app Host routes this control calls, in the document-relative form
 * the browser addresses. They restate the Host's published `./shared` route
 * constants, which this Bundle does not import: a two-string dependency on a
 * Host package would put an inlined copy of it in the browser artifact.
 */

/** GET route serving the probed application ids. */
export const APPS_ROUTE = 'open-in-app/apps'

/** POST route launching one application on one directory. */
export const OPEN_ROUTE = 'open-in-app/open'

/** GET prefix serving one PNG icon per application id. */
export const ICON_ROUTE_PREFIX = 'open-in-app/icon'

/** Apps-route response: probed application ids in the Host's menu order. */
export interface AppsPayload {
  readonly apps: readonly string[]
}

/** Open-route request body. */
export interface OpenPayload {
  readonly app: string
  readonly path: string
}
