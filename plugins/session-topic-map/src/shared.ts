/**
 * Wire contract shared by the Host routes and the Client panel.
 *
 * Browser-safe: types and path constants only. The Host registers `_PATH`; the
 * Client addresses `_ROUTE`, the document-relative form, so the same client half
 * works under a mount prefix.
 */

import type { ProgressGraph } from './progress-graph.ts'

/** One advertised model, as the picker shows it. */
export interface TopicModel {
  readonly id: string
  readonly name: string
}

/** One provider route and the models it advertises right now. */
export interface TopicProvider {
  readonly provider: string
  readonly name: string
  readonly models: readonly TopicModel[]
}

/** GET /models answer: every route the picker may offer. */
export interface TopicModelsResult {
  readonly providers: readonly TopicProvider[]
}

/** GET /state answer: the Session's persisted graph, or the empty one. */
export interface TopicStateResult {
  readonly graph: ProgressGraph
  /** ISO-8601 instant of the last successful analysis, or `null`. */
  readonly updatedAt: string | null
}

/**
 * POST /analyze request.
 *
 * `confirm` is the user's manual confirmation of this exact model: the Host
 * refuses the request before it calls a model when the field is absent, so no
 * panel state or default route can spend a model call on its own.
 */
export interface TopicAnalyzeRequest {
  readonly sessionId: string
  readonly provider: string
  readonly model: string
  readonly confirm: true
}

/** What one analysis run covered. */
export interface TopicAnalyzeSpan {
  /** First event seq the run read. */
  readonly fromSeq: number
  /** Last event seq the run read; the new checkpoint. */
  readonly toSeq: number
  /** Messages the run fed to the model. */
  readonly messages: number
  /** Topic contributions the model reported. */
  readonly topics: number
}

/** POST /analyze answer: the graph after the run. */
export interface TopicAnalyzeResult {
  readonly graph: ProgressGraph
  readonly analyzed: TopicAnalyzeSpan
}

/** A refused request; the Client shows `message` as-is. */
export interface TopicRouteError {
  readonly code: string
  readonly message: string
}

export const MODELS_PATH = '/api/session-topic-map/models'

export const MODELS_ROUTE = MODELS_PATH.slice(1)

export const STATE_PATH = '/api/session-topic-map/state'

export const STATE_ROUTE = STATE_PATH.slice(1)

export const ANALYZE_PATH = '/api/session-topic-map/analyze'

export const ANALYZE_ROUTE = ANALYZE_PATH.slice(1)
