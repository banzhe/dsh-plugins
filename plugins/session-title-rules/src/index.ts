/**
 * Rules-based session-title provider: `MMDD｜类型｜主题`, plus the
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
import { BlockAssembler, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, FinishReason, GenerateOptions, Message } from '@deepseek-ai/dsh-llm'
import {
  normalizeSessionTitle,
  SessionTitleProviderId,
} from '@deepseek-ai/dsh-session-title'
import type {
  SessionTitleProviderRequest,
  SessionTitleProviderResult,
  SessionTitleUserMessage,
} from '@deepseek-ai/dsh-session-title'
import { registerTitleRefreshCommand } from './command.ts'

/** Loader row id, package identity, and the provider id recorded with each title. */
export const name = 'session-title-rules'

/** Services that must exist before the provider registers. */
export const inject = ['sessionTitle', 'llm']

/** IANA zone the `MMDD` prefix is computed in. */
const TITLE_TIME_ZONE = 'Asia/Shanghai'

/** Fixed auxiliary-call policy; the Loader row carries no `config`. */
const MAX_OUTPUT_TOKENS = 64
/** End-to-end deadline for one auxiliary title call. */
const TIMEOUT_MS = 60_000
/** Framed-input byte cap; past it the oldest messages are dropped. */
const MAX_INPUT_BYTES = 6000
/** Most messages one prompt carries (the first one is always included). */
const MAX_SELECTED_MESSAGES = 8
/** Per-message character cap before framing. */
const MAX_MESSAGE_CHARS = 400

/** The `｜` separating the title's three segments. */
const SEPARATOR = '｜'

/** Model sentinel meaning "these messages do not identify a topic". */
const UNCHANGED = 'UNCHANGED'

/** The closed set of allowed 类型 values, in prompt order. */
const TYPE_VALUES = ['功能', '设计', '修复', '优化', '发布', '探索', '文档', '研究'] as const

/** Wrapping quote pairs a model may enclose the whole line in. */
const WRAPPING_PAIRS: readonly (readonly [string, string])[] = [
  ['`', '`'],
  ['"', '"'],
  ["'", "'"],
  ['“', '”'],
  ['‘', '’'],
]

/** A model-authored date prefix (`0903｜`, `20260903 |`) this plugin overwrites. */
const MODEL_DATE_PREFIX = /^\d{2,8}\s*[|｜]\s*/u

/** `MMDD` for {@link TITLE_TIME_ZONE}, built once per process rather than per call. */
const TITLE_DATE_FORMAT = new Intl.DateTimeFormat('en-US', {
  timeZone: TITLE_TIME_ZONE,
  month: '2-digit',
  day: '2-digit',
})

/**
 * The auxiliary system prompt: the naming rules, compressed to what a provider
 * can act on. The rules this prompt drops are enforced elsewhere — `createdAt`
 * arithmetic is done in code (the model only copies `date`), and "only the title
 * changes" holds structurally because a provider can append nothing but
 * `session/title`. The four examples are kept: they are the payload shape
 * (`原名称` in, `MMDD｜类型｜主题` out), the closed 类型 set, and the shift from a
 * vague original name to a content-derived topic.
 */
export const TITLE_SYSTEM_PROMPT = [
  '为下面的 DSH 会话生成一个左侧栏标题。',
  '',
  `格式（严格）：MMDD${SEPARATOR}类型${SEPARATOR}主题`,
  `- 类型：只能取 ${TYPE_VALUES.join(' / ')} 之一。`,
  '- MMDD：原样复制给定的 date，不要自己推算。',
  '- 主题：从消息实际内容提炼，简洁具体，6–14 个汉字（英文不超过 8 词）；'
    + '不要重复项目名称（仓库名、目录名）；不要出现“会话”“标题”这类元词。',
  '- 语言：跟随消息语言；中英混排时用中文。',
  '- 原名称是当前标题，仅供参考；仍按 messages 的内容提炼主题。',
  `- 消息内容不足以判断主题时，只输出 ${UNCHANGED}。`,
  '',
  '只输出标题一行：不要引号、前后缀、解释、Markdown、代码或控制字符。',
  '',
  '示例：',
  '原名称：优化批次文字显示 → 0903｜优化｜批次文字显示',
  '原名称：整合快捷键提示页面 → 0902｜功能｜整合快捷键提示页',
  '原名称：提交代码到 GitHub → 0813｜发布｜提交代码到GitHub',
  '原名称：新功能讨论 → 0901｜设计｜界面对齐检查',
].join('\n')

/**
 * Format the `MMDD` prefix for one session creation instant in
 * {@link TITLE_TIME_ZONE}. The date is computed here rather than by the model
 * so the rule cannot drift with the model's own clock or locale.
 * @param createdAt - the session header's Unix epoch milliseconds.
 * @returns the four `MMDD` digits, e.g. `'0916'`.
 */
export function formatTitleDate(createdAt: number): string {
  // `en-US` with 2-digit month and day renders `MM/DD`; the separator is the
  // locale's, so the digits are what this reads.
  return TITLE_DATE_FORMAT.format(new Date(createdAt)).replace(/\D/gu, '')
}

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
  date: string,
  currentTitle: string | undefined,
  messages: readonly SessionTitleUserMessage[],
): string {
  const payload = {
    date,
    timeZone: TITLE_TIME_ZONE,
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
 * @param date - the code-computed `MMDD` prefix.
 * @param currentTitle - the accepted title, shown to the model as `原名称`.
 * @param messages - every eligible human message through this revision.
 * @returns the framed user text and the exact messages it carried.
 * @throws when no eligible message fits the cap.
 */
function buildTitleInput(
  date: string,
  currentTitle: string | undefined,
  messages: readonly SessionTitleUserMessage[],
): FramedTitleInput {
  const selected = selectTitleMessages(messages)
  if (selected.length === 0) throw new Error(`${name}: at least one source message is required`)
  while (true) {
    const input = frameTitleInput(date, currentTitle, selected)
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
 * Reduce one model answer to the `类型｜主题` line: the package normalizer strips
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
 * Format the durable title from one model answer. The date always comes from
 * {@link formatTitleDate}, so a model-authored or omitted date cannot reach the
 * log, and anything that is not a `类型｜主题` line is refused rather than
 * guessed at.
 * @param raw - the assembled model text.
 * @param date - the code-computed `MMDD` prefix.
 * @returns `MMDD｜类型｜主题`.
 * @throws when the model declined (`UNCHANGED`), answered with nothing, or did
 *   not return a two-segment line; the service then warns and keeps the title it
 *   already has.
 */
export function formatTitleOutput(raw: string, date: string): string {
  const line = unwrapTitleLine(raw)
  if (line.toUpperCase() === UNCHANGED) {
    throw new Error(`${name}: title model declined to name a topic`)
  }
  if (!line.includes(SEPARATOR)) {
    throw new Error(`${name}: title model returned no 类型${SEPARATOR}主题 line`)
  }
  return `${date}${SEPARATOR}${line}`
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
 * @param request - the service-owned session, message snapshot, route, and cancellation.
 * @returns the accepted-shape title, the exact cited message seqs, and the route used.
 */
async function generateTitle(
  ctx: Context,
  request: SessionTitleProviderRequest,
): Promise<SessionTitleProviderResult> {
  const route = request.route
  if (route === undefined) {
    throw new Error(`${name}: no logged request route is available for this session`)
  }
  const date = formatTitleDate(request.session.header.createdAt)
  // Under `first-prompt` the service has already appended its deterministic fallback,
  // so this is normally that fallback; it is shown to the model as `原名称` only.
  const currentTitle = ctx.sessionTitle.get(request.session)?.title
  const framed = buildTitleInput(date, currentTitle, request.messages)
  const signal = AbortSignal.any([request.signal, AbortSignal.timeout(TIMEOUT_MS)])
  const messages: Message[] = [createUserMessage({
    content: [{ type: 'text', text: framed.input }],
    source: { kind: 'plugin', plugin: name },
  })]
  // `createUserMessage` deep-freezes the message itself; freezing the wrapper array too
  // keeps the whole request graph read-only for the `llm/stream` listeners that receive
  // this same object.
  Object.freeze(messages)
  const options: GenerateOptions = Object.freeze({
    provider: route.provider,
    model: route.model,
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
    title: formatTitleOutput(textOf(blocks), date),
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
 */
export function apply(ctx: Context): void {
  ctx.sessionTitle.register({
    id: SessionTitleProviderId(name),
    automatic: 'first-prompt',
    generate: request => generateTitle(ctx, request),
  })
  registerTitleRefreshCommand(ctx)
}
