/**
 * The route owns the call; this module owns the prompt and the answer.
 *
 * The two prompts restate the git-message-zh and git-message-en skills: a
 * Conventional Commit subject in the requested language, with a body only when
 * the diff needs one. Drafting never commits — the panel fills the field and
 * the user decides.
 */

import { BlockAssembler, createUserMessage, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, FinishReason, GenerateOptions, Message, StreamChunk } from '@deepseek-ai/dsh-llm'
import type { GitMessageLanguage } from './shared.ts'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'dsh-git': { kind: 'dsh-git' }
  }
}

/** The one capability this module needs: the host's model stream. */
export interface MessageModel {
  stream(options: GenerateOptions): AsyncIterable<StreamChunk>
}

export interface MessageDraft {
  readonly diff: string
  readonly language: GitMessageLanguage
  readonly provider: string
  readonly model: string
  readonly reasoningEffort?: string | undefined
  readonly llm: MessageModel
}

/** The draft sets no output-token cap. */
const TIMEOUT_MS = 60_000

/** The type list, written once so the prompt and the subject check cannot drift. */
const TYPES = ['feat', 'fix', 'refactor', 'perf', 'test', 'docs', 'style', 'build', 'ci', 'chore', 'revert'] as const

/** A Conventional Commit subject line, the one shape the field will accept. */
const SUBJECT = new RegExp(`^(${TYPES.join('|')})(\\([^)\\n]+\\))?: \\S`, 'u')

/**
 * It rides in the user turn: the model this panel drafts with treats the system
 * slot as weak and answers from the user turn. The system prompt repeats it.
 */
const RULES: Record<GitMessageLanguage, string> = {
  zh: [
    `第一行必须是 \`type: 主题\` 或 \`type(scope): 主题\`，type 只能是 ${TYPES.join('、')} 之一。`,
    '主题用自然的动宾短语，例如“新增”“修复”“调整”“移除”，通常不超过 50 个汉字。',
    '不要写“更新代码”“修改文件”这类空泛主题。',
    '只有 diff 需要补充背景、迁移或风险时才加正文，正文与主题之间空一行。',
    '只输出这一条说明，不要标题、解释、候选列表或代码块。',
  ].join('\n'),
  en: [
    `The first line must be \`type: subject\` or \`type(scope): subject\`, where type is one of ${TYPES.join(', ')}.`,
    'Write the subject in imperative mood, usually under 72 characters, with a concrete verb such as add, fix, adjust, remove, or refactor.',
    'Never write "update files" or "change code".',
    'Add a body only when the diff needs context, a migration note, or a risk, separated from the subject by one blank line.',
    'Output only that one message. No heading, no explanation, no candidate list, no code fence.',
  ].join('\n'),
}

const ASKS: Record<GitMessageLanguage, (diff: string) => string> = {
  zh: (diff) => `根据下面的 diff 写一条中文提交说明。\n${RULES.zh}\n\n${diff}`,
  en: (diff) => `Write one English commit message for the diff below.\n${RULES.en}\n\n${diff}`,
}

const PROMPTS: Record<GitMessageLanguage, string> = {
  zh: `你是提交说明起草器。根据用户给出的 diff 写一条中文提交说明。\n${RULES.zh}`,
  en: `You draft commit messages. Write one English commit message from the diff.\n${RULES.en}`,
}

/** Reasoning is kept apart from the visible answer. */
function textOf(blocks: readonly ContentBlock[], type: 'text' | 'reasoning'): string {
  return blocks
    .filter((block): block is Extract<ContentBlock, { type: typeof type }> => block.type === type)
    .map((block) => block.text)
    .join('')
    .trim()
}

function unwrapped(text: string): string {
  const fence = /^```[^\n]*\n([\s\S]*?)\n```$/u.exec(text)
  if (fence?.[1] !== undefined) return fence[1].trim()
  const ticks = /^`([^`\n]+)`$/u.exec(text)
  return (ticks?.[1] ?? text).trim()
}

/**
 * The visible answer wins when it is a commit message. A reasoning model often
 * writes the real message inside its thinking and emits a one-line paraphrase
 * as the answer; that paraphrase is dropped in favour of the last Conventional
 * Commit line the thinking actually settled on, body included.
 */
function messageOf(blocks: readonly ContentBlock[]): string {
  const visible = unwrapped(textOf(blocks, 'text'))
  if (SUBJECT.test(visible)) return visible
  return conventionalOf(textOf(blocks, 'reasoning')) ?? visible
}

/**
 * Reasoning restates the message several times, so the last subject line is the
 * one it settled on. The blank line between that subject and its body is part
 * of the message; the blank line after the body ends it.
 */
function conventionalOf(text: string): string | null {
  const lines = text.split('\n')
  let start = -1
  for (let index = 0; index < lines.length; index += 1) {
    if (SUBJECT.test(lines[index]?.trim() ?? '')) start = index
  }
  const subject = start === -1 ? undefined : lines[start]
  if (subject === undefined) return null
  const body = lines.slice(start + 1)
  const end = body.findIndex((line, index) => index > 0 && line.trim() === '')
  return [subject, ...(end === -1 ? body : body.slice(0, end))].join('\n').trim()
}

function finishError(finish: FinishReason): string | null {
  switch (finish.kind) {
    case 'stop':
      return null
    case 'max-tokens':
      return 'the draft ran out of output tokens'
    case 'tool-calls':
      return 'the draft requested a tool'
    case 'error':
    case 'aborted':
      return finish.failure.message
    default:
      return 'the draft ended unexpectedly'
  }
}

export async function draftMessage(draft: MessageDraft): Promise<string> {
  const signal = AbortSignal.timeout(TIMEOUT_MS)
  const messages: Message[] = [createUserMessage({
    content: [{ type: 'text', text: ASKS[draft.language](draft.diff) }],
    source: { kind: 'dsh-git' },
  })]
  const options: GenerateOptions = {
    provider: draft.provider,
    model: draft.model,
    ...draft.reasoningEffort === undefined ? {} : { reasoningEffort: ReasoningEffortId(draft.reasoningEffort) },
    messages,
    system: PROMPTS[draft.language],
    signal,
  }
  const assembler = new BlockAssembler()
  for await (const chunk of draft.llm.stream(options)) {
    signal.throwIfAborted()
    assembler.push(chunk)
  }
  const failure = finishError(assembler.finish)
  if (failure !== null) throw new Error(failure)
  const message = messageOf(assembler.blocks())
  if (message === '') throw new Error('the draft was empty')
  return message
}
