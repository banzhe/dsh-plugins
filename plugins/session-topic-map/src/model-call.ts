/**
 * The one model call this Bundle makes.
 *
 * Split from the route so the route owns policy — which Session, which range,
 * what to persist — while this module owns framing and consuming the stream. The
 * model access is a port: production passes `ctx.llm`, a test passes an
 * in-memory iterable.
 *
 * @module @banzhe/dsh-session-topic-map/src/model-call
 */

import { BlockAssembler, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, FinishReason, GenerateOptions, Message, StreamChunk } from '@deepseek-ai/dsh-llm'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'dsh-session-topic-map': { kind: 'dsh-session-topic-map' }
  }
}

/** The module's only capability: the host's model stream. */
export interface TopicModel {
  stream(options: GenerateOptions): AsyncIterable<StreamChunk>
}

/** End-to-end deadline for one analysis call. */
const TIMEOUT_MS = 90_000

/** A topic list is short; this cap also bounds a runaway reasoning route. */
const MAX_OUTPUT_TOKENS = 1_500

/** Everything one call needs beyond its own policy. */
export interface TopicAnalysisCall {
  /** Provider route the user confirmed. */
  readonly provider: string
  /** Model id the user confirmed. */
  readonly model: string
  /** System turn: the JSON the answer must be. */
  readonly system: string
  /** User turn: the labelled messages plus the topics already in use. */
  readonly prompt: string
  /** The host's model stream. */
  readonly llm: TopicModel
}

function textOf(blocks: readonly ContentBlock[]): string {
  return blocks
    .filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text')
    .map(block => block.text)
    .join('')
    .trim()
}

/**
 * A merge-extensible reason this Bundle cannot use; `undefined` means `stop`.
 * @param finish - the assembled finish reason.
 * @returns the failure message, or `undefined` for a clean stop.
 */
export function finishFailure(finish: FinishReason): string | undefined {
  switch (finish.kind) {
    case 'stop':
      return undefined
    case 'max-tokens':
      return 'the topic analysis ran out of output tokens'
    case 'tool-calls':
      return 'the topic analysis requested a tool'
    case 'error':
    case 'aborted':
      return finish.failure.message
    default:
      return 'the topic analysis ended unexpectedly'
  }
}

/**
 * Run one analysis call and return its visible answer.
 * @param call - the confirmed route, the framed turns, and the model access.
 * @returns the model's visible text, trimmed.
 * @throws when the stream fails, is aborted, or stops without usable text.
 */
export async function callTopicAnalysis(call: TopicAnalysisCall): Promise<string> {
  const signal = AbortSignal.timeout(TIMEOUT_MS)
  const messages: Message[] = [createUserMessage({
    content: [{ type: 'text', text: call.prompt }],
    source: { kind: 'dsh-session-topic-map' },
  })]
  const options: GenerateOptions = {
    provider: call.provider,
    model: call.model,
    messages,
    system: call.system,
    maxTokens: MAX_OUTPUT_TOKENS,
    signal,
  }
  const assembler = new BlockAssembler()
  for await (const chunk of call.llm.stream(options)) {
    signal.throwIfAborted()
    assembler.push(chunk)
  }
  signal.throwIfAborted()
  const failure = finishFailure(assembler.finish)
  if (failure !== undefined) throw new Error(failure)
  const answer = textOf(assembler.blocks())
  if (answer === '') throw new Error('the topic analysis answered with no text')
  return answer
}
