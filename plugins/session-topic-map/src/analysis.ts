/**
 * One analysis run: which messages to read, what to ask the model, and what its
 * answer is allowed to mean.
 *
 * The module never calls a model and never touches storage — it turns a graph
 * plus the Session's event log into a framed request, and turns the answer back
 * into the per-message contributions {@link applyAnalysis} accepts. The range it
 * returns is what makes analysis incremental: it starts where the graph's
 * checkpoint ends, and it stops at the last event it actually read, so nothing
 * past that point is silently skipped.
 *
 * @module @banzhe/dsh-session-topic-map/src/analysis
 */

import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { AnalysisBatch, ProgressGraph, TopicContribution } from './progress-graph.ts'
import { normalizeTopic, topicsOf } from './progress-graph.ts'

/** Most message lines one run reads; older surplus waits for the next run. */
const MAX_LINES = 24

/** Per-line cap before framing; the analysis needs the subject, not the prose. */
const MAX_LINE_CHARS = 500

/** Framed-input cap; past it the run stops at the last line that still fits. */
const MAX_PROMPT_CHARS = 12_000

/** Longest label accepted from the model. */
const MAX_LABEL_CHARS = 40

/** One message the analysis reads. */
export interface TranscriptLine {
  /** Event seq, the number the model cites back. */
  readonly seq: number
  /** Turn in force when the message was appended. */
  readonly turn: number
  /** Who said it. */
  readonly role: 'user' | 'assistant'
  /** Visible text, already capped. */
  readonly text: string
}

/** What one run will read, and the range its checkpoint will cover. */
export interface AnalysisPlan {
  /** First event seq the run may read. */
  readonly fromSeq: number
  /** Last event seq the run covers, even when it read no message. */
  readonly toSeq: number
  /** Turn in force at {@link toSeq}. */
  readonly turn: number
  /** One line per message with text; empty when the range held none. */
  readonly lines: readonly TranscriptLine[]
}

/** One topic as the model reported it, before it is matched to a message. */
export interface RawTopic {
  /** Topic label. */
  readonly label: string
  /** Seq of the message this topic came from. */
  readonly seq: number
}

/** The visible text of one message, in block order. */
function textOf(blocks: readonly ContentBlock[]): string {
  return blocks
    .filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text')
    .map(block => block.text)
    .join(' ')
    .trim()
}

/**
 * Choose the events one run reads.
 *
 * Events the graph already covers are skipped by seq, so a resumed run continues
 * from the checkpoint instead of re-reading the conversation. Turn boundaries are
 * tracked because a user message carries no turn of its own.
 *
 * @param graph - graph before this run; its checkpoint is the cursor.
 * @param events - the Session's raw event log, ascending by seq.
 * @returns the plan, or `null` when the log holds nothing past the checkpoint.
 */
export function planAnalysis(graph: ProgressGraph, events: readonly SessionEvent[]): AnalysisPlan | null {
  const fromSeq = graph.checkpoint + 1
  const lines: TranscriptLine[] = []
  let turn = graph.turn
  let toSeq = -1
  let turnAtLast = graph.turn
  let chars = 0

  for (const event of events) {
    const seq: number = event.seq
    if (seq < fromSeq) continue
    const advance = (): void => {
      toSeq = seq
      turnAtLast = turn
    }
    if (event.type === 'turn/start') {
      turn = event.data.turn
      advance()
      continue
    }
    if (event.type !== 'user/message' && event.type !== 'assistant/message') {
      advance()
      continue
    }
    // An assistant message states its own turn, so it does not depend on having
    // seen the matching turn/start (inherited logs may not carry one).
    if (event.type === 'assistant/message') turn = event.data.turn
    if (lines.length >= MAX_LINES) break
    const content = event.type === 'user/message' ? event.data.content : event.data.message.content
    const full = textOf(content)
    if (full === '') {
      advance()
      continue
    }
    // The budget counts what the message actually said, before per-line framing,
    // but a run always reads at least one message: a single reply longer than the
    // whole budget must still be analyzed instead of being skipped forever.
    if (lines.length > 0 && chars + full.length > MAX_PROMPT_CHARS) break
    chars += full.length
    lines.push({ seq, turn, role: event.type === 'user/message' ? 'user' : 'assistant', text: full.slice(0, MAX_LINE_CHARS) })
    advance()
  }

  if (toSeq < fromSeq) return null
  return { fromSeq, toSeq, turn: turnAtLast, lines }
}

/** The system half of the analysis request: the JSON the answer must be. */
export const ANALYSIS_SYSTEM_PROMPT = [
  '你是会话主题分析器。读下面新增的会话消息，说出每条消息在推进哪些主题。',
  '只输出一个 JSON 对象，形如 {"topics":[{"label":"主题","seq":12}]}。',
  '规则：',
  '- label 是 2 到 12 个汉字的短语；',
  '- seq 必须取消息行开头的编号，不能编造；',
  '- 一条消息推进了多个主题时，为每个主题各写一项；同一个主题不要重复；',
  '- 消息延续已有主题时，label 与已有主题完全一致；',
  '- 没有可归纳的主题时输出 {"topics":[]}；',
  '- 不要输出解释、标题或代码块。',
].join('\n')

/**
 * Frame one plan as the user turn, carrying the labels already in use so the
 * model continues them instead of inventing near-duplicates.
 * @param graph - graph before this run.
 * @param plan - the range and lines this run reads.
 * @returns the framed user turn.
 */
export function renderAnalysisPrompt(graph: ProgressGraph, plan: AnalysisPlan): string {
  const topics = JSON.stringify(topicsOf(graph))
  const lines = plan.lines
    .map(line => `[seq=${line.seq} turn=${line.turn} ${line.role}] ${line.text}`)
    .join('\n')
  return `已有主题：${topics}\n新增消息：\n${lines}`
}

function jsonPayloadOf(raw: string): unknown {
  const start = raw.indexOf('{')
  const end = raw.lastIndexOf('}')
  if (start === -1 || end <= start) return null
  try {
    return JSON.parse(raw.slice(start, end + 1))
  }
  catch {
    return null
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Read the model's answer.
 *
 * A model answer is a wire boundary, so every field is checked here rather than
 * trusted: an entry is kept only when it names a non-empty label and cites a seq
 * this run actually read. A malformed envelope returns `null` — the caller must
 * not advance the checkpoint on an answer it could not read. Any field this
 * Bundle no longer uses, such as a parent label citation, is ignored: a node's
 * links are derived from topic progression, not from the model's opinion.
 *
 * @param raw - the model's visible answer, code fences included if it wrote any.
 * @param allowedSeqs - seqs this run read; the only seqs a topic may cite.
 * @returns the topics, or `null` when the envelope is unreadable.
 */
export function parseAnalysisOutput(raw: string, allowedSeqs: ReadonlySet<number>): readonly RawTopic[] | null {
  const payload = jsonPayloadOf(raw)
  if (!isRecord(payload)) return null
  const { topics } = payload
  if (!Array.isArray(topics)) return null
  const parsed: RawTopic[] = []
  for (const entry of topics) {
    if (!isRecord(entry)) continue
    const { label, seq } = entry
    if (typeof label !== 'string') continue
    const trimmed = label.trim()
    if (trimmed === '' || trimmed.length > MAX_LABEL_CHARS) continue
    if (typeof seq !== 'number' || !allowedSeqs.has(seq)) continue
    parsed.push({ label: trimmed, seq })
  }
  // A non-empty list where every entry failed validation is not an empty answer:
  // the model named topics, none of them usable, so the caller must treat the
  // answer as unreadable instead of as "nothing to report".
  if (parsed.length === 0 && topics.length > 0) return null
  return parsed
}

/**
 * Turn the model's topics into the batch {@link applyAnalysis} applies.
 *
 * Topics are grouped by the message that reported them, and each reported
 * topic becomes an independent `(seq, topic)` node when applied. Turns come from this run's
 * own transcript, never from the model: the anchor a click uses must be the one
 * the Session log recorded.
 *
 * @param plan - the range and lines this run read.
 * @param topics - parsed topics.
 * @returns the batch; an empty `topics` still advances the checkpoint.
 */
export function buildBatch(plan: AnalysisPlan, topics: readonly RawTopic[]): AnalysisBatch {
  const turns = new Map<number, number>(plan.lines.map(line => [line.seq, line.turn]))
  const labelsBySeq = new Map<number, string[]>()
  for (const topic of [...topics].sort((left, right) => left.seq - right.seq)) {
    const label = normalizeTopic(topic.label)
    if (label === '') continue
    const labels = labelsBySeq.get(topic.seq)
    if (labels === undefined) {
      labelsBySeq.set(topic.seq, [label])
      continue
    }
    if (!labels.includes(label)) labels.push(label)
  }
  const contributions: TopicContribution[] = [...labelsBySeq.entries()]
    .sort(([left], [right]) => left - right)
    .map(([seq, labels]) => ({ seq, turn: turns.get(seq) ?? plan.turn, topics: labels }))
  return { fromSeq: plan.fromSeq, toSeq: plan.toSeq, turn: plan.turn, contributions }
}

/**
 * The seqs one plan may cite.
 * @param plan - the range and lines this run read.
 * @returns every line's seq.
 */
export function allowedSeqsOf(plan: AnalysisPlan): ReadonlySet<number> {
  return new Set(plan.lines.map(line => line.seq))
}
/**
 * The turn each message event belongs to, read from the log itself.
 *
 * An assistant message states its own turn; a user message follows the last
 * `turn/start`, and a log whose inherited portion carries no such marker simply
 * contributes no entry for those messages.
 *
 * @param events - the Session's raw event log, ascending by seq.
 * @returns seq to turn, for the messages that could be resolved.
 */
export function turnsBySeqOf(events: readonly SessionEvent[]): Map<number, number> {
  const turns = new Map<number, number>()
  let turn: number | null = null
  for (const event of events) {
    if (event.type === 'turn/start') {
      turn = event.data.turn
      continue
    }
    if (event.type === 'assistant/message') {
      turn = event.data.turn
      turns.set(event.seq, event.data.turn)
      continue
    }
    if (event.type === 'user/message' && turn !== null) turns.set(event.seq, turn)
  }
  return turns
}

/**
 * Re-anchor stored nodes to the turns the log records.
 *
 * Nodes are kept as they are — only a node whose stored turn disagrees with the
 * log is replaced — so a graph whose turns already match is returned untouched.
 *
 * @param graph - the stored graph.
 * @param events - the Session's raw event log.
 * @returns the corrected graph, or `null` when nothing had to change.
 */
export function correctTurns(graph: ProgressGraph, events: readonly SessionEvent[]): ProgressGraph | null {
  const turns = turnsBySeqOf(events)
  const nodes = graph.nodes.map((node) => {
    const turn = turns.get(node.seq)
    return turn === undefined || turn === node.turn ? node : Object.freeze({ ...node, turn })
  })
  const changed = nodes.some((node, index) => node !== graph.nodes[index])
  if (!changed) return null
  return Object.freeze({ ...graph, nodes: Object.freeze(nodes) })
}
