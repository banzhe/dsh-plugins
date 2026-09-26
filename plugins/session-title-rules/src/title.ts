/**
 * Title derivation: one provider request in, one title revision out.
 *
 * This is the module behind the plugin's Loader row. It owns the whole call —
 * resolving the auxiliary route, selecting and framing the messages, consuming
 * the model stream, and accepting or refusing the answer — so the Loader row's
 * `apply` is only an adapter that reads the live policy, hands over the one
 * capability this module needs, and registers the result with the service.
 *
 * Two facts arrive as VALUES rather than through the seam, because neither
 * varies across it: `policy` (the Loader row's `config`) and `currentTitle` (the
 * service's standing title). The one capability that DOES vary — the model
 * stream, `ctx.llm` in production and an in-memory iterable under test — is the
 * port, and it is the module's only in-process seam.
 *
 * Refusal is by exception, with the plugin name prefixed and any cause chained:
 * the title service's own contract is "a provider that throws is warned about
 * and the standing title is kept", and `/title-refresh` reports the same chain
 * back to the user, so an `Error` is the shape both callers already read.
 */

import type { SessionTitleProviderRequest, SessionTitleProviderResult } from '@deepseek-ai/dsh-session-title'
import { createUserMessage, ReasoningEffortId, BlockAssembler } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, FinishReason, GenerateOptions, Message, StreamChunk } from '@deepseek-ai/dsh-llm'
import type { SessionTitleModelIdentity, SessionTitleUserMessage } from '@deepseek-ai/dsh-session-title'
import { formatTitleOutput, PLUGIN_NAME, TITLE_SYSTEM_PROMPT } from './prompt.ts'

// 0.1.7-alpha.2 removed the shared `plugin` message source: every producer now
// declares its own `kind` on `MessageSourceMap`.
declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'dsh-session-title-rules': { kind: 'dsh-session-title-rules' }
  }
}

/**
 * The module's one capability: the model stream. Production passes `ctx.llm`
 * (which satisfies this structurally); a test passes an async iterable of
 * chunks. Nothing else about the surrounding composition is visible here.
 */
export interface TitleModelAccess {
  stream(options: GenerateOptions): AsyncIterable<StreamChunk>
}

/**
 * Deployment policy, already resolved to plain values by the caller.
 *
 * These are read from the Loader row's live (`Volatile`) config on EVERY call,
 * but the reading happens in the adapter, not here: a value that does not vary
 * across this module's seam belongs on the value side of it.
 */
export interface TitlePolicy {
  /** Explicit auxiliary provider route; must be paired with `model`. */
  readonly provider?: string | undefined
  /** Explicit auxiliary model id; must be paired with `provider`. */
  readonly model?: string | undefined
  /** Reasoning effort for the auxiliary call; omission follows the route default. */
  readonly reasoningEffort?: string | undefined
}

/** Everything one derivation needs, as one value. */
export interface TitleDerivation {
  /** Live deployment policy for this call. */
  readonly policy: TitlePolicy
  /** The service's request: messages, logged route, cancellation, session. */
  readonly request: SessionTitleProviderRequest
  /** The service's current standing title, shown to the model as `原名称` only. */
  readonly currentTitle: string | undefined
  /** The model stream. */
  readonly llm: TitleModelAccess
}

/**
 * Fixed auxiliary-call policy; the Loader row's `config` carries only the route,
 * never these caps.
 *
 * The cap must cover reasoning, not just the title line. A reasoning-enabled
 * route spends the whole budget on hidden thinking before it emits any text:
 * `@deepseek-ai/dsh-llm-pi-ai` never reads `purpose`, so the `session-title`
 * hint reaches the adapter as nothing and the profile's own effort still
 * applies. Measured on `cc/deepseek-v4.1-flash` with the shipped prompt,
 * `finish=length` with 64 of 64 tokens spent reasoning: 1/20 usable at 64,
 * versus 17/20 at 512. The built-in provider's 64 fails the same way, and
 * `purpose` is only honoured by `dsh-llm-deepseek`. Configuring
 * `reasoningEffort` (above) is the other lever on the same problem.
 */
const MAX_OUTPUT_TOKENS = 512
/** End-to-end deadline for one auxiliary title call. */
const TIMEOUT_MS = 60_000
/** Framed-input byte cap; past it the oldest messages are dropped. */
const MAX_INPUT_BYTES = 6000
/** Most messages one prompt carries (the first one is always included). */
const MAX_SELECTED_MESSAGES = 8
/** Per-message character cap before framing. */
const MAX_MESSAGE_CHARS = 400

/**
 * The exact auxiliary route and reasoning effort one revision runs on.
 * @throws when the pair is half-configured, or when neither an override nor a
 *   logged request route exists.
 */
function resolveTitleRoute(
  policy: TitlePolicy,
  request: SessionTitleProviderRequest,
): { readonly route: SessionTitleModelIdentity; readonly reasoningEffort?: string } {
  const { provider, model, reasoningEffort } = policy
  if ((provider === undefined) !== (model === undefined)) {
    throw new Error(`${PLUGIN_NAME}: provider and model must be configured together`)
  }
  if (provider !== undefined && model !== undefined) {
    return {
      route: { provider, model },
      ...reasoningEffort === undefined ? {} : { reasoningEffort },
    }
  }
  if (request.route === undefined) {
    throw new Error(`${PLUGIN_NAME}: no logged request route is available for this session`)
  }
  return {
    route: request.route,
    ...reasoningEffort === undefined ? {} : { reasoningEffort },
  }
}

/**
 * Choose the messages one prompt carries: the first eligible human message (the
 * session's opening intent) plus the most recent ones (where the conversation
 * actually went), each text capped. Oldest first.
 */
function selectTitleMessages(
  messages: readonly SessionTitleUserMessage[],
): SessionTitleUserMessage[] {
  const first = messages[0]
  if (first === undefined) return []
  const selected = messages.length <= MAX_SELECTED_MESSAGES
    ? messages
    : [first, ...messages.slice(-(MAX_SELECTED_MESSAGES - 1))]
  return selected.map(message => ({
    seq: message.seq,
    text: message.text.length <= MAX_MESSAGE_CHARS
      ? message.text
      : message.text.slice(0, MAX_MESSAGE_CHARS),
  }))
}

/** Frame one selection as the exact JSON payload the prompt describes. */
function frameTitleInput(
  currentTitle: string | undefined,
  messages: readonly SessionTitleUserMessage[],
): string {
  const payload = {
    ...currentTitle === undefined ? {} : { '原名称': currentTitle },
    messages,
  }
  return `根据这个 JSON 生成标题：\n${JSON.stringify(payload)}`
}

/** The framed user turn plus the messages it actually carried. */
interface FramedTitleInput {
  /** The exact user text handed to the model. */
  readonly input: string
  /** The messages the frame carried, oldest first — the only seqs a result may cite. */
  readonly messages: readonly SessionTitleUserMessage[]
}

/**
 * Select and frame the messages for one title call, dropping the oldest
 * non-first message until the frame fits `MAX_INPUT_BYTES`. Throws when no
 * eligible message fits the cap.
 */
function buildTitleInput(
  currentTitle: string | undefined,
  messages: readonly SessionTitleUserMessage[],
): FramedTitleInput {
  const selected = selectTitleMessages(messages)
  if (selected.length === 0) throw new Error(`${PLUGIN_NAME}: at least one source message is required`)
  while (true) {
    const input = frameTitleInput(currentTitle, selected)
    if (Buffer.byteLength(input, 'utf8') <= MAX_INPUT_BYTES) return { input, messages: selected }
    // Dropping the oldest non-first message is the only reachable trim: one message is
    // capped at MAX_MESSAGE_CHARS, so its worst-case escaped frame (400 × 6 bytes, plus an
    // 80-byte title and the scaffolding) stays well under MAX_INPUT_BYTES. Reaching this
    // throw means those constants drifted apart.
    if (selected.length === 1) {
      throw new Error(`${PLUGIN_NAME}: framed title input exceeds ${MAX_INPUT_BYTES} bytes`)
    }
    selected.splice(1, 1)
  }
}

/** Concatenate the text blocks of one assembled auxiliary response. */
function textOf(blocks: readonly ContentBlock[]): string {
  return blocks
    .filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text')
    .map(block => block.text)
    .join(' ')
}

/** Translate a terminal finish reason into an auxiliary-call failure. */
function finishError(finish: FinishReason): Error | undefined {
  switch (finish.kind) {
    case 'stop':
      return undefined
    case 'error':
    case 'aborted': {
      const error = new Error(finish.failure.message) as Error & { code?: string }
      error.code = finish.failure.code
      return error
    }
    case 'max-tokens':
      return new Error(`${PLUGIN_NAME}: title output reached maxOutputTokens`)
    case 'tool-calls':
      return new Error(`${PLUGIN_NAME}: title model unexpectedly requested a tool`)
    default:
      return new Error(`${PLUGIN_NAME}: unsupported finish reason "${String((finish as { kind?: unknown }).kind)}"`)
  }
}

/**
 * Produce one rules-based title revision: the accepted-shape title, the exact
 * cited message seqs, and the route used.
 *
 * @throws when no route resolves, when no eligible message fits the frame, when
 *   the stream fails or is superseded, or when the answer is not a vocabulary-led
 *   `emoji 主题` line.
 */
export async function deriveTitle(
  { policy, request, currentTitle, llm }: TitleDerivation,
): Promise<SessionTitleProviderResult> {
  const { route, reasoningEffort } = resolveTitleRoute(policy, request)
  const framed = buildTitleInput(currentTitle, request.messages)
  const signal = AbortSignal.any([request.signal, AbortSignal.timeout(TIMEOUT_MS)])
  const messages: Message[] = [createUserMessage({
    content: [{ type: 'text', text: framed.input }],
    source: { kind: 'dsh-session-title-rules' },
  })]
  // `createUserMessage` deep-freezes the message itself; freezing the wrapper array too
  // keeps the whole request graph read-only for the `llm/stream` listeners that receive
  // this same object.
  Object.freeze(messages)
  const options: GenerateOptions = Object.freeze({
    provider: route.provider,
    model: route.model,
    ...reasoningEffort === undefined ? {} : { reasoningEffort: ReasoningEffortId(reasoningEffort) },
    messages,
    system: TITLE_SYSTEM_PROMPT,
    maxTokens: MAX_OUTPUT_TOKENS,
    sessionId: request.session.id,
    purpose: 'session-title',
    signal,
  })
  signal.throwIfAborted()
  const assembler = new BlockAssembler()
  for await (const chunk of llm.stream(options)) {
    // Like the shipped provider, refuse to keep assembling a superseded or timed-out call.
    signal.throwIfAborted()
    assembler.push(chunk)
  }
  signal.throwIfAborted()
  const failure = finishError(assembler.finish)
  if (failure !== undefined) throw failure
  const blocks = assembler.blocks()
  if (blocks.some(block => block.type === 'tool-call')) {
    throw new Error(`${PLUGIN_NAME}: title output must contain text only`)
  }
  return {
    title: formatTitleOutput(textOf(blocks)),
    messageSeqs: framed.messages.map(message => message.seq),
    model: route,
  }
}
