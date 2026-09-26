/**
 * The model-facing half of title derivation: the closed type vocabulary, the
 * auxiliary system prompt, and the one gate that reduces an untrusted model
 * answer to the canonical `emoji 主题` line.
 *
 * This is an INTERNAL seam. Nothing outside this Bundle calls it, so the package
 * root does not export it; `title-format.spec.ts` imports it by source path. It
 * is a module rather than a section of `title.ts` because the formatting rules
 * are a contract with the model — sixty-odd cases pin model habits — while
 * `title.ts` is the call orchestration around them.
 */

import { normalizeSessionTitle } from '@deepseek-ai/dsh-session-title'

/** Loader row id, package identity, and the error prefix every refusal carries. */
export const PLUGIN_NAME = 'session-title-rules'

/** The single ASCII space separating the type emoji from the topic. */
const EMOJI_SEPARATOR = ' '

/** Model sentinel meaning "these messages do not identify a topic". */
const UNCHANGED = 'UNCHANGED'

/**
 * The closed type vocabulary, in prompt order. The emoji is the whole type
 * segment of the title; the Chinese label is only the gloss the prompt uses to
 * say what each emoji means.
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
 * can act on. The rules it drops are enforced elsewhere — "only the title
 * changes" holds structurally because a provider can append nothing but
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
 * Drop one matching quote pair around the whole line, so wrapping never costs a
 * quote that belongs to the topic (`“引号”` inside backticks survives).
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
 */
function unwrapTitleLine(raw: string): string {
  return stripWrapping(normalizeSessionTitle(raw, Number.MAX_SAFE_INTEGER))
    .replace(MODEL_DATE_PREFIX, '')
    .trim()
}

/**
 * Read the leading type emoji against the closed vocabulary, dropping what
 * `EMOJI_GAP` tolerates between emoji and topic. Undefined when the line does
 * not lead with a vocabulary emoji.
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
 *
 * Throws when the model declined (`UNCHANGED`), answered with nothing, led with
 * something other than a vocabulary emoji, or named no topic; the service then
 * warns and keeps the title it already has.
 */
export function formatTitleOutput(raw: string): string {
  const line = unwrapTitleLine(raw)
  if (line.toUpperCase() === UNCHANGED) {
    throw new Error(`${PLUGIN_NAME}: title model declined to name a topic`)
  }
  const typed = leadingType(line)
  if (typed === undefined) {
    throw new Error(`${PLUGIN_NAME}: title model returned no emoji-led 主题 line`)
  }
  if (typed.topic.length === 0) {
    throw new Error(`${PLUGIN_NAME}: title model returned a type emoji with no topic`)
  }
  return `${typed.emoji}${EMOJI_SEPARATOR}${typed.topic}`
}
