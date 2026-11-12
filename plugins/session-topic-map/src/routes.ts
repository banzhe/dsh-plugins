/**
 * The Host half: Session events in, a persisted topic graph out.
 *
 * Three exact routes sit on one idea — the analysis cursor is authoritative. The
 * panel reads the stored graph, asks for the models it may pick from, and posts
 * one analysis run at a time; a run reads only events past the checkpoint, calls
 * the model the user confirmed, and writes the next graph only after the answer
 * parsed. A failed, refused, or unreadable run therefore leaves the checkpoint
 * exactly where it was, and the next run reads the same messages again.
 *
 * @module @banzhe/dsh-session-topic-map/src/routes
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-llm'
import type { KvTable } from '@deepseek-ai/dsh-storage-domain'
import type {} from '@deepseek-ai/dsh-storage-domain'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { SessionId } from '@deepseek-ai/dsh-session'
import { ANALYSIS_SYSTEM_PROMPT, allowedSeqsOf, buildBatch, correctTurns, parseAnalysisOutput, planAnalysis, renderAnalysisPrompt } from './analysis.ts'
import { currentGraphOf, SESSION_TOPIC_TABLE, sessionTopicDomainSpec, storedRecord } from './domain.ts'
import type { TopicGraphRecord } from './domain.ts'
import { callTopicAnalysis } from './model-call.ts'
import {
  ANALYZE_PATH,
  MODELS_PATH,
  STATE_PATH,
  type TopicAnalyzeRequest,
  type TopicAnalyzeResult,
  type TopicModelsResult,
  type TopicProvider,
  type TopicRouteError,
  type TopicStateResult,
} from './shared.ts'
import { applyAnalysis, EMPTY_PROGRESS_GRAPH, type ProgressGraph } from './progress-graph.ts'

/** Cordis function-plugin name; also the Loader row id. */
export const name = 'session-topic-map'

/** Services this Host half cannot work without. */
export const inject = ['webServer', 'connection', 'llm', 'sessionQuery', 'storageDomain']

/**
 * The one query this Bundle reads: a detached copy of a Session's raw log.
 *
 * Restated instead of imported: `@deepseek-ai/dsh-session-query` is a Host
 * service the profile mounts, not a package this Bundle links against, and the
 * route reads exactly this one method.
 */
interface SessionQueryLike {
  readSession(sessionId: SessionId): Promise<{ readonly events: readonly SessionEvent[] }>
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    sessionQuery: SessionQueryLike
  }
}

/** Trust surface consumed here; the browser-side connection package owns the full type. */
interface ConnectionLike {
  requestRejection(req: unknown): number | undefined
}

/** The Node request surface these routes read; an unread body is drained, not left open. */
interface RouteRequest extends AsyncIterable<Buffer> {
  readonly method?: string | undefined
  readonly url?: string | undefined
  readonly headers: Record<string, string | string[] | undefined>
  resume(): void
}

interface RouteResponse {
  statusCode: number
  setHeader(name: string, value: string): void
  end(body?: string): void
}

/** The route carrier; `register` returns this plugin's disposer. */
interface WebServerLike {
  register(route: {
    kind: 'exact'
    path: string
    handler: (req: RouteRequest, res: RouteResponse) => Promise<void> | void
  }): () => void
}

/** A topic list is small; anything larger is not an analysis answer. */
const MAX_BODY_BYTES = 8 * 1024

function connectionOf(ctx: Context): ConnectionLike {
  return (ctx as unknown as { connection: ConnectionLike }).connection
}

function webServerOf(ctx: Context): WebServerLike {
  return (ctx as unknown as { webServer: WebServerLike }).webServer
}

function rejected(connection: ConnectionLike, req: unknown, res: RouteResponse): boolean {
  const rejection = connection.requestRejection(req)
  if (rejection === undefined) return false
  res.statusCode = rejection
  res.end()
  return true
}

function sendJson(res: RouteResponse, status: number, payload: unknown): void {
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(JSON.stringify(payload))
}

function sendMethodNotAllowed(res: RouteResponse, allow: string): void {
  res.statusCode = 405
  res.setHeader('allow', allow)
  res.end()
}

function sendError(res: RouteResponse, status: number, code: string, message: string): void {
  const body: TopicRouteError = { code, message }
  sendJson(res, status, body)
}

/** One query-string parameter, unescaped; `null` when absent or empty. */
export function queryParam(url: string | undefined, key: string): string | null {
  if (url === undefined) return null
  const query = url.includes('?') ? url.slice(url.indexOf('?')) : ''
  const value = new URLSearchParams(query).get(key)
  return value === null || value.trim() === '' ? null : value
}

async function readBoundedBody(req: RouteRequest): Promise<string | null> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.byteLength
    if (size > MAX_BODY_BYTES) {
      req.resume()
      return null
    }
    chunks.push(chunk)
  }
  return Buffer.concat(chunks, size).toString('utf8')
}

/**
 * Read one JSON POST body: the method, the media type, and the size ceiling.
 * @param req - the incoming request.
 * @param res - the response, answered directly when the request is refused.
 * @returns the body text, or `null` when a refusal was already sent.
 */
async function readJsonPost(req: RouteRequest, res: RouteResponse): Promise<string | null> {
  if (req.method !== 'POST') {
    sendMethodNotAllowed(res, 'POST')
    return null
  }
  const essence = String(req.headers['content-type']).split(';', 1)[0]?.trim().toLowerCase()
  if (essence !== 'application/json') {
    sendError(res, 415, 'unsupported-media-type', 'content-type must be application/json')
    return null
  }
  let text: string | null
  try {
    text = await readBoundedBody(req)
  }
  catch {
    sendError(res, 400, 'bad-request', 'request body unreadable')
    return null
  }
  if (text === null) {
    sendError(res, 413, 'payload-too-large', 'request body is too large')
    return null
  }
  return text
}

/**
 * Validate one analysis request.
 *
 * `confirm` is checked here, before any model route resolves: a request that does
 * not carry the user's explicit confirmation is refused with `not-confirmed`, so
 * the confirmation is enforced at the call site rather than by panel state.
 *
 * @param text - the request body.
 * @returns the parsed request; `null` when the body does not match the schema.
 */
export function parseAnalyzeRequest(text: string): TopicAnalyzeRequest | null {
  let body: unknown
  try {
    body = JSON.parse(text)
  }
  catch {
    return null
  }
  if (typeof body !== 'object' || body === null) return null
  const { sessionId, provider, model, confirm } = body as Record<string, unknown>
  if (typeof sessionId !== 'string' || sessionId.trim() === '') return null
  if (typeof provider !== 'string' || provider.trim() === '') return null
  if (typeof model !== 'string' || model.trim() === '') return null
  if (confirm !== true) return null
  return { sessionId, provider, model, confirm: true }
}

/** What one route family needs from the plugin body. */
interface RouteDeps {
  readonly ctx: Context
  readonly graphs: KvTable<string, TopicGraphRecord>
}

async function modelsHandler(deps: RouteDeps, req: RouteRequest, res: RouteResponse): Promise<void> {
  if (rejected(connectionOf(deps.ctx), req, res)) return
  if (req.method !== 'GET') {
    sendMethodNotAllowed(res, 'GET')
    return
  }
  const providers: TopicProvider[] = []
  for (const provider of deps.ctx.llm.listProviders()) {
    try {
      const models = await deps.ctx.llm.listModels(provider.id)
      providers.push({
        provider: provider.id,
        name: provider.name,
        models: models.map(model => ({ id: model.id, name: model.name })),
      })
    }
    catch {
      // A route that cannot list its catalog is simply not offered; the picker
      // must never show a model the next call would then refuse.
    }
  }
  const result: TopicModelsResult = { providers }
  sendJson(res, 200, result)
}

async function stateHandler(deps: RouteDeps, req: RouteRequest, res: RouteResponse): Promise<void> {
  if (rejected(connectionOf(deps.ctx), req, res)) return
  if (req.method !== 'GET') {
    sendMethodNotAllowed(res, 'GET')
    return
  }
  const sessionId = queryParam(req.url, 'sessionId')
  if (sessionId === null) {
    sendError(res, 400, 'bad-request', 'sessionId is required')
    return
  }
  const record = deps.graphs.get(sessionId)
  // A legacy record's timestamp belongs to a graph this build will not show, so
  // it answers with no timestamp at all rather than a stale one.
  const stored = currentGraphOf(record)
  const graph = stored === null ? null : await anchoredGraph(deps, sessionId, stored, record)
  const result: TopicStateResult = {
    graph: graph ?? EMPTY_PROGRESS_GRAPH,
    updatedAt: graph === null ? null : record?.updatedAt ?? null,
  }
  sendJson(res, 200, result)
}

/**
 * Re-anchor a stored graph to the turns the log records, once per record.
 *
 * An earlier build derived a node's turn from turn boundaries alone, so a stored
 * graph can carry a turn the transcript never shows. Reading is the moment to fix
 * that: the log is read, the nodes are corrected in place (no model call), and
 * the record is written back marked as verified. A log that cannot be read leaves
 * the stored graph untouched rather than failing the request.
 *
 * @param deps - the plugin's route dependencies.
 * @param sessionId - the Session whose record is being read.
 * @param stored - the graph the record holds.
 * @param record - the record itself, for its verification flag.
 * @returns the graph to answer with.
 */
async function anchoredGraph(
  deps: RouteDeps,
  sessionId: string,
  stored: ProgressGraph,
  record: TopicGraphRecord | undefined,
): Promise<ProgressGraph> {
  const verified = record !== undefined && 'turnsVerified' in record && record.turnsVerified === true
  if (verified) return stored
  let events: readonly SessionEvent[]
  try {
    events = (await deps.ctx.sessionQuery.readSession(SessionId(sessionId))).events
  }
  catch {
    return stored
  }
  const corrected = correctTurns(stored, events)
  const next = corrected ?? stored
  try {
    const updatedAt = record?.updatedAt ?? new Date().toISOString()
    await deps.graphs.put(sessionId, storedRecord(next, updatedAt))
  }
  catch {
    // The correction is an improvement, not a precondition: a failed write must
    // not turn a readable state into an error.
  }
  return next
}

async function analyzeHandler(deps: RouteDeps, req: RouteRequest, res: RouteResponse): Promise<void> {
  const { ctx } = deps
  if (rejected(connectionOf(ctx), req, res)) return
  const text = await readJsonPost(req, res)
  if (text === null) return
  const request = parseAnalyzeRequest(text)
  if (request === null) {
    sendError(res, 400, 'not-confirmed', 'an analysis run needs a confirmed provider and model')
    return
  }
  let modelIds: readonly string[]
  try {
    modelIds = (await ctx.llm.listModels(request.provider)).map(model => model.id)
  }
  catch {
    sendError(res, 400, 'unknown-provider', `provider "${request.provider}" advertises no models`)
    return
  }
  if (!modelIds.includes(request.model)) {
    sendError(res, 400, 'unknown-model', `provider "${request.provider}" does not advertise "${request.model}"`)
    return
  }
  const sessionId = SessionId(request.sessionId)
  let events: readonly SessionEvent[]
  try {
    events = (await ctx.sessionQuery.readSession(sessionId)).events
  }
  catch {
    sendError(res, 404, 'session-not-found', `session "${request.sessionId}" could not be read`)
    return
  }
  const record = deps.graphs.get(request.sessionId)
  const stored = currentGraphOf(record) ?? EMPTY_PROGRESS_GRAPH
  // The events are already here, so an unverified graph is re-anchored before it
  // is planned against instead of waiting for the next /state read.
  const graph: ProgressGraph = correctTurns(stored, events) ?? stored
  const plan = planAnalysis(graph, events)
  if (plan === null) {
    const result: TopicAnalyzeResult = {
      graph,
      analyzed: { fromSeq: graph.checkpoint + 1, toSeq: graph.checkpoint, messages: 0, topics: 0 },
    }
    sendJson(res, 200, result)
    return
  }
  let next: ProgressGraph
  let topics = 0
  if (plan.lines.length === 0) {
    // Nothing readable in range: the checkpoint still advances, so the same
    // non-conversational events are not rescanned on every run.
    next = applyAnalysis(graph, buildBatch(plan, []))
  }
  else {
    let answer: string
    try {
      answer = await callTopicAnalysis({
        provider: request.provider,
        model: request.model,
        system: ANALYSIS_SYSTEM_PROMPT,
        prompt: renderAnalysisPrompt(graph, plan),
        llm: ctx.llm,
      })
    }
    catch (error) {
      const message = error instanceof Error ? error.message : 'the model call failed'
      sendError(res, 409, 'analysis-failed', message)
      return
    }
    const parsed = parseAnalysisOutput(answer, allowedSeqsOf(plan))
    if (parsed === null) {
      sendError(res, 422, 'unreadable-answer', 'the model answer was not the required JSON object')
      return
    }
    const batch = buildBatch(plan, parsed)
    // An empty topic list is a legal answer — the model judged the range to
    // advance nothing — so the run succeeds and the checkpoint still advances.
    // An answer that named topics but no usable one is a parse failure and was
    // refused above, leaving the range for the retry.
    topics = batch.contributions.length
    next = applyAnalysis(graph, batch)
  }
  try {
    await deps.graphs.put(request.sessionId, storedRecord(next, new Date().toISOString()))
  }
  catch (error) {
    const message = error instanceof Error ? error.message : 'the graph could not be stored'
    sendError(res, 500, 'store-failed', message)
    return
  }
  const result: TopicAnalyzeResult = {
    graph: next,
    analyzed: { fromSeq: plan.fromSeq, toSeq: plan.toSeq, messages: plan.lines.length, topics },
  }
  sendJson(res, 200, result)
}

/**
 * Mount the three routes and the domain they read.
 * @param ctx - the plugin's context.
 */
export async function apply(ctx: Context): Promise<void> {
  const domain = await ctx.storageDomain.open(sessionTopicDomainSpec)
  ctx.effect(() => () => domain.close(), `${name}: domain`)
  const deps: RouteDeps = { ctx, graphs: domain.table(SESSION_TOPIC_TABLE) }
  ctx.effect(() => webServerOf(ctx).register({
    kind: 'exact',
    path: MODELS_PATH,
    handler: async (req, res) => { await modelsHandler(deps, req, res) },
  }), `${name}: GET ${MODELS_PATH}`)
  ctx.effect(() => webServerOf(ctx).register({
    kind: 'exact',
    path: STATE_PATH,
    handler: async (req, res) => { await stateHandler(deps, req, res) },
  }), `${name}: GET ${STATE_PATH}`)
  ctx.effect(() => webServerOf(ctx).register({
    kind: 'exact',
    path: ANALYZE_PATH,
    handler: async (req, res) => { await analyzeHandler(deps, req, res) },
  }), `${name}: POST ${ANALYZE_PATH}`)
}
