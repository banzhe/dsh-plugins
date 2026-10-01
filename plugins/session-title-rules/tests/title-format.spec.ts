/**
 * `formatTitleOutput` / `TITLE_SYSTEM_PROMPT` contract.
 *
 * `formatTitleOutput` is the last gate between an untrusted auxiliary-model
 * answer and the durable sidebar title, so each row pins one model formatting
 * habit that disagrees with the canonical `<emoji><one ASCII space><topic>`
 * line, while separate rows assert that a `｜`, a non-vocabulary emoji, or a
 * quote pair belonging to the TOPIC is not read as formatting.
 *
 * The refusal group is the other half of the deal: the `UNCHANGED` decline
 * sentinel, empty input, a line that does not start with one of the eight
 * vocabulary emoji, and a type emoji with no topic all throw rather than
 * handing back a guessed or truncated title, and all four families share one
 * throw contract — `session-title-rules: ` plus a non-empty reason — so the
 * rows assert that shape instead of any individual wording.
 *
 * The prompt group asserts only the facts the contract fixes about
 * `TITLE_SYSTEM_PROMPT`; its prose is not asserted.
 */
import { describe, expect, it } from 'vitest'
import { formatTitleOutput, TITLE_SYSTEM_PROMPT } from '../src/prompt.ts'

/** The closed vocabulary, in prompt order, paired with the type word it replaces. */
const VOCABULARY: Array<[string, string]> = [
  ['✨', '功能'],
  ['🎨', '设计'],
  ['🐛', '修复'],
  ['⚡', '优化'],
  ['🚀', '发布'],
  ['🔍', '探索'],
  ['📝', '文档'],
  ['🔬', '研究'],
]

const VOCABULARY_EMOJI = VOCABULARY.map(([emoji]) => emoji)

/** Every refusal message carries this prefix and a non-empty reason behind it. */
const REFUSAL_PREFIX = 'session-title-rules: '

const TOPIC = '批次文字显示'

/**
 * Assert the full accepted contract for one input: the exact canonical line,
 * plus the shape it has to satisfy — exactly one vocabulary emoji, exactly one
 * ASCII space, then a non-empty topic with no stray whitespace.
 */
function expectCanonical(raw: string, expected: string): void {
  const accepted = formatTitleOutput(raw)
  expect(accepted).toBe(expected)
  expect(accepted).toBe(accepted.trim())
  expect(accepted).not.toMatch(/ {2}/)
  const gapIndex = accepted.indexOf(' ')
  expect(gapIndex).toBeGreaterThan(0)
  const emoji = accepted.slice(0, gapIndex)
  const topic = accepted.slice(gapIndex + 1)
  expect(Array.from(emoji)).toHaveLength(1)
  expect(VOCABULARY_EMOJI).toContain(emoji)
  expect(topic.length).toBeGreaterThan(0)
  expect(topic.startsWith(' ')).toBe(false)
}

/**
 * The `Error` a refused input throws. Failing here means the contract's exact
 * clause was broken, so the message names the offending input. Every refusal row
 * runs this, which is why the shape is asserted here and nowhere else.
 */
function refusalReason(raw: string): Error {
  try {
    formatTitleOutput(raw)
  } catch (error) {
    expect(error).toBeInstanceOf(Error)
    const reason = error as Error
    // A refusal is total: no exception type other than `Error` reaches the caller.
    expect(reason.name).toBe('Error')
    expect(reason.message.startsWith(REFUSAL_PREFIX)).toBe(true)
    expect(reason.message.slice(REFUSAL_PREFIX.length).length).toBeGreaterThan(0)
    return reason
  }
  throw new Error(`formatTitleOutput(${JSON.stringify(raw)}) returned instead of refusing`)
}

describe('formatTitleOutput - accepted input reduces to the canonical line', () => {
  const ACCEPTED: Array<[name: string, raw: string, expected: string]> = [
    ['an already canonical line', `⚡ ${TOPIC}`, `⚡ ${TOPIC}`],
    ['a type emoji carrying U+FE0F', `⚡\uFE0F ${TOPIC}`, `⚡ ${TOPIC}`],
    ['no gap between emoji and topic', `🐛${TOPIC}`, `🐛 ${TOPIC}`],
    ['the retired full-width separator', `🐛｜${TOPIC}`, `🐛 ${TOPIC}`],
    ['an ASCII pipe separator with a space', `🐛| ${TOPIC}`, `🐛 ${TOPIC}`],
    ['a space before the full-width separator', `🐛 ｜${TOPIC}`, `🐛 ${TOPIC}`],
    ['a separator that belongs to the topic', '🐛 批次｜文字显示', '🐛 批次｜文字显示'],
    ['internal topic whitespace', '🔍 DSH 插件 接缝', '🔍 DSH 插件 接缝'],
    ['a run of spaces inside the topic', '🔍 DSH   插件', '🔍 DSH 插件'],
    ['a tab and a newline inside the topic', '🔍 DSH\t插件\n接缝', '🔍 DSH 插件 接缝'],
    ['a backtick wrapper around the whole line', `\`🐛 ${TOPIC}\``, `🐛 ${TOPIC}`],
    ['an ASCII double-quote wrapper', `"🐛 ${TOPIC}"`, `🐛 ${TOPIC}`],
    ['a curly double-quote wrapper', `“🐛 ${TOPIC}”`, `🐛 ${TOPIC}`],
    ['quotes that belong to the topic', '`🐛 “引号”主题`', '🐛 “引号”主题'],
    ['a numeric date prefix with a full-width pipe', `0903｜🐛 ${TOPIC}`, `🐛 ${TOPIC}`],
    ['a spaced date prefix with an ASCII pipe', `20260903 | 🐛 ${TOPIC}`, `🐛 ${TOPIC}`],
    ['a NUL control character after the gap', `🐛 \u0000${TOPIC}`, `🐛 ${TOPIC}`],
    ['a topic led by a non-vocabulary emoji', '🐛 🔧 修按钮', '🐛 🔧 修按钮'],
  ]

  it.each(ACCEPTED)('accepts %s', (_name, raw, expected) => {
    expectCanonical(raw, expected)
  })

  describe('the closed type vocabulary', () => {
    it.each(VOCABULARY)('accepts %s as the marker for the %s type', (emoji) => {
      expectCanonical(`${emoji} ${TOPIC}`, `${emoji} ${TOPIC}`)
    })
  })

  describe('invisible and control characters', () => {
    const INVISIBLE: Array<[name: string, character: string]> = [
      ['U+0000', '\u0000'],
      ['U+0008', '\u0008'],
      ['U+000B', '\u000B'],
      ['U+000C', '\u000C'],
      ['U+000E', '\u000E'],
      ['U+001F', '\u001F'],
      ['U+007F', '\u007F'],
      ['U+0085', '\u0085'],
      ['U+009F', '\u009F'],
      ['U+200B', '\u200B'],
      ['U+200E', '\u200E'],
      ['U+200F', '\u200F'],
      ['U+202A', '\u202A'],
      ['U+202E', '\u202E'],
      ['U+2060', '\u2060'],
      ['U+2064', '\u2064'],
      ['U+2066', '\u2066'],
      ['U+206F', '\u206F'],
      ['U+FEFF', '\uFEFF'],
    ]

    it.each(INVISIBLE)('strips %s before matching the line', (_name, character) => {
      expectCanonical(`🐛 ${character}${TOPIC}`, `🐛 ${TOPIC}`)
    })
  })
})

describe('formatTitleOutput - refused input throws instead of guessing', () => {
  const DECLINE: Array<[name: string, raw: string]> = [
    ['the decline sentinel UNCHANGED', 'UNCHANGED'],
    ['the lowercase decline sentinel unchanged', 'unchanged'],
    ['the mixed-case decline sentinel Unchanged', 'Unchanged'],
  ]

  const EMPTY: Array<[name: string, raw: string]> = [
    ['an empty string', ''],
    ['a space-only string', '   '],
    ['a tab and a newline only', '\n\t '],
  ]

  const NO_VOCABULARY_EMOJI: Array<[name: string, raw: string]> = [
    ['the retired text-type shape', '研究｜会话标题插件接缝'],
    ['a Chinese type word with an ASCII pipe', '修复|批次文字显示'],
    ['a Chinese type word with spaces', '优化 | 批次文字显示'],
    ['a leading glyph outside the vocabulary', `🔧 ${TOPIC}`],
    ['an ASCII prose prefix', `Fix: ${TOPIC}`],
    ['plain text with no emoji at all', TOPIC],
  ]

  const NO_TOPIC: Array<[name: string, raw: string]> = [
    ['a bare vocabulary emoji', '🐛'],
    ['a vocabulary emoji and a trailing space', '🐛 '],
    ['a vocabulary emoji and a bare separator', '🐛｜'],
  ]

  const REFUSALS: Array<[name: string, raw: string]> = [...DECLINE, ...EMPTY, ...NO_VOCABULARY_EMOJI, ...NO_TOPIC]

  it.each(REFUSALS)('refuses %s', (_name, raw) => {
    // The whole refusal shape — an `Error`, carrying the prefix and a non-empty
    // reason, and never a returned title — is asserted inside `refusalReason`,
    // which throws rather than returning when `formatTitleOutput` answers.
    refusalReason(raw)
  })
})

describe('TITLE_SYSTEM_PROMPT', () => {
  it.each(VOCABULARY)('names %s for the %s type', (emoji) => {
    expect(TITLE_SYSTEM_PROMPT).toContain(emoji)
  })

  it('carries the UNCHANGED decline sentinel', () => {
    expect(TITLE_SYSTEM_PROMPT).toContain('UNCHANGED')
  })

  it('writes its examples as 原名称 lines mapping onto emoji + one space + topic', () => {
    const emoji = VOCABULARY_EMOJI.join('|')
    const exampleLine = new RegExp(`原名称.*→\\s*(?:${emoji}) \\S`, 'u')
    const examples = TITLE_SYSTEM_PROMPT.split('\n').filter(line => exampleLine.test(line))
    expect(examples.length).toBeGreaterThanOrEqual(3)
  })

  it('tells the model not to emit the Chinese type words', () => {
    expect(TITLE_SYSTEM_PROMPT).toContain('不要输出')
    expect(/功能|修复/.test(TITLE_SYSTEM_PROMPT)).toBe(true)
  })
})
