/**
 * The two open-in-app Host calls this control makes: read the installed
 * application ids, then launch one of them on the Session's directory.
 *
 * Neither call rejects: a refused or unreachable Host resolves to a named
 * result, and an unreadable application list resolves to an empty one, which the
 * header renders as no control at all rather than a broken one.
 */
import type { OpenInSelectKey } from './locales.ts'
import { APPS_ROUTE, OPEN_ROUTE, type AppsPayload, type OpenPayload } from './routes.ts'

/** Transport used for both calls; injectable so a spec can drive them. */
type Fetch = (input: string, init?: RequestInit) => Promise<Response>

/**
 * Refusal statuses the Host's `open-in-app/open` route documents. Any other
 * status is still a refusal, but carries no copy of its own.
 */
type LaunchRefusal = 400 | 404 | 413 | 415 | 502

/** Copy key of each documented refusal. */
const REFUSAL_KEYS: Readonly<Record<LaunchRefusal, OpenInSelectKey>> = {
  400: 'error.invalid',
  404: 'error.missing',
  413: 'error.tooLong',
  415: 'error.unsupported',
  502: 'error.launch',
}

/**
 * The copy key one refusal status stands for.
 * @param status - refusal status the Host answered with.
 * @returns the dictionary key, or null for a status the Host does not document.
 */
export function refusalKey(status: number): OpenInSelectKey | null {
  return (REFUSAL_KEYS as Readonly<Record<number, OpenInSelectKey | undefined>>)[status] ?? null
}

/** Outcome of one launch request. */
export type LaunchResult =
  | { readonly kind: 'opened' }
  | { readonly kind: 'refused'; readonly status: number }
  | { readonly kind: 'unreachable' }

/**
 * Read the application ids this Host resolved, in its menu order.
 * @param fetcher - HTTP carrier; defaults to the page's own `fetch`.
 * @returns the ids, or an empty list when the route fails or answers garbage.
 */
export async function loadApps(fetcher: Fetch = (input, init) => fetch(input, init)): Promise<readonly string[]> {
  try {
    const response = await fetcher(APPS_ROUTE, { headers: { accept: 'application/json' } })
    if (!response.ok) return []
    const payload = await response.json() as Partial<AppsPayload>
    if (!Array.isArray(payload.apps)) return []
    return payload.apps.filter((app): app is string => typeof app === 'string')
  } catch {
    return []
  }
}

/**
 * Launch one application on one directory.
 * @param appId - catalog id from the application list.
 * @param path - absolute directory to open.
 * @param fetcher - HTTP carrier; defaults to the page's own `fetch`.
 * @returns the acknowledged handoff, the Host's refusal status, or the fact that it could not be reached.
 */
export async function launchApp(appId: string, path: string, fetcher: Fetch = (input, init) => fetch(input, init)): Promise<LaunchResult> {
  const body: OpenPayload = { app: appId, path }
  try {
    const response = await fetcher(OPEN_ROUTE, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (response.ok) return { kind: 'opened' }
    return { kind: 'refused', status: response.status }
  } catch {
    return { kind: 'unreachable' }
  }
}
