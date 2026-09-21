/**
 * `formatTitleOutput` / `TITLE_SYSTEM_PROMPT` contract.
 *
 * `formatTitleOutput` is the last gate between an untrusted auxiliary-model
 * answer and the durable sidebar title, so the interesting cases are the ones
 * where model formatting habits disagree with the canonical
 * `<emoji><one ASCII space><topic>` line: an emoji-presentation selector, a
 * missing gap, the retired `｜`/`|` separator, a model-authored date prefix, a
 * wrapping quote pair, and control or invisible characters smuggled in with the
 * text. The topic itself has to survive verbatim, which is why separate rows
 * assert that a `｜` inside the topic, a non-vocabulary emoji leading the topic,
 * and a quote pair that belongs to the topic are NOT read as formatting.
 *
 * The refusal group pins the other half of the deal: the `UNCHANGED` decline
 * sentinel, empty input, a line that does not start with one of the eight
 * vocabulary emoji (including the retired `研究｜…` text-type shape), and a type
 * emoji with no topic at all. All four families throw rather than handing back a
 * guessed or truncated title, and they share one throw contract —
 * `session-title-rules: ` followed by a non-empty reason — so the rows assert
 * that shape instead of any individual wording.
 *
 * The prompt group asserts only the facts the contract fixes about
 * `TITLE_SYSTEM_PROMPT`: the vocabulary it must name, the output shape, the
 * decline sentinel, the example-line shape, and the "do not emit the Chinese
 * type words" instruction. Its prose is not asserted.
 */
import { describe, expect, it } from 'vitest'
import { formatTitleOutput, TITLE_SYSTEM_PROMPT } from '../src/index.ts'

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
 * clause was broken, so the message names the offending input.
 */
function refusalReason(raw: string): Error {
  try {
    formatTitleOutput(raw)
  } catch (error) {
    expect(error).toBeInstanceOf(Error)
    const reason = error as Error
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

  it('drops the U+FE0F selector instead of carrying it into the title', () => {
    const accepted = formatTitleOutput(`⚡\uFE0F ${TOPIC}`)
    expect(accepted).not.toContain('\uFE0F')
    expect(accepted).toBe(`⚡ ${TOPIC}`)
  })

  it('emits exactly one ASCII space between the emoji and the topic', () => {
    // A single space is the only admitted separator, so the retired
    // full-width pipe surrounded by spaces collapses to one U+0020.
    const accepted = formatTitleOutput(`🐛 ｜${TOPIC}`)
    expect(accepted.split(' ')).toEqual(['🐛', TOPIC])
  })

  describe('the closed type vocabulary', () => {
    it.each(VOCABULARY)('accepts %s as the marker for the %s type', (emoji) => {
      expectCanonical(`${emoji} ${TOPIC}`, `${emoji} ${TOPIC}`)
    })

    it.each(VOCABULARY)('normalizes %s written with no gap', (emoji) => {
      expectCanonical(`${emoji}${TOPIC}`, `${emoji} ${TOPIC}`)
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

  it.each(REFUSALS)('refuses %s', (name, raw) => {
    expect(() => formatTitleOutput(raw), name).toThrow(Error)
    // Non-Error throws and messages missing the shared prefix both surface here.
    expect(refusalReason(raw).message).toContain(REFUSAL_PREFIX)
  })

  it('reports every refusal reason under the package prefix', () => {
    // The prefix is the only wording contract; the reason behind it must be
    // present but is deliberately not asserted.
    for (const [, raw] of REFUSALS) {
      const reason = refusalReason(raw)
      expect(reason.message.startsWith(REFUSAL_PREFIX)).toBe(true)
      expect(reason.message.length).toBeGreaterThan(REFUSAL_PREFIX.length)
    }
  })

  it('never returns a partial title for a refused line', () => {
    // A refusal is total: no `🐛`-only consolation title and no exception type
    // other than `Error` reaches the caller.
    for (const [, raw] of REFUSALS) {
      let accepted: string | undefined
      try {
        accepted = formatTitleOutput(raw)
      } catch (error) {
        expect(error).toBeInstanceOf(Error)
        expect((error as Error).name).toBe('Error')
      }
      expect(accepted).toBeUndefined()
    }
  })
})

describe('TITLE_SYSTEM_PROMPT', () => {
  it('is a non-empty string', () => {
    expect(typeof TITLE_SYSTEM_PROMPT).toBe('string')
    expect(TITLE_SYSTEM_PROMPT.length).toBeGreaterThan(0)
    expect(TITLE_SYSTEM_PROMPT.trim().length).toBeGreaterThan(0)
  })

  it.each(VOCABULARY)('names %s for the %s type', (emoji) => {
    expect(TITLE_SYSTEM_PROMPT).toContain(emoji)
  })

  it('states the emoji + one ASCII space + 主题 output shape', () => {
    expect(TITLE_SYSTEM_PROMPT).toContain('emoji')
    expect(TITLE_SYSTEM_PROMPT).toContain('主题')
  })

  it('carries the UNCHANGED decline sentinel', () => {
    expect(TITLE_SYSTEM_PROMPT).toContain('UNCHANGED')
  })

  it('carries at least three example lines containing the arrow', () => {
    const examples = TITLE_SYSTEM_PROMPT.split('\n').filter(line => line.includes('→'))
    expect(examples.length).toBeGreaterThanOrEqual(3)
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
