/**
 * Rules-based session-title provider: `emoji 主题`, plus the
 * `/title-refresh` command that re-derives a title on demand.
 *
 * Replaces the built-in `session-title-first-prompt-llm` provider — the
 * `session-title-llm` Loader row this Bundle's patch disables. The service
 * still owns scheduling, result validation, and the `session/title` append;
 * this plugin owns the prompt, the framing, and the auxiliary model call.
 *
 * Unlike the shipped providers it appends no log-only `session/title-llm-request`
 * audit row: `@deepseek-ai/dsh-session-title-llm` keeps its system prompt
 * private and hardcodes its own framing, so none of its call policy is reusable
 * for these rules.
 *
 * @module @banzhe/dsh-session-title-rules
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Volatile } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { BlockAssembler, createUserMessage, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, FinishReason, GenerateOptions, Message } from '@deepseek-ai/dsh-llm'
import {
  normalizeSessionTitle,
  SessionTitleProviderId,
} from '@deepseek-ai/dsh-session-title'
import type {
  SessionTitleModelIdentity,
  SessionTitleProviderRequest,
  SessionTitleProviderResult,
  SessionTitleUserMessage,
} from '@deepseek-ai/dsh-session-title'
import { registerTitleRefreshCommand } from './command.ts'

// 0.1.7-alpha.2 removed the shared `plugin` message source: every producer now
// declares its own `kind` on `MessageSourceMap`.
declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'dsh-session-title-rules': { kind: 'dsh-session-title-rules' }
  }
}

/** Loader row id, package identity, and the provider id recorded with each title. */
export const name = 'session-title-rules'

/** Services that must exist before the provider registers. */
export const inject = ['sessionTitle', 'llm']

/**
 * Deployment policy: an explicit auxiliary route, plus the reasoning effort to
 * drive it with.
 *
 * Every field is optional AND `volatile`, which is what lets the Settings page
 * write it without restarting the plugin: the Loader hands a volatile field a
 * live reference, so the provider reads the CURRENT value at each call instead
 * of the one captured at load. Omitting all three keeps the original behaviour
 * (follow the Session's logged `request/header` route).
 *
 * The pair is validated in {@link resolveTitleRoute}, NOT by the schema: an
 * unpaired `provider`/`model` is a configuration mistake the settings page must
 * be able to explain, and a schema `required` would instead reject the whole
 * entry at load.
 */
export interface Config {
  /** Explicit auxiliary provider route; must be paired with `model`. */
  provider: Volatile<string | undefined>
  /** Explicit auxiliary model id; must be paired with `provider`. */
  model: Volatile<string | undefined>
  /** Reasoning effort for the auxiliary call; omission follows the route default. */
  reasoningEffort: Volatile<string | undefined>
}

/**
 * Live policy schema; also the `session-title-rules` settings-section shape.
 *
 * Deliberately NOT annotated `z<Config>`: the interface describes the entry's
 * runtime config with `Volatile` references, while the schema's own output type
 * is the plain field type. DSH's other live-preference plugins (`locale`,
 * `ui-settings`) keep the two apart the same way, and
 * `exactOptionalPropertyTypes` makes the annotated form unassignable.
 *
 * Each field is `volatile` on its own, so the Loader hands the plugin a live
 * reference per field rather than one snapshot of the whole section.
 */
export const Config = z.object({
  provider: z.string().volatile(),
  model: z.string().volatile(),
  reasoningEffort: z.string().volatile(),
})

/**
 * Fixed auxiliary-call policy; the Loader row's `config` carries only the route
 * above (see {@link Config}), never these caps.
 *
 * The cap must cover reasoning, not just the title line. A reasoning-enabled
 * route spends the whole budget on hidden thinking before it emits any text:
 * `@deepseek-ai/dsh-llm-pi-ai` never reads `purpose`, so the `session-title`
 * hint reaches the adapter as nothing and the profile's own effort (this
 * deployment sets `reasoning: high`) still applies. Measured on
 * `cc/deepseek-v4.1-flash` with the shipped prompt, `finish=length` with 64 of
 * 64 tokens spent reasoning: 1/20 usable at 64, versus 17/20 at 512. The
 * built-in provider's 64 (`dsh-base`, row `session-title-llm`) fails the same
 * way, and `purpose` is only honoured by `dsh-llm-deepseek`. Configuring
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

/** The single ASCII space separating the type emoji from the topic. */
const EMOJI_SEPARATOR = ' '

/**
 * The exact auxiliary route and reasoning effort one revision runs on.
 * @param config - current live policy, or `undefined` when the row carries none.
 * @param request - the service-owned request, whose `route` is the fallback.
 * @returns the route to call, with an optional explicit effort.
 * @throws when the pair is half-configured, or when neither an override nor a
 *   logged request route exists — the same refusal the provider always had,
 *   reported early instead of as a failed first model request.
 */
function resolveTitleRoute(
  config: Config | undefined,
  request: SessionTitleProviderRequest,
): { readonly route: SessionTitleModelIdentity; readonly reasoningEffort?: string } {
  const provider = config?.provider.get()
  const model = config?.model.get()
  const reasoningEffort = config?.reasoningEffort.get()
  if ((provider === undefined) !== (model === undefined)) {
    throw new Error(`${name}: provider and model must be configured together`)
  }
  if (provider !== undefined && model !== undefined) {
    return {
      route: { provider, model },
      ...reasoningEffort === undefined ? {} : { reasoningEffort },
    }
  }
  if (request.route === undefined) {
    throw new Error(`${name}: no logged request route is available for this session`)
  }
  return {
    route: request.route,
    ...reasoningEffort === undefined ? {} : { reasoningEffort },
  }
}

/** Model sentinel meaning "these messages do not identify a topic". */
const UNCHANGED = 'UNCHANGED'

/**
 * The closed type vocabulary, in prompt order. The emoji is the whole type
 * segment of the title; the Chinese label is only the gloss the prompt uses to
 * say what each emoji means. Every entry is one code point, so matching the
 * leading emoji is a `startsWith` and a slice.
 */
const TITLE_TYPES: readonly { readonly type: string; readonly emoji: string }[] = [
  { type: '功能', emoji: '✨' },
  { type: '设计', emoji: '🎨' },
  { type: '修复', emoji: '🐛' },
  { type: '优化', emoji: '⚡' },
  { type: '发布', emoji: '🚀' },
  { type: '探索', emoji: '🔍' },
  { type: '文档', emoji: '📝' },
  { type: '研究', emoji: '🔬' },
]

/**
 * What may sit between the type emoji and the topic, and be dropped: nothing,
 * an emoji-presentation selector the model appended (`⚡️` for `⚡`), whitespace,
 * or the retired `｜` separator (`🐛｜主题`). Tolerated on input only — the
 * accepted title always carries exactly one ASCII space.
 */
const EMOJI_GAP = /^(?:\uFE0F)?[\s|｜]*/u

/** The prompt's one-line gloss of the vocabulary: `✨（功能） / 🎨（设计） / …`. */
const TYPE_GLOSS = TITLE_TYPES.map(({ type, emoji }) => `${emoji}（${type}）`).join(' / ')

/** Wrapping quote pairs a model may enclose the whole line in. */
const WRAPPING_PAIRS: readonly (readonly [string, string])[] = [
  ['`', '`'],
  ['"', '"'],
  ["'", "'"],
  ['“', '”'],
  ['‘', '’'],
]

/** A model-authored date prefix (`0903｜`, `20260903 |`) this plugin strips. */
const MODEL_DATE_PREFIX = /^\d{2,8}\s*[|｜]\s*/u

/**
 * The auxiliary system prompt: the naming rules, compressed to what a provider
 * can act on. The rules this prompt drops are enforced elsewhere — "only the
 * title changes" holds structurally because a provider can append nothing but
 * `session/title`. The four examples are kept: they are the payload shape
 * (`原名称` in, `emoji 主题` out), the closed emoji vocabulary, and the shift
 * from a vague original name to a content-derived topic.
 */
export const TITLE_SYSTEM_PROMPT = [
  '为下面的 DSH 会话生成一个左侧栏标题。',
  '',
  `格式（严格）：emoji${EMOJI_SEPARATOR}主题`,
  `- emoji：只能取 ${TYPE_GLOSS} 之一，代表会话类型。`,
  '- 主题：从消息实际内容提炼，简洁具体，6–14 个汉字（英文不超过 8 词）；'
    + '不要重复项目名称（仓库名、目录名）；不要出现“会话”“标题”这类元词。',
  '- 语言：跟随消息语言；中英混排时用中文。',
  '- 原名称是当前标题，仅供参考；仍按 messages 的内容提炼主题。',
  `- 消息内容不足以判断主题时，只输出 ${UNCHANGED}。`,
  '',
  '只输出标题一行：emoji 后跟一个半角空格和主题；'
    + '不要输出“功能”“修复”这类中文类型词，不要引号、前后缀、解释、Markdown、代码、控制字符或日期前缀。',
  '',
  '示例：',
  '原名称：优化批次文字显示 → ⚡ 批次文字显示',
  '原名称：整合快捷键提示页面 → ✨ 整合快捷键提示页',
  '原名称：提交代码到 GitHub → 🚀 提交代码到GitHub',
  '原名称：新功能讨论 → 🎨 界面对齐检查',
].join('\n')

/**
 * Choose the messages one prompt carries: the first eligible human message
 * (the session's opening intent) plus the most recent ones (where the
 * conversation actually went), each text capped.
 * @param messages - every eligible human message through this revision.
 * @returns the selected messages, oldest first.
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
 * non-first message until the frame fits {@link MAX_INPUT_BYTES}.
 * @param currentTitle - the accepted title, shown to the model as `原名称`.
 * @param messages - every eligible human message through this revision.
 * @returns the framed user text and the exact messages it carried.
 * @throws when no eligible message fits the cap.
 */
function buildTitleInput(
  currentTitle: string | undefined,
  messages: readonly SessionTitleUserMessage[],
): FramedTitleInput {
  const selected = selectTitleMessages(messages)
  if (selected.length === 0) throw new Error(`${name}: at least one source message is required`)
  while (true) {
    const input = frameTitleInput(currentTitle, selected)
    if (Buffer.byteLength(input, 'utf8') <= MAX_INPUT_BYTES) return { input, messages: selected }
    // Dropping the oldest non-first message is the only reachable trim: one message is
    // capped at MAX_MESSAGE_CHARS, so its worst-case escaped frame (400 × 6 bytes, plus an
    // 80-byte title and the scaffolding) stays well under MAX_INPUT_BYTES. Reaching this
    // throw means those constants drifted apart.
    if (selected.length === 1) {
      throw new Error(`${name}: framed title input exceeds ${MAX_INPUT_BYTES} bytes`)
    }
    selected.splice(1, 1)
  }
}

/**
 * Drop one matching quote pair around the whole line, so wrapping never costs a
 * quote that belongs to the topic (`“引号”` inside backticks survives).
 * @param line - the normalized line.
 * @returns the line without its wrapping pair.
 */
function stripWrapping(line: string): string {
  const wrapped = line.length > 1
    && WRAPPING_PAIRS.some(([open, close]) => line.startsWith(open) && line.endsWith(close))
  return wrapped ? line.slice(1, -1).trim() : line
}

/**
 * Reduce one model answer to the `emoji 主题` line: the package normalizer strips
 * controls, invisible characters, and stray whitespace first, then the wrapping
 * quotes and any model-authored date prefix go.
 * @param raw - the assembled model text.
 * @returns the normalized line, possibly empty.
 */
function unwrapTitleLine(raw: string): string {
  return stripWrapping(normalizeSessionTitle(raw, Number.MAX_SAFE_INTEGER))
    .replace(MODEL_DATE_PREFIX, '')
    .trim()
}

/**
 * Read the leading type emoji of one normalized line against the closed
 * vocabulary, dropping what {@link EMOJI_GAP} tolerates between emoji and topic.
 * @param line - the normalized title line.
 * @returns the vocabulary emoji, canonical spelling, and the topic after it; or
 *   `undefined` when the line does not lead with a vocabulary emoji.
 */
function leadingType(line: string): { readonly emoji: string; readonly topic: string } | undefined {
  for (const { emoji } of TITLE_TYPES) {
    if (line.startsWith(emoji)) {
      return { emoji, topic: line.slice(emoji.length).replace(EMOJI_GAP, '') }
    }
  }
  return undefined
}

/**
 * Format the durable title from one model answer. Anything that does not lead
 * with one of the eight type emoji is refused rather than guessed at — the
 * retired `类型｜主题` shape included, because translating a type word the model
 * chose into an emoji it did not choose is this plugin inventing the type.
 * @param raw - the assembled model text.
 * @returns `emoji 主题`.
 * @throws when the model declined (`UNCHANGED`), answered with nothing, led with
 *   something other than a vocabulary emoji, or named no topic; the service then
 *   warns and keeps the title it already has.
 */
export function formatTitleOutput(raw: string): string {
  const line = unwrapTitleLine(raw)
  if (line.toUpperCase() === UNCHANGED) {
    throw new Error(`${name}: title model declined to name a topic`)
  }
  const typed = leadingType(line)
  if (typed === undefined) {
    throw new Error(`${name}: title model returned no emoji-led 主题 line`)
  }
  if (typed.topic.length === 0) {
    throw new Error(`${name}: title model returned a type emoji with no topic`)
  }
  return `${typed.emoji}${EMOJI_SEPARATOR}${typed.topic}`
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
      return new Error(`${name}: title output reached maxOutputTokens`)
    case 'tool-calls':
      return new Error(`${name}: title model unexpectedly requested a tool`)
    default:
      return new Error(`${name}: unsupported finish reason "${String((finish as { kind?: unknown }).kind)}"`)
  }
}

/**
 * Produce one rules-based title revision.
 * @param ctx - context exposing the session-title and LLM services.
 * @param config - current live route policy, or `undefined` when the row carries none.
 * @param request - the service-owned session, message snapshot, route, and cancellation.
 * @returns the accepted-shape title, the exact cited message seqs, and the route used.
 */
async function generateTitle(
  ctx: Context,
  config: Config | undefined,
  request: SessionTitleProviderRequest,
): Promise<SessionTitleProviderResult> {
  // Read the live policy on EVERY call: a volatile field is a reference, so a
  // Settings write reaches the next title without restarting the plugin.
  const { route, reasoningEffort } = resolveTitleRoute(config, request)
  // Under `first-prompt` the service has already appended its deterministic fallback,
  // so this is normally that fallback; it is shown to the model as `原名称` only.
  const currentTitle = ctx.sessionTitle.get(request.session)?.title
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
  for await (const chunk of ctx.llm.stream(options)) {
    // Like the shipped provider, refuse to keep assembling a superseded or timed-out call.
    signal.throwIfAborted()
    assembler.push(chunk)
  }
  signal.throwIfAborted()
  const failure = finishError(assembler.finish)
  if (failure !== undefined) throw failure
  const blocks = assembler.blocks()
  if (blocks.some(block => block.type === 'tool-call')) {
    throw new Error(`${name}: title output must contain text only`)
  }
  return {
    title: formatTitleOutput(textOf(blocks)),
    messageSeqs: framed.messages.map(message => message.seq),
    model: route,
  }
}

/**
 * Register the rules-based provider. `first-prompt` derives the title once, from
 * the Session's opening message: the service schedules it only for a top-level
 * Session's first eligible human message, before any title exists.
 *
 * Also contributes `/title-refresh`, which re-derives a title on demand; it
 * mounts only where a command registry is composed.
 * @param ctx - context exposing the session-title and LLM services.
 * @param config - optional explicit route policy, read live on each call.
 */
export function apply(ctx: Context, config?: Config): void {
  ctx.sessionTitle.register({
    id: SessionTitleProviderId(name),
    automatic: 'first-prompt',
    generate: request => generateTitle(ctx, config, request),
  })
  registerTitleRefreshCommand(ctx)
}
