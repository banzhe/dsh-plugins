import { Context } from '@deepseek-ai/cordis'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { describe, expect, it, vi } from 'vitest'
import { SESSION_TOPIC_TABLE, sessionTopicDomainSpec, storedRecord as recordOf } from '../src/domain.ts'
import { applyAnalysis, EMPTY_PROGRESS_GRAPH } from '../src/progress-graph.ts'
import { apply, inject, name } from '../src/routes.ts'
import { ANALYZE_PATH, MODELS_PATH, STATE_PATH } from '../src/shared.ts'

interface FakeRequest {
  readonly method: string
  readonly url: string
  readonly headers: Record<string, string>
  resume(): void
  [Symbol.asyncIterator](): AsyncIterator<Buffer>
}

interface FakeResponse {
  statusCode: number
  readonly headers: Record<string, string>
  body: string
  setHeader(name: string, value: string): void
  end(body?: string): void
}

type Handler = (req: FakeRequest, res: FakeResponse) => Promise<void> | void

interface Entry {
  readonly type: 'turn/start' | 'user/message' | 'assistant/message'
  readonly seq: number
  readonly turn: number
  readonly text: string
}

function request(method: string, url: string, options: { body?: string, contentType?: string } = {}): FakeRequest {
  const chunks = options.body === undefined ? [] : [Buffer.from(options.body, 'utf8')]
  const headers: Record<string, string> = options.contentType === undefined ? {} : { 'content-type': options.contentType }
  return {
    method,
    url,
    headers,
    resume: () => {},
    async *[Symbol.asyncIterator](): AsyncIterator<Buffer> {
      for (const chunk of chunks) yield chunk
    },
  }
}

function response(): FakeResponse {
  const target: FakeResponse = {
    statusCode: 200,
    headers: {},
    body: '',
    setHeader(key, value) {
      target.headers[key] = value
    },
    end(body) {
      target.body = body ?? ''
    },
  }
  return target
}

function jsonOf(fake: FakeResponse): Record<string, unknown> {
  return JSON.parse(fake.body) as Record<string, unknown>
}

function answerChunks(text: string): readonly StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

function eventOf(entry: Entry): never {
  if (entry.type === 'turn/start') {
    return { type: 'turn/start', seq: entry.seq, time: 0, data: { turn: entry.turn } } as never
  }
  const content = [{ type: 'text', text: entry.text }]
  if (entry.type === 'user/message') {
    return {
      type: 'user/message',
      seq: entry.seq,
      time: 0,
      surfaceOp: 'append',
      data: { role: 'user', id: `u-${entry.seq}`, content, source: { kind: 'user' } },
    } as never
  }
  return {
    type: 'assistant/message',
    seq: entry.seq,
    time: 0,
    surfaceOp: 'append',
    data: {
      turn: entry.turn,
      step: 1,
      stream: [],
      message: { role: 'assistant', id: `a-${entry.seq}`, content, source: { kind: 'model', provider: 'p', model: 'm' } },
    },
  } as never
}

interface Bench {
  readonly ctx: Context
  readonly facility: DomainFacility
  readonly tables: Map<string, Map<string, unknown>>
  readonly logs: Map<string, Entry[]>
  readonly send: ReturnType<typeof vi.fn>
  readonly setAnswer: (text: string) => void
  readonly setFailStream: (value: boolean) => void
  readonly setModels: (ids: readonly string[]) => void
  readonly setSessionsReadable: (value: boolean) => void
  readonly readSessionCount: () => number
  call(path: string, method: string, query?: string, options?: { body?: string, contentType?: string }): Promise<FakeResponse>
  boot(): Promise<{ dispose(): Promise<void> | void }>
  appendTo(sessionId: string, entry: Entry): void
}

function bench(): Bench {
  let answer = '{"topics":[]}'
  let failStream = false
  let modelIds: readonly string[] = ['m']
  const tables = new Map<string, Map<string, unknown>>()
  const logs = new Map<string, Entry[]>()
  const unit = {
    loadAll: async () => ({
      tables: Object.fromEntries([...tables].map(([table, records]) => [table, Object.fromEntries(records)])),
      global: null as unknown,
    }),
    pushRecord: async (table: string, key: string, value: unknown) => {
      const records = tables.get(table) ?? new Map<string, unknown>()
      tables.set(table, records)
      records.set(key, value)
    },
    putRecord: async (table: string, key: string, value: unknown) => {
      const records = tables.get(table) ?? new Map<string, unknown>()
      tables.set(table, records)
      records.set(key, value)
    },
    deleteRecord: async (table: string, key: string) => {
      tables.get(table)?.delete(key)
    },
    setGlobal: async () => {},
    close: async () => {},
  }

  const ctx = new Context()
  ctx.provide('storage', { backend: { get: () => ({ kv: { open: async () => unit }, close: async () => {} }) } } as never)
  const facility = new DomainFacility(ctx, { backend: 'test' })
  ctx.provide('storageDomain', facility)

  const handlers = new Map<string, Handler>()
  ctx.provide('webServer', {
    register: (route: { path: string, handler: Handler }) => {
      handlers.set(route.path, route.handler)
      return () => {
        handlers.delete(route.path)
      }
    },
  } as never)
  ctx.provide('connection', { requestRejection: () => undefined } as never)

  let sessionsReadable = true
  let sessionReads = 0
  ctx.provide('sessionQuery', {
    readSession: async (id: string) => {
      sessionReads += 1
      if (!sessionsReadable) throw new Error('no such session')
      return {
        session: { id },
        inheritedEventCount: 0,
        events: (logs.get(id) ?? []).map(entry => eventOf(entry)),
      }
    },
  } as never)

  const send = vi.fn(() => (async function* (): AsyncGenerator<StreamChunk> {
    if (failStream) throw new Error('provider is down')
    for (const chunk of answerChunks(answer)) yield chunk
  })())
  ctx.provide('llm', {
    listProviders: () => [{ id: 'p', name: 'P' }],
    listModels: async (...args: unknown[]) => {
      const requested = args.find(arg => typeof arg === 'string')
      if (requested !== undefined && requested !== 'p') throw new Error('unknown provider ' + requested)
      return modelIds.map(id => ({ provider: 'p', id, name: id }))
    },
    stream: send,
  } as never)

  const call = async (path: string, method: string, query = '', options: { body?: string, contentType?: string } = {}): Promise<FakeResponse> => {
    const handler = handlers.get(path)
    if (handler === undefined) throw new Error(`no route registered for ${path}`)
    const fake = response()
    await handler(request(method, `${path}${query}`, options), fake)
    return fake
  }

  const boot = async () => {
    const fiber = ctx.plugin({ inject: [...inject], apply })
    await (fiber as unknown as { await(): Promise<void> }).await()
    return fiber as unknown as { dispose(): Promise<void> | void }
  }

  return {
    ctx,
    facility,
    tables,
    logs,
    send,
    setAnswer: (text) => {
      answer = text
    },
    setFailStream: (value) => {
      failStream = value
    },
    setModels: (ids) => {
      modelIds = ids
    },
    setSessionsReadable: (value) => {
      sessionsReadable = value
    },
    readSessionCount: () => sessionReads,
    call,
    boot,
    appendTo: (sessionId, entry) => {
      const list = logs.get(sessionId) ?? []
      logs.set(sessionId, list)
      list.push(entry)
    },
  }
}

function storedRecord(benchmark: Bench): { schemaVersion?: number } | undefined {
  return benchmark.tables.get(SESSION_TOPIC_TABLE)?.get('s-1') as { schemaVersion?: number } | undefined
}

const ANALYZE_BODY = (sessionId: string, confirm: unknown = true): string => JSON.stringify({ sessionId, provider: 'p', model: 'm', confirm })

interface StateGraph {
  readonly checkpoint: number
  readonly turn: number
  readonly nodes: readonly { readonly id: string, readonly turn: number, readonly topics: readonly string[] }[]
}

function graphOf(fake: FakeResponse): StateGraph {
  return (jsonOf(fake) as { graph: StateGraph }).graph
}

describe('session topic map routes', () => {
  it('exports the route name', () => {
    expect(name).toBe('session-topic-map')
    expect(inject).toEqual(expect.arrayContaining(['webServer', 'connection', 'llm', 'sessionQuery', 'storageDomain']))
  })

  describe('models', () => {
    it('lists providers and their models', async () => {
      const benchmark = bench()
      await benchmark.boot()
      const fake = await benchmark.call(MODELS_PATH, 'GET')
      expect(fake.statusCode).toBe(200)
      expect(jsonOf(fake)).toEqual({ providers: [{ provider: 'p', name: 'P', models: [{ id: 'm', name: 'm' }] }] })
    })

    it('refuses a method other than GET with 405 and an allow header', async () => {
      const benchmark = bench()
      await benchmark.boot()
      const fake = await benchmark.call(MODELS_PATH, 'POST')
      expect(fake.statusCode).toBe(405)
      expect(fake.headers.allow).toBe('GET')
    })
  })

  describe('state', () => {
    it('answers the empty graph with updatedAt null for an unknown session', async () => {
      const benchmark = bench()
      await benchmark.boot()
      const fake = await benchmark.call(STATE_PATH, 'GET', '?sessionId=s-unknown')
      expect(fake.statusCode).toBe(200)
      expect(jsonOf(fake).updatedAt).toBeNull()
      expect(graphOf(fake).checkpoint).toBe(-1)
      expect(graphOf(fake).nodes).toEqual([])
    })

    it('answers 400 bad-request when sessionId is missing or blank', async () => {
      const benchmark = bench()
      await benchmark.boot()
      const missing = await benchmark.call(STATE_PATH, 'GET')
      expect(missing.statusCode).toBe(400)
      expect(jsonOf(missing).code).toBe('bad-request')
      const blank = await benchmark.call(STATE_PATH, 'GET', '?sessionId=%20%20')
      expect(blank.statusCode).toBe(400)
      expect(jsonOf(blank).code).toBe('bad-request')
    })
  })

  describe('analyze', () => {
    it('refuses a request without an exact confirm true, with no model call and no write', async () => {
      const benchmark = bench()
      await benchmark.boot()
      benchmark.appendTo('s-1', { type: 'user/message', seq: 0, turn: 1, text: '把右侧面板做成主题图' })
      const fake = await benchmark.call(ANALYZE_PATH, 'POST', '', { body: ANALYZE_BODY('s-1', false), contentType: 'application/json' })
      expect(fake.statusCode).toBe(400)
      expect(jsonOf(fake).code).toBe('not-confirmed')
      expect(benchmark.send).not.toHaveBeenCalled()
      const state = await benchmark.call(STATE_PATH, 'GET', '?sessionId=s-1')
      expect(graphOf(state).checkpoint).toBe(-1)
    })

    it('refuses an unknown provider with unknown-provider', async () => {
      const benchmark = bench()
      await benchmark.boot()
      const fake = await benchmark.call(ANALYZE_PATH, 'POST', '', {
        body: JSON.stringify({ sessionId: 's-1', provider: 'nope', model: 'm', confirm: true }),
        contentType: 'application/json',
      })
      expect(fake.statusCode).toBe(400)
      expect(jsonOf(fake).code).toBe('unknown-provider')
      expect(benchmark.send).not.toHaveBeenCalled()
    })

    it('refuses a model the provider does not advertise with unknown-model', async () => {
      const benchmark = bench()
      benchmark.setModels(['other'])
      await benchmark.boot()
      const fake = await benchmark.call(ANALYZE_PATH, 'POST', '', { body: ANALYZE_BODY('s-1'), contentType: 'application/json' })
      expect(fake.statusCode).toBe(400)
      expect(jsonOf(fake).code).toBe('unknown-model')
      expect(benchmark.send).not.toHaveBeenCalled()
    })

    it('answers session-not-found for a session the Host cannot read', async () => {
      const benchmark = bench()
      await benchmark.boot()
      benchmark.setSessionsReadable(false)
      const fake = await benchmark.call(ANALYZE_PATH, 'POST', '', { body: ANALYZE_BODY('s-missing'), contentType: 'application/json' })
      expect(fake.statusCode).toBe(404)
      expect(jsonOf(fake).code).toBe('session-not-found')
    })

    it('stores the next graph, returns it, and advances the checkpoint on success', async () => {
      const benchmark = bench()
      benchmark.setAnswer('{"topics":[{"label":"主题图","seq":1}]}')
      await benchmark.boot()
      benchmark.appendTo('s-1', { type: 'turn/start', seq: 0, turn: 1, text: '' })
      benchmark.appendTo('s-1', { type: 'user/message', seq: 1, turn: 1, text: '把右侧面板做成主题图' })

      const fake = await benchmark.call(ANALYZE_PATH, 'POST', '', { body: ANALYZE_BODY('s-1'), contentType: 'application/json' })
      expect(fake.statusCode).toBe(200)
      const payload = jsonOf(fake) as { graph: StateGraph, analyzed: { fromSeq: number, toSeq: number, messages: number, topics: number } }
      expect(payload.analyzed).toEqual({ fromSeq: 0, toSeq: 1, messages: 1, topics: 1 })
      expect(payload.graph.checkpoint).toBe(1)
      expect(payload.graph.nodes.map(node => node.topics)).toEqual([['主题图']])
      expect(benchmark.send).toHaveBeenCalledTimes(1)

      const state = await benchmark.call(STATE_PATH, 'GET', '?sessionId=s-1')
      expect(graphOf(state).checkpoint).toBe(1)
      expect(jsonOf(state).updatedAt).not.toBeNull()
    })

    it('sends only the messages appended since the last successful run', async () => {
      const benchmark = bench()
      benchmark.setAnswer('{"topics":[{"label":"旧主题","seq":0}]}')
      await benchmark.boot()
      benchmark.appendTo('s-1', { type: 'user/message', seq: 0, turn: 1, text: '旧消息' })
      await benchmark.call(ANALYZE_PATH, 'POST', '', { body: ANALYZE_BODY('s-1'), contentType: 'application/json' })
      benchmark.appendTo('s-1', { type: 'user/message', seq: 1, turn: 2, text: '新消息' })
      benchmark.setAnswer('{"topics":[{"label":"新主题","seq":1}]}')

      const fake = await benchmark.call(ANALYZE_PATH, 'POST', '', { body: ANALYZE_BODY('s-1'), contentType: 'application/json' })
      expect(fake.statusCode).toBe(200)
      expect(benchmark.send).toHaveBeenCalledTimes(2)
      const secondPrompt = JSON.stringify(benchmark.send.mock.calls[1]?.[0])
      expect(secondPrompt).toContain('新消息')
      expect(secondPrompt).not.toContain('旧消息')
      expect((jsonOf(fake).analyzed as { messages: number }).messages).toBe(1)
    })

    it('makes no model call when the log holds nothing past the checkpoint', async () => {
      const benchmark = bench()
      benchmark.setAnswer('{"topics":[{"label":"只有这些","seq":0}]}')
      await benchmark.boot()
      benchmark.appendTo('s-1', { type: 'user/message', seq: 0, turn: 1, text: '只有这些' })
      await benchmark.call(ANALYZE_PATH, 'POST', '', { body: ANALYZE_BODY('s-1'), contentType: 'application/json' })
      expect(benchmark.send).toHaveBeenCalledTimes(1)

      const fake = await benchmark.call(ANALYZE_PATH, 'POST', '', { body: ANALYZE_BODY('s-1'), contentType: 'application/json' })
      expect(fake.statusCode).toBe(200)
      expect(benchmark.send).toHaveBeenCalledTimes(1)
      expect((jsonOf(fake).analyzed as { messages: number }).messages).toBe(0)
    })

    it('answers analysis-failed and keeps the checkpoint when the model stream fails', async () => {
      const benchmark = bench()
      benchmark.setFailStream(true)
      await benchmark.boot()
      benchmark.appendTo('s-1', { type: 'user/message', seq: 0, turn: 1, text: '会失败' })

      const fake = await benchmark.call(ANALYZE_PATH, 'POST', '', { body: ANALYZE_BODY('s-1'), contentType: 'application/json' })
      expect(fake.statusCode).toBe(409)
      expect(jsonOf(fake).code).toBe('analysis-failed')

      const state = await benchmark.call(STATE_PATH, 'GET', '?sessionId=s-1')
      expect(graphOf(state).checkpoint).toBe(-1)
    })

    it('answers unreadable-answer and keeps the checkpoint when the answer is not the required JSON', async () => {
      const benchmark = bench()
      benchmark.setAnswer('我觉得聊得不错')
      await benchmark.boot()
      benchmark.appendTo('s-1', { type: 'user/message', seq: 0, turn: 1, text: '答非所问' })

      const fake = await benchmark.call(ANALYZE_PATH, 'POST', '', { body: ANALYZE_BODY('s-1'), contentType: 'application/json' })
      expect(fake.statusCode).toBe(422)
      expect(jsonOf(fake).code).toBe('unreadable-answer')

      const state = await benchmark.call(STATE_PATH, 'GET', '?sessionId=s-1')
      expect(graphOf(state).checkpoint).toBe(-1)
    })

    it('replays the same messages after a failed run, so the next success reads them again', async () => {
      const benchmark = bench()
      benchmark.setFailStream(true)
      await benchmark.boot()
      benchmark.appendTo('s-1', { type: 'user/message', seq: 0, turn: 1, text: '重放消息' })
      await benchmark.call(ANALYZE_PATH, 'POST', '', { body: ANALYZE_BODY('s-1'), contentType: 'application/json' })

      benchmark.setFailStream(false)
      benchmark.setAnswer('{"topics":[{"label":"重放主题","seq":0}]}')
      const fake = await benchmark.call(ANALYZE_PATH, 'POST', '', { body: ANALYZE_BODY('s-1'), contentType: 'application/json' })
      expect(fake.statusCode).toBe(200)
      expect((jsonOf(fake).analyzed as { messages: number }).messages).toBe(1)
      expect(JSON.stringify(benchmark.send.mock.calls[1]?.[0])).toContain('重放消息')
    })

    it('keeps each session graph separate', async () => {
      const benchmark = bench()
      benchmark.setAnswer('{"topics":[{"label":"甲","seq":0}]}')
      await benchmark.boot()
      benchmark.appendTo('s-a', { type: 'user/message', seq: 0, turn: 1, text: 'A 的消息' })
      benchmark.appendTo('s-b', { type: 'user/message', seq: 0, turn: 1, text: 'B 的消息' })

      await benchmark.call(ANALYZE_PATH, 'POST', '', { body: ANALYZE_BODY('s-a'), contentType: 'application/json' })
      const stateB = await benchmark.call(STATE_PATH, 'GET', '?sessionId=s-b')
      expect(graphOf(stateB).checkpoint).toBe(-1)
      expect(graphOf(stateB).nodes).toEqual([])

      const stateA = await benchmark.call(STATE_PATH, 'GET', '?sessionId=s-a')
      expect(graphOf(stateA).checkpoint).toBe(0)
    })

    it('recovers the stored graph after a restart and continues from its checkpoint', async () => {
      const benchmark = bench()
      benchmark.setAnswer('{"topics":[{"label":"主题图","seq":1}]}')
      const first = await benchmark.boot()
      benchmark.appendTo('s-1', { type: 'user/message', seq: 0, turn: 1, text: '旧消息' })
      benchmark.appendTo('s-1', { type: 'user/message', seq: 1, turn: 1, text: '把右侧面板做成主题图' })
      await benchmark.call(ANALYZE_PATH, 'POST', '', { body: ANALYZE_BODY('s-1'), contentType: 'application/json' })
      await first.dispose()

      const second = await benchmark.boot()
      const state = await benchmark.call(STATE_PATH, 'GET', '?sessionId=s-1')
      expect(graphOf(state).checkpoint).toBe(1)
      expect(graphOf(state).nodes.map(node => node.topics)).toEqual([['主题图']])

      benchmark.appendTo('s-1', { type: 'user/message', seq: 2, turn: 2, text: '第二轮' })
      benchmark.setAnswer('{"topics":[{"label":"第二轮主题","seq":2}]}')
      const fake = await benchmark.call(ANALYZE_PATH, 'POST', '', { body: ANALYZE_BODY('s-1'), contentType: 'application/json' })
      expect(fake.statusCode).toBe(200)
      expect((jsonOf(fake).analyzed as { fromSeq: number }).fromSeq).toBe(2)
      expect(JSON.stringify(benchmark.send.mock.calls[1]?.[0])).not.toContain('旧消息')
      await second.dispose()
    })

    it('answers 413 payload-too-large for a JSON body over 8 KiB and never calls a model', async () => {
      const benchmark = bench()
      await benchmark.boot()
      const body = JSON.stringify({ sessionId: 's-1', provider: 'p', model: 'm', confirm: true, padding: 'x'.repeat(9000) })
      const fake = await benchmark.call(ANALYZE_PATH, 'POST', '', { body, contentType: 'application/json' })
      expect(fake.statusCode).toBe(413)
      expect(jsonOf(fake).code).toBe('payload-too-large')
      expect(benchmark.send).not.toHaveBeenCalled()
    })

    it('answers 415 for a body that is not JSON', async () => {
      const benchmark = bench()
      await benchmark.boot()
      const fake = await benchmark.call(ANALYZE_PATH, 'POST', '', { body: ANALYZE_BODY('s-1'), contentType: 'text/plain' })
      expect(fake.statusCode).toBe(415)
      expect(benchmark.send).not.toHaveBeenCalled()
    })

    it('refuses a method other than POST with 405 and an allow header', async () => {
      const benchmark = bench()
      await benchmark.boot()
      const fake = await benchmark.call(ANALYZE_PATH, 'GET')
      expect(fake.statusCode).toBe(405)
      expect(fake.headers.allow).toBe('POST')
    })
  })
})

describe('answers that name no in-range topic', () => {
  it('advances the checkpoint and stores the record on a legal empty answer', async () => {
    const benchmark = bench()
    benchmark.setAnswer('{"topics":[]}')
    await benchmark.boot()
    benchmark.appendTo('s-1', { type: 'user/message', seq: 0, turn: 1, text: '寒暄' })
    const fake = await benchmark.call(ANALYZE_PATH, 'POST', '', { body: ANALYZE_BODY('s-1'), contentType: 'application/json' })
    expect(fake.statusCode).toBe(200)
    expect((jsonOf(fake).analyzed as { topics: number }).topics).toBe(0)
    expect(graphOf(fake).checkpoint).toBe(0)
    expect(storedRecord(benchmark)).toBeDefined()
  })

  it('answers unreadable-answer for an answer naming only out-of-range seqs, and the next run re-reads the same range', async () => {
    const benchmark = bench()
    benchmark.setAnswer('{"topics":[{"label":"越界","seq":99}]}')
    await benchmark.boot()
    benchmark.appendTo('s-1', { type: 'user/message', seq: 0, turn: 1, text: '重读消息' })
    const fake = await benchmark.call(ANALYZE_PATH, 'POST', '', { body: ANALYZE_BODY('s-1'), contentType: 'application/json' })
    expect(fake.statusCode).toBe(422)
    expect(jsonOf(fake).code).toBe('unreadable-answer')
    expect(storedRecord(benchmark)).toBeUndefined()
    const state = await benchmark.call(STATE_PATH, 'GET', '?sessionId=s-1')
    expect(graphOf(state).checkpoint).toBe(-1)

    benchmark.setAnswer('{"topics":[{"label":"范围内","seq":0}]}')
    const second = await benchmark.call(ANALYZE_PATH, 'POST', '', { body: ANALYZE_BODY('s-1'), contentType: 'application/json' })
    expect(second.statusCode).toBe(200)
    expect(JSON.stringify(benchmark.send.mock.calls[1]?.[0])).toContain('重读消息')
    expect(graphOf(second).checkpoint).toBe(0)
  })

  it('keeps the valid topics of a mixed answer and succeeds', async () => {
    const benchmark = bench()
    benchmark.setAnswer('{"topics":[{"label":"范围内","seq":1},{"label":"越界","seq":99}]}')
    await benchmark.boot()
    benchmark.appendTo('s-1', { type: 'user/message', seq: 0, turn: 1, text: '甲' })
    benchmark.appendTo('s-1', { type: 'user/message', seq: 1, turn: 1, text: '乙' })
    const fake = await benchmark.call(ANALYZE_PATH, 'POST', '', { body: ANALYZE_BODY('s-1'), contentType: 'application/json' })
    expect(fake.statusCode).toBe(200)
    const payload = jsonOf(fake) as { graph: { nodes: { topics: string[] }[] } }
    expect(payload.graph.nodes.map(node => node.topics)).toEqual([['范围内']])
  })
})

describe('state re-anchoring of stored turns', () => {
  const STORED_AT = '2026-01-02T00:00:00.000Z'

  async function seedRecord(benchmark: Bench, mode: 'omitted' | 'unverified' | 'verified'): Promise<void> {
    const graph = applyAnalysis(EMPTY_PROGRESS_GRAPH, {
      fromSeq: 0,
      toSeq: 2,
      turn: 1,
      contributions: [{ seq: 2, turn: 1, topics: ['a'] }],
    })
    const current = recordOf(graph, STORED_AT, mode !== 'unverified')
    const record = mode === 'omitted' ? { schemaVersion: 2 as const, graph: current.graph, updatedAt: STORED_AT } : current
    const domain = await benchmark.facility.open(sessionTopicDomainSpec)
    await domain.table(SESSION_TOPIC_TABLE).put('s-1', record)
    await domain.close()
  }

  function appendTurnThree(benchmark: Bench): void {
    benchmark.appendTo('s-1', { type: 'turn/start', seq: 0, turn: 3, text: '' })
    benchmark.appendTo('s-1', { type: 'user/message', seq: 1, turn: 3, text: '问' })
    benchmark.appendTo('s-1', { type: 'assistant/message', seq: 2, turn: 3, text: '答' })
  }

  it('corrects the turns once from the log, answers the corrected graph and keeps the original updatedAt', async () => {
    const benchmark = bench()
    await seedRecord(benchmark, 'omitted')
    await benchmark.boot()
    appendTurnThree(benchmark)

    const fake = await benchmark.call(STATE_PATH, 'GET', '?sessionId=s-1')
    expect(fake.statusCode).toBe(200)
    expect(graphOf(fake).nodes[0]?.turn).toBe(3)
    expect(jsonOf(fake).updatedAt).toBe(STORED_AT)
    expect(benchmark.readSessionCount()).toBe(1)

    const stored = storedRecord(benchmark) as { turnsVerified?: boolean, updatedAt?: string, graph?: { nodes: { turn: number }[] } } | undefined
    expect(stored?.turnsVerified).toBe(true)
    expect(stored?.updatedAt).toBe(STORED_AT)
    expect(stored?.graph?.nodes[0]?.turn).toBe(3)
  })

  it('does not read the log again once the record is verified', async () => {
    const benchmark = bench()
    await seedRecord(benchmark, 'omitted')
    await benchmark.boot()
    appendTurnThree(benchmark)

    await benchmark.call(STATE_PATH, 'GET', '?sessionId=s-1')
    await benchmark.call(STATE_PATH, 'GET', '?sessionId=s-1')
    expect(benchmark.readSessionCount()).toBe(1)
  })

  it('answers the stored graph as is, with no log read, when the record is already verified', async () => {
    const benchmark = bench()
    await seedRecord(benchmark, 'verified')
    await benchmark.boot()
    appendTurnThree(benchmark)

    const fake = await benchmark.call(STATE_PATH, 'GET', '?sessionId=s-1')
    expect(fake.statusCode).toBe(200)
    expect(graphOf(fake).nodes[0]?.turn).toBe(1)
    expect(benchmark.readSessionCount()).toBe(0)
  })

  it('answers the stored graph unchanged with 200 when the log read throws, and writes nothing', async () => {
    const benchmark = bench()
    await seedRecord(benchmark, 'unverified')
    await benchmark.boot()
    benchmark.setSessionsReadable(false)

    const fake = await benchmark.call(STATE_PATH, 'GET', '?sessionId=s-1')
    expect(fake.statusCode).toBe(200)
    expect(graphOf(fake).nodes[0]?.turn).toBe(1)
    const stored = storedRecord(benchmark) as { turnsVerified?: boolean } | undefined
    expect(stored?.turnsVerified).not.toBe(true)
  })

  it('answers a legacy version-1 record with the empty graph and reads no log', async () => {
    const benchmark = bench()
    const domain = await benchmark.facility.open(sessionTopicDomainSpec)
    await domain.table(SESSION_TOPIC_TABLE).put('s-1', {
      graph: { nodes: [{ id: 'legacy', label: '旧主题', parents: [], sources: [{ seq: 1, turn: 1 }] }], edges: [], checkpoint: 1, turn: 1 },
      updatedAt: STORED_AT,
    })
    await domain.close()
    await benchmark.boot()
    appendTurnThree(benchmark)

    const fake = await benchmark.call(STATE_PATH, 'GET', '?sessionId=s-1')
    expect(graphOf(fake).checkpoint).toBe(-1)
    expect(jsonOf(fake).updatedAt).toBeNull()
    expect(benchmark.readSessionCount()).toBe(0)
  })
})
describe('legacy version-1 records', () => {
  it('answers the empty graph for a stored version-1 record and replaces it with a version-2 record after analysis', async () => {
    const benchmark = bench()
    benchmark.setAnswer('{"topics":[{"label":"新主题","seq":2}]}')
    const legacy = {
      graph: {
        nodes: [{ id: 'legacy', label: '旧主题', parents: [], sources: [{ seq: 1, turn: 1 }] }],
        edges: [],
        checkpoint: 1,
        turn: 1,
      },
      updatedAt: '2026-01-01T00:00:00.000Z',
    }
    const domain = await benchmark.facility.open(sessionTopicDomainSpec)
    await domain.table(SESSION_TOPIC_TABLE).put('s-1', legacy)
    await domain.close()

    await benchmark.boot()
    const state = await benchmark.call(STATE_PATH, 'GET', '?sessionId=s-1')
    expect(state.statusCode).toBe(200)
    expect(jsonOf(state).updatedAt).toBeNull()
    expect(graphOf(state).nodes).toEqual([])
    expect(graphOf(state).checkpoint).toBe(-1)

    benchmark.appendTo('s-1', { type: 'user/message', seq: 2, turn: 2, text: '新消息' })
    const fake = await benchmark.call(ANALYZE_PATH, 'POST', '', { body: ANALYZE_BODY('s-1'), contentType: 'application/json' })
    expect(fake.statusCode).toBe(200)
    const payload = jsonOf(fake) as { graph: { nodes: { id: string, topics: readonly string[] }[] } }
    expect(payload.graph.nodes).toEqual([expect.objectContaining({ id: 'n-2', topics: ['新主题'] })])

    const stored = benchmark.tables.get(SESSION_TOPIC_TABLE)?.get('s-1') as { schemaVersion?: number } | undefined
    expect(stored?.schemaVersion).toBe(2)
  })
})





