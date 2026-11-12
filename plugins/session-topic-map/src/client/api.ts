/**
 * The panel's whole Host conversation: three calls, each answering with the wire
 * types in `../shared.ts`.
 *
 * Every call is cancellable, never throws, and answers with a typed failure
 * instead: a timeout, an unreachable Host, a refused request, and an unreadable
 * answer are different problems, and the panel has to say which one happened
 * instead of leaving the run looking finished. Only cancellation is silent —
 * the caller asked for it.
 *
 * @module @banzhe/dsh-session-topic-map/src/client/api
 */

import type {
  TopicAnalyzeRequest,
  TopicAnalyzeResult,
  TopicAnalyzeSpan,
  TopicModel,
  TopicProvider,
  TopicRouteError,
  TopicStateResult,
} from '../shared.ts'
import { ANALYZE_ROUTE, MODELS_ROUTE, STATE_ROUTE } from '../shared.ts'
import type { ProgressGraph } from '../progress-graph.ts'

/** How long one analysis may take before the panel gives up on it. */
export const ANALYZE_TIMEOUT_MS = 120_000

/** How long a metadata read may take. */
export const READ_TIMEOUT_MS = 15_000

/** The four ways a call can fail besides cancellation. */
export type TopicFailureKind = 'timeout' | 'network' | 'http' | 'body'

/** A failure the panel renders; `message` and `code` are the Host's own when it sent them. */
export interface TopicFailure {
  readonly ok: false
  readonly kind: TopicFailureKind
  readonly status: number | null
  readonly code: string | null
  readonly message: string | null
}

/** Cancellation, which the panel ignores because it asked for it. */
interface Cancelled {
  readonly ok: false
  readonly kind: 'cancelled'
}

type Refused = TopicFailure | Cancelled

type Fetched =
  | { readonly kind: 'response'; readonly status: number; readonly ok: boolean; readonly data: unknown }
  | { readonly kind: 'timeout' }
  | { readonly kind: 'network' }
  | { readonly kind: 'body'; readonly status: number }
  | { readonly kind: 'cancelled' }

function failure(kind: TopicFailureKind, status: number | null, code: string | null, message: string | null): TopicFailure {
  return { ok: false, kind, status, code, message }
}

function cancelled(): Cancelled {
  return { ok: false, kind: 'cancelled' }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function codeOf(data: unknown): string | null {
  if (!isRecord(data)) return null
  const { code } = data as Partial<TopicRouteError>
  return typeof code === 'string' && code !== '' ? code : null
}

function errorOf(data: unknown): string | null {
  if (!isRecord(data)) return null
  const { message } = data as Partial<TopicRouteError>
  return typeof message === 'string' && message !== '' ? message : null
}

/**
 * One request with its own deadline, folded into the caller's cancellation.
 * @param url - the route.
 * @param init - request options, without `signal`.
 * @param signal - the caller's cancellation.
 * @param timeoutMs - how long this request may take.
 * @returns the parsed answer or the kind of failure; never rejects.
 */
async function fetchJson(url: string, init: RequestInit, signal: AbortSignal, timeoutMs: number): Promise<Fetched> {
  const controller = new AbortController()
  let finish: ((value: Fetched) => void) | null = null
  // The first settlement wins: an answer, a refusal, the deadline, or the
  // caller's own cancellation. Nothing after that can change the result.
  const settled = new Promise<Fetched>((resolve) => {
    finish = resolve
  })
  const done = (value: Fetched): void => {
    finish?.(value)
  }
  const onAbort = (): void => {
    controller.abort()
    done({ kind: 'cancelled' })
  }
  signal.addEventListener('abort', onAbort, { once: true })
  if (signal.aborted) onAbort()
  const timer = setTimeout(() => {
    controller.abort()
    done({ kind: 'timeout' })
  }, timeoutMs)
  try {
    void (async (): Promise<void> => {
      try {
        const response = await fetch(url, { ...init, signal: controller.signal })
        try {
          done({ kind: 'response', status: response.status, ok: response.ok, data: await response.json() })
        }
        catch {
          done({ kind: 'body', status: response.status })
        }
      }
      catch {
        done(signal.aborted ? { kind: 'cancelled' } : { kind: 'network' })
      }
    })()
    return await settled
  }
  finally {
    clearTimeout(timer)
    signal.removeEventListener('abort', onAbort)
  }
}

function statusOf(value: number | undefined): number | null {
  return typeof value === 'number' ? value : null
}

/**
 * Turn a transport outcome into a reported failure.
 * @param outcome - what the request produced.
 * @param data - the parsed body, when the request produced one.
 * @returns the failure the panel renders; a refused request is `http`, an
 * unreadable success is `body`.
 */
function refused(outcome: Fetched, data: unknown): Refused {
  if (outcome.kind === 'cancelled') return cancelled()
  if (outcome.kind === 'timeout') return failure('timeout', null, null, null)
  if (outcome.kind === 'network') return failure('network', null, null, null)
  if (outcome.kind === 'body') return failure('body', statusOf(outcome.status), null, null)
  const status = statusOf(outcome.status)
  return outcome.ok
    ? failure('body', status, codeOf(data), errorOf(data))
    : failure('http', status, codeOf(data), errorOf(data))
}

function modelsOf(value: unknown): readonly TopicModel[] {
  if (!Array.isArray(value)) return []
  const models: TopicModel[] = []
  for (const entry of value) {
    if (!isRecord(entry)) continue
    const { id, name } = entry
    if (typeof id !== 'string' || typeof name !== 'string') continue
    models.push({ id, name })
  }
  return models
}

function providersOf(data: unknown): readonly TopicProvider[] | null {
  if (!isRecord(data)) return null
  const { providers } = data
  if (!Array.isArray(providers)) return null
  const parsed: TopicProvider[] = []
  for (const entry of providers) {
    if (!isRecord(entry)) continue
    const { provider, name, models } = entry
    if (typeof provider !== 'string' || typeof name !== 'string') continue
    parsed.push({ provider, name, models: modelsOf(models) })
  }
  return parsed
}

function isGraph(value: unknown): value is ProgressGraph {
  if (!isRecord(value)) return false
  const { nodes, edges, checkpoint, turn } = value
  return Array.isArray(nodes) && Array.isArray(edges) && typeof checkpoint === 'number' && typeof turn === 'number'
}

function stateOf(data: unknown): TopicStateResult | null {
  if (!isRecord(data)) return null
  const { graph, updatedAt } = data
  if (!isGraph(graph)) return null
  return { graph, updatedAt: typeof updatedAt === 'string' ? updatedAt : null }
}

function spanOf(value: unknown): TopicAnalyzeSpan | null {
  if (!isRecord(value)) return null
  const { fromSeq, toSeq, messages, topics } = value
  if (typeof fromSeq !== 'number' || typeof toSeq !== 'number') return null
  if (typeof messages !== 'number' || typeof topics !== 'number') return null
  return { fromSeq, toSeq, messages, topics }
}

function analysisOf(data: unknown): TopicAnalyzeResult | null {
  if (!isRecord(data)) return null
  const { graph, analyzed } = data
  if (!isGraph(graph)) return null
  const span = spanOf(analyzed)
  return span === null ? null : { graph, analyzed: span }
}

/**
 * Read the routes the picker may offer.
 * @param signal - cancellation for the request.
 * @returns the provider list, or the failure the panel must show.
 */
export async function readModels(signal: AbortSignal): Promise<
  { readonly ok: true; readonly providers: readonly TopicProvider[] } | Refused
> {
  const outcome = await fetchJson(MODELS_ROUTE, {}, signal, READ_TIMEOUT_MS)
  if (outcome.kind !== 'response') return refused(outcome, null)
  const providers = outcome.ok ? providersOf(outcome.data) : null
  return providers === null ? refused(outcome, outcome.data) : { ok: true, providers }
}

/**
 * Read one Session's persisted graph.
 * @param sessionId - the Session on screen.
 * @param signal - cancellation for the request.
 * @returns the stored state, or the failure the panel must show.
 */
export async function readState(sessionId: string, signal: AbortSignal): Promise<
  { readonly ok: true; readonly state: TopicStateResult } | Refused
> {
  const url = `${STATE_ROUTE}?sessionId=${encodeURIComponent(sessionId)}`
  const outcome = await fetchJson(url, {}, signal, READ_TIMEOUT_MS)
  if (outcome.kind !== 'response') return refused(outcome, null)
  const state = outcome.ok ? stateOf(outcome.data) : null
  return state === null ? refused(outcome, outcome.data) : { ok: true, state }
}

/**
 * Run one analysis with the model the user confirmed.
 * @param request - the Session and the confirmed route.
 * @param signal - cancellation for the run.
 * @returns the graph after the run, or the failure the panel must show.
 */
export async function analyzeSession(request: TopicAnalyzeRequest, signal: AbortSignal): Promise<
  { readonly ok: true; readonly result: TopicAnalyzeResult } | Refused
> {
  const outcome = await fetchJson(ANALYZE_ROUTE, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(request),
  }, signal, ANALYZE_TIMEOUT_MS)
  if (outcome.kind !== 'response') return refused(outcome, null)
  const analysis = outcome.ok ? analysisOf(outcome.data) : null
  return analysis === null ? refused(outcome, outcome.data) : { ok: true, result: analysis }
}