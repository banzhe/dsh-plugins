import { createAssistantMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionSeq, type SessionEvent } from '@deepseek-ai/dsh-session'
import { describe, expect, it } from 'vitest'
import {
  ANALYSIS_SYSTEM_PROMPT,
  allowedSeqsOf,
  buildBatch,
  correctTurns,
  parseAnalysisOutput,
  planAnalysis,
  renderAnalysisPrompt,
  turnsBySeqOf,
  type AnalysisPlan,
} from '../src/analysis.ts'
import { applyAnalysis, EMPTY_PROGRESS_GRAPH, type ProgressGraph } from '../src/progress-graph.ts'

function userMessage(seq: number, text: string): SessionEvent<'user/message'> {
  return {
    type: 'user/message',
    seq: SessionSeq(seq),
    time: 0,
    surfaceOp: 'append',
    data: createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }),
  }
}

function assistantMessage(seq: number, turn: number, text: string): SessionEvent<'assistant/message'> {
  return {
    type: 'assistant/message',
    seq: SessionSeq(seq),
    time: 0,
    surfaceOp: 'append',
    data: {
      turn,
      step: 1,
      message: createAssistantMessage({ content: [{ type: 'text', text }], source: { provider: 'p', model: 'm' } }),
      stream: [],
    },
  }
}

function turnStart(seq: number, turn: number): SessionEvent<'turn/start'> {
  return { type: 'turn/start', seq: SessionSeq(seq), time: 0, data: { turn } }
}

function stepEnd(seq: number): SessionEvent<'step/end'> {
  return { type: 'step/end', seq: SessionSeq(seq), time: 0, data: { turn: 1, step: 1 } }
}

function graphAt(checkpoint: number, turn = 1): ProgressGraph {
  return { ...EMPTY_PROGRESS_GRAPH, checkpoint, turn }
}

describe('planAnalysis', () => {
  it('returns null when no event sits past the checkpoint', () => {
    expect(planAnalysis(graphAt(3), [userMessage(0, '嗨'), userMessage(3, '嗨')])).toBeNull()
  })

  it('returns null for an empty log', () => {
    expect(planAnalysis(EMPTY_PROGRESS_GRAPH, [])).toBeNull()
  })

  it('reads from the checkpoint onward and tracks the turn from turn/start', () => {
    const plan = planAnalysis(EMPTY_PROGRESS_GRAPH, [
      turnStart(0, 7),
      userMessage(1, '把右侧面板做成主题图'),
      assistantMessage(2, 7, '好的'),
    ])
    expect(plan).not.toBeNull()
    expect(plan?.fromSeq).toBe(0)
    expect(plan?.toSeq).toBe(2)
    expect(plan?.turn).toBe(7)
    expect(plan?.lines).toEqual([
      { seq: 1, turn: 7, role: 'user', text: '把右侧面板做成主题图' },
      { seq: 2, turn: 7, role: 'assistant', text: '好的' },
    ])
  })

  it('takes an assistant line turn from its own event even without any turn/start', () => {
    const plan = planAnalysis(EMPTY_PROGRESS_GRAPH, [
      userMessage(1, '提问'),
      assistantMessage(2, 9, '回答'),
    ])
    expect(plan?.lines.map(line => [line.seq, line.turn, line.role])).toEqual([
      [1, 0, 'user'],
      [2, 9, 'assistant'],
    ])
  })

  it('starts from the graph turn and carries it when no turn/start arrives', () => {
    const plan = planAnalysis(graphAt(0, 4), [userMessage(1, '继续')])
    expect(plan?.turn).toBe(4)
    expect(plan?.lines[0]?.turn).toBe(4)
  })

  it('does not re-read messages at or before the checkpoint', () => {
    const plan = planAnalysis(graphAt(2), [userMessage(1, '旧'), assistantMessage(2, 1, '旧'), userMessage(3, '新')])
    expect(plan?.lines.map(line => line.text)).toEqual(['新'])
    expect(plan?.fromSeq).toBe(3)
  })

  it('caps the plan at 24 lines and reports the last included seq', () => {
    const events = Array.from({ length: 30 }, (_, index) => userMessage(index, `消息 ${index}`))
    const plan = planAnalysis(EMPTY_PROGRESS_GRAPH, events)
    expect(plan?.lines).toHaveLength(24)
    expect(plan?.toSeq).toBe(23)
  })

  it('stops before exceeding 12000 accumulated characters', () => {
    const long = 'x'.repeat(5000)
    const plan = planAnalysis(EMPTY_PROGRESS_GRAPH, [
      userMessage(0, long),
      userMessage(1, long),
      userMessage(2, long),
    ])
    expect(plan?.lines).toHaveLength(2)
  })

  it('advances the covered range over non-message events without a line', () => {
    const plan = planAnalysis(EMPTY_PROGRESS_GRAPH, [stepEnd(0), stepEnd(1)])
    expect(plan).not.toBeNull()
    expect(plan?.lines).toEqual([])
    expect(plan?.toSeq).toBe(1)
  })

  it('skips a message whose visible text is empty but keeps the later ones', () => {
    const plan = planAnalysis(EMPTY_PROGRESS_GRAPH, [userMessage(0, ''), userMessage(1, '有内容')])
    expect(plan?.lines.map(line => line.seq)).toEqual([1])
    expect(plan?.toSeq).toBe(1)
  })
})

describe('renderAnalysisPrompt', () => {
  const plan: AnalysisPlan = {
    fromSeq: 1,
    toSeq: 2,
    turn: 1,
    lines: [
      { seq: 1, turn: 1, role: 'user', text: '第一条' },
      { seq: 2, turn: 1, role: 'assistant', text: '第二条' },
    ],
  }

  it('lists the labels already in use as a JSON array and one line per transcript row', () => {
    const graph = applyAnalysis(EMPTY_PROGRESS_GRAPH, {
      fromSeq: 0,
      toSeq: 0,
      turn: 1,
      contributions: [{ seq: 0, turn: 1, topics: ['主题图'] }],
    })
    const prompt = renderAnalysisPrompt(graph, plan)
    expect(prompt).toContain(JSON.stringify(['主题图']))
    expect(prompt).toContain('[seq=1 turn=1 user] 第一条')
    expect(prompt).toContain('[seq=2 turn=1 assistant] 第二条')
  })

  it('includes only the lines of the plan, never text outside it', () => {
    const graph = applyAnalysis(EMPTY_PROGRESS_GRAPH, {
      fromSeq: 0,
      toSeq: 0,
      turn: 1,
      contributions: [{ seq: 0, turn: 1, topics: ['主题图'] }],
    })
    const prompt = renderAnalysisPrompt(graph, { ...plan, lines: [plan.lines[0] as AnalysisPlan['lines'][number]] })
    expect(prompt).toContain('第一条')
    expect(prompt).not.toContain('第二条')
  })
})

describe('ANALYSIS_SYSTEM_PROMPT', () => {
  it('asks for the topics object, reuse of labels, multi-topic entries, empty answer, and no prose or code fences', () => {
    expect(ANALYSIS_SYSTEM_PROMPT).toContain('{"topics":[{"label":"主题","seq":12}]}')
    expect(ANALYSIS_SYSTEM_PROMPT).toContain('{"topics":[]}')
    expect(ANALYSIS_SYSTEM_PROMPT).toMatch(/代码块|code fence/)
    expect(ANALYSIS_SYSTEM_PROMPT).toMatch(/多个|several/)
    expect(ANALYSIS_SYSTEM_PROMPT).toMatch(/已有|现有|existing/)
  })
})

describe('parseAnalysisOutput', () => {
  const allowed = new Set([4, 5])

  it('reads a fenced answer and trims labels', () => {
    const raw = '```json\n{"topics":[{"label":" 主题图 ","seq":4}]}\n```'
    expect(parseAnalysisOutput(raw, allowed)).toEqual([{ label: '主题图', seq: 4 }])
  })

  it('reads a bare JSON answer surrounded by prose', () => {
    const raw = '结果如下：{"topics":[{"label":"持久化","seq":5}]} 以上。'
    expect(parseAnalysisOutput(raw, allowed)).toEqual([{ label: '持久化', seq: 5 }])
  })

  it('drops a topic whose seq was not in the allowed set', () => {
    const raw = '{"topics":[{"label":"主题图","seq":99},{"label":"持久化","seq":5}]}'
    expect(parseAnalysisOutput(raw, allowed)).toEqual([{ label: '持久化', seq: 5 }])
  })

  it('drops an empty label and a label longer than 40 characters', () => {
    const long = 'a'.repeat(41)
    const exact = 'b'.repeat(40)
    const raw = JSON.stringify({ topics: [
      { label: '   ', seq: 4 },
      { label: long, seq: 4 },
      { label: exact, seq: 5 },
    ] })
    expect(parseAnalysisOutput(raw, allowed)).toEqual([{ label: exact, seq: 5 }])
  })

  it('ignores a parents field because the contract does not use it', () => {
    const raw = '{"topics":[{"label":"持久化","seq":5,"parents":["主题图"]}]}'
    const parsed = parseAnalysisOutput(raw, allowed)
    expect(parsed).toEqual([{ label: '持久化', seq: 5 }])
    expect(parsed?.[0]).not.toHaveProperty('parents')
  })

  it('returns null when the top level is not an object with an array topics', () => {
    expect(parseAnalysisOutput('我不知道', allowed)).toBeNull()
    expect(parseAnalysisOutput('{"topics":"无"}', allowed)).toBeNull()
    expect(parseAnalysisOutput('[1,2,3]', allowed)).toBeNull()
  })

  it('returns null when a non-empty topics array has no valid entry', () => {
    const raw = '{"topics":[{"label":"   ","seq":4},{"label":"主题","seq":99},{"label":42,"seq":5}]}'
    expect(parseAnalysisOutput(raw, allowed)).toBeNull()
  })

  it('reads {"topics":[]} as an empty list, not a failure', () => {
    expect(parseAnalysisOutput('{"topics":[]}', allowed)).toEqual([])
  })
})

describe('buildBatch', () => {
  it('groups two labels of one message into ONE contribution and takes the turn from the plan', () => {
    const plan: AnalysisPlan = {
      fromSeq: 0,
      toSeq: 2,
      turn: 2,
      lines: [
        { seq: 1, turn: 2, role: 'user', text: '一条' },
        { seq: 2, turn: 2, role: 'assistant', text: '两条' },
      ],
    }
    const batch = buildBatch(plan, [
      { label: '主题图', seq: 1 },
      { label: '持久化', seq: 1 },
    ])

    expect(batch.fromSeq).toBe(0)
    expect(batch.toSeq).toBe(2)
    expect(batch.turn).toBe(2)
    expect(batch.contributions).toEqual([{ seq: 1, turn: 2, topics: ['主题图', '持久化'] }])
  })

  it('orders contributions ascending by seq and normalizes labels', () => {
    const plan: AnalysisPlan = {
      fromSeq: 0,
      toSeq: 3,
      turn: 1,
      lines: [
        { seq: 1, turn: 1, role: 'user', text: 'a' },
        { seq: 3, turn: 1, role: 'assistant', text: 'b' },
      ],
    }
    const batch = buildBatch(plan, [
      { label: 'B', seq: 3 },
      { label: '  a   Topic ', seq: 1 },
    ])
    expect(batch.contributions.map(item => item.seq)).toEqual([1, 3])
    expect(batch.contributions[0]?.topics).toEqual(['a topic'])
  })

  it('allowedSeqsOf returns exactly the plan line seqs', () => {
    const plan: AnalysisPlan = {
      fromSeq: 0,
      toSeq: 2,
      turn: 1,
      lines: [{ seq: 2, turn: 1, role: 'user', text: 'x' }],
    }
    expect([...allowedSeqsOf(plan)]).toEqual([2])
  })
})

describe('turnsBySeqOf and correctTurns', () => {
  it('takes an assistant turn from its own event and a user turn from the last turn/start', () => {
    const turns = turnsBySeqOf([turnStart(0, 4), userMessage(1, '问'), assistantMessage(2, 5, '答')])
    expect(turns.get(1)).toBe(4)
    expect(turns.get(2)).toBe(5)
  })

  it('returns null when every node already carries the log turn', () => {
    const events = [turnStart(0, 1), userMessage(1, '问')]
    const graph = applyAnalysis(EMPTY_PROGRESS_GRAPH, {
      fromSeq: 0,
      toSeq: 1,
      turn: 1,
      contributions: [{ seq: 1, turn: 1, topics: ['a'] }],
    })
    expect(correctTurns(graph, events)).toBeNull()
  })

  it('returns a frozen graph with corrected turns and keeps unchanged nodes by identity', () => {
    const events = [turnStart(0, 3), userMessage(1, '问'), assistantMessage(2, 3, '答')]
    const graph = applyAnalysis(EMPTY_PROGRESS_GRAPH, {
      fromSeq: 0,
      toSeq: 2,
      turn: 1,
      contributions: [
        { seq: 1, turn: 3, topics: ['b'] },
        { seq: 2, turn: 1, topics: ['a'] },
      ],
    })
    const corrected = correctTurns(graph, events)
    expect(corrected).not.toBeNull()
    expect(Object.isFrozen(corrected)).toBe(true)
    expect(corrected?.nodes[0]).toBe(graph.nodes[0])
    expect(corrected?.nodes[1]?.id).toBe('n-2#a')
    expect(corrected?.nodes[1]?.turn).toBe(3)
  })

  it('corrects every independent topic node that shares a seq', () => {
    const events = [turnStart(0, 4), userMessage(1, '问'), assistantMessage(2, 4, '答')]
    const graph = applyAnalysis(EMPTY_PROGRESS_GRAPH, {
      fromSeq: 0,
      toSeq: 2,
      turn: 1,
      contributions: [{ seq: 2, turn: 1, topics: ['alpha', 'beta'] }],
    })
    const corrected = correctTurns(graph, events)
    expect(corrected).not.toBeNull()
    expect(corrected?.nodes.map(node => [node.id, node.turn])).toEqual([
      ['n-2#alpha', 4],
      ['n-2#beta', 4],
    ])
  })
})
