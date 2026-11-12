/**
 * The open-in-app availability gate for the Workspace launch rows.
 *
 * One `GET open-in-app/apps` per page decides which launch rows exist at all:
 * the official catalog declares an application only when the Host resolved it
 * (an uninstalled app, an SSH launch environment, or an unreachable route all
 * read as "no"), and `explorer` is declared on `win32` alone — which is why the
 * file-browser row needs no platform sniff here.
 *
 * The read is warm and memoized, and it is never allowed to hold the shared
 * menu open: a resolution waits at most `FIRST_ANSWER_WAIT_MS` and then reports
 * the rows it can prove, while a round still in flight keeps running and fills
 * the memo for the next opening. A round that could not answer clears the memo,
 * so the next opening asks again instead of losing the launch rows for the rest
 * of the page's life.
 */
import {
  OPEN_IN_APP_APPS_ROUTE,
  type OpenInAppAppsPayload,
} from '@deepseek-ai/dsh-host-open-in-app/shared'

/** The catalog ids the launch rows need, in menu order — the set a probe must answer. */
export const LAUNCH_APP_IDS = ['vscode', 'explorer'] as const

/** One launch row's catalog id. */
export type LaunchAppId = (typeof LAUNCH_APP_IDS)[number]

/** Longest a menu resolution waits for the catalog before opening without it. */
export const FIRST_ANSWER_WAIT_MS = 300

/** One console line for a catalog that could not be read. */
export const CATALOG_FAILURE_LOG = 'sidebar-menu-actions: the open-in-app catalog could not be read; the workspace menu omits the launch rows'

/**
 * One console line for a catalog id this Host did not resolve.
 * @param app - the catalog id the omitted row would have launched.
 * @returns the line, in the same shape for every id.
 */
export function missingAppLog(app: string): string {
  return `sidebar-menu-actions: ${app} is not available on this host; the workspace menu omits that row`
}

/** What one catalog read answered: the resolved ids, or why there are none. */
export type CatalogAnswer =
  | { readonly ok: true; readonly apps: ReadonlySet<string> }
  | { readonly ok: false; readonly detail: string }

/**
 * Read the Host's resolved-application list once. Never rejects: an unreachable
 * route, a non-2xx answer, and a body without an `apps` array all report
 * `ok: false` with the status or message that says which.
 * @returns the resolved catalog ids, or the failure detail.
 */
export async function readAppCatalog(): Promise<CatalogAnswer> {
  try {
    const response = await fetch(OPEN_IN_APP_APPS_ROUTE, { headers: { accept: 'application/json' } })
    if (!response.ok) return { ok: false, detail: `HTTP ${String(response.status)}` }
    const payload = await response.json() as Partial<OpenInAppAppsPayload>
    if (!Array.isArray(payload.apps)) return { ok: false, detail: 'the answer carried no app list' }
    return { ok: true, apps: new Set(payload.apps) }
  } catch (cause) {
    return { ok: false, detail: cause instanceof Error ? cause.message : String(cause) }
  }
}

/** Where the probe's console lines go, with the failure detail as the second argument. */
export interface LaunchProbeOptions {
  readonly warn: (line: string, detail?: string) => void
}

/** The one catalog read a page shares between menus. */
export interface LaunchProbe {
  /** Start the read without waiting for it; safe to call again. */
  warm(): void
  /**
   * Answer for one menu resolution, waiting at most `FIRST_ANSWER_WAIT_MS`.
   * @param signal - the resolution's lifetime; aborting stops only this wait —
   * the shared read keeps running and its answer stays available to later menus.
   * @returns the ids whose launch rows may appear; empty while unanswered.
   * @throws the abort's own reason (`signal.reason`) when the signal is already
   * aborted or aborts during the wait.
   */
  appsFor(signal: AbortSignal): Promise<ReadonlySet<string>>
}

/**
 * Settle when `pending` settles, after `ms`, or on abort — whichever comes
 * first, with its timer never outliving the wait.
 * @param pending - work that may outlast the menu's patience; never rejects.
 * @param ms - longest wait.
 * @param signal - ends the wait early.
 * @returns settles at the first of those three.
 */
function settleWithin(pending: Promise<void>, ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const done = (): void => { clearTimeout(timer); signal.removeEventListener('abort', done); resolve() }
    const timer = setTimeout(done, ms)
    signal.addEventListener('abort', done, { once: true })
    void pending.then(done)
  })
}

const NO_APPS: ReadonlySet<string> = new Set()

/**
 * Build the page-wide probe.
 * @param options - console sink for the one line per unreadable catalog and per unresolved id.
 * @returns the memoized read.
 */
export function createLaunchProbe(options: LaunchProbeOptions): LaunchProbe {
  /** The round in flight or the last one; undefined once a round failed. */
  let round: Promise<void> | undefined
  /** The ids of the last successful round; undefined until one answers. */
  let apps: ReadonlySet<string> | undefined
  const missing = new Set<string>()
  let failed = false

  const start = (): Promise<void> => {
    const current = (async (): Promise<void> => {
      const answer = await readAppCatalog()
      if (!answer.ok) {
        if (!failed) { failed = true; options.warn(CATALOG_FAILURE_LOG, answer.detail) }
        // The rows' absence is a retryable miss, not a Host without these apps:
        // the next opening asks again.
        round = undefined
        return
      }
      apps = answer.apps
      for (const app of LAUNCH_APP_IDS) {
        if (answer.apps.has(app) || missing.has(app)) continue
        missing.add(app)
        options.warn(missingAppLog(app))
      }
    })()
    round = current
    return current
  }

  return {
    warm: (): void => { if (round === undefined && apps === undefined) void start() },
    appsFor: async (signal: AbortSignal): Promise<ReadonlySet<string>> => {
      // A dismissed menu reports its own abort reason instead of rows it no
      // longer has an owner for; the read behind it is nobody's to cancel.
      signal.throwIfAborted()
      // An answered probe costs no request; an unanswered one gets at most
      // FIRST_ANSWER_WAIT_MS of the menu's time.
      if (apps === undefined) {
        const settled = round ?? start()
        await settleWithin(settled, FIRST_ANSWER_WAIT_MS, signal)
        signal.throwIfAborted()
      }
      return apps ?? NO_APPS
    },
  }
}
