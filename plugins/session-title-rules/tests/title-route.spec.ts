/**
 * `deriveTitle`'s contract, driven through its own interface rather than through
 * a captured `register` closure.
 *
 * The module takes a policy and a standing title as VALUES and one capability as
 * a seam (the model stream), so every row here builds one derivation value and
 * calls it. No Cordis context, no `inject`/`effect` stubs, no closure capture:
 * the interface is the test surface.
 *
 * The outcomes the plugin must keep distinct:
 *
 * 1. an explicit `provider`+`model` pair wins over the session's own route;
 * 2. an absent pair falls back to the Session's logged `request/header` route;
 * 3. half a pair is a REFUSAL, never a silent fallback to the session route —
 *    a deployment that set only `provider` asked for something the plugin
 *    cannot honour, and falling back quietly titles with a model it did not
 *    choose.
 *
 * The adapter half (`apply`, and the live-policy read it owns) is the second
 * describe block: it is the one place the `Volatile` invariant lives now, so it
 * is pinned there explicitly.
 */
import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import type {
  SessionTitleProvider, SessionTitleProviderRequest, SessionTitleSnapshot, SessionTitleUserMessage,
} from '@deepseek-ai/dsh-session-title'
import { apply, type Config } from '../src/index.ts'
import { deriveTitle, type TitleModelAccess, type TitlePolicy } from '../src/title.ts'

/** A well-formed auxiliary answer: one text block, closed, then a clean stop. */
function answer(text: string): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

/** An in-memory model stream: the module's one seam, and its test adapter. */
function streamOf(chunks: readonly StreamChunk[]): AsyncIterable<StreamChunk> {
  return (async function* () {
    for (const chunk of chunks) yield chunk
  })()
}

/** One message seq as the branded type the service hands over. */
function seq(value: number): SessionTitleUserMessage['seq'] {
  return value as SessionTitleUserMessage['seq']
}

/** Every input one derivation row varies. */
interface DerivationInput {
  readonly policy?: TitlePolicy
  readonly route?: { provider: string; model: string }
  readonly currentTitle?: string
  readonly messages?: readonly { seq: number; text: string }[]
}

interface Bench {
  /** Every `GenerateOptions` the module dispatched, in call order. */
  readonly options: GenerateOptions[]
  /** Cancellation the module composes with its own deadline. */
  readonly controller: AbortController
  /** Run one derivation and return either its result or the refusal it threw. */
  run(input?: DerivationInput): Promise<unknown>
}

/**
 * Drive one derivation with the given answer. The policy, the session route, the
 * standing title and the message list are the only inputs a row varies; the
 * stream is the seam.
 */
function bench(chunks: readonly StreamChunk[], stream?: TitleModelAccess['stream']): Bench {
  const options: GenerateOptions[] = []
  const controller = new AbortController()
  const llm: TitleModelAccess = {
    stream: stream ?? ((dispatched: GenerateOptions): AsyncIterable<StreamChunk> => {
      options.push(dispatched)
      return streamOf(chunks)
    }),
  }
  return {
    options,
    controller,
    async run(input = {}) {
      const request = {
        session: { id: 'session-1', append: () => undefined },
        messages: input.messages === undefined
          ? [{ seq: seq(1), text: '为标题选择一个模型' }]
          : input.messages.map(message => ({ seq: seq(message.seq), text: message.text })),
        ...input.route === undefined ? {} : { route: input.route },
        signal: controller.signal,
      } as unknown as SessionTitleProviderRequest
      try {
        return await deriveTitle({
          policy: input.policy ?? {},
          request,
          currentTitle: input.currentTitle,
          llm,
        })
      } catch (error: unknown) {
        return error instanceof Error ? error : new Error(String(error))
      }
    },
  }
}

/** A bench whose derivations fall back to one logged session route. */
function benchWithRoute(chunks: readonly StreamChunk[], route: { provider: string; model: string }): Bench {
  const inner = bench(chunks)
  return {
    options: inner.options,
    controller: inner.controller,
    run: input => inner.run({ ...input, route }),
  }
}

/** Assert the outcome is a result, not a refusal. */
function resultOf(outcome: unknown): { title: string; messageSeqs: readonly number[]; model?: unknown } {
  if (outcome instanceof Error) throw outcome
  return outcome as { title: string; messageSeqs: readonly number[]; model?: unknown }
}

/** Assert the outcome is a refusal, and hand back its message. */
function refusalOf(outcome: unknown): string {
  if (!(outcome instanceof Error)) throw new Error('expected a refusal, got a result')
  return outcome.message
}

describe('auxiliary route resolution', () => {
  it('prefers an explicit provider/model pair over the session route', async () => {
    const harness = benchWithRoute(answer('🔬 标题模型选择'), { provider: 'deepseek-official', model: 'deepseek-flash' })
    await harness.run({ policy: { provider: 'cliproxyapi', model: 'cc/deepseek-v4.1-flash' } })
    expect(harness.options[0]).toMatchObject({ provider: 'cliproxyapi', model: 'cc/deepseek-v4.1-flash' })
  })

  it('falls back to the session route when no pair is configured', async () => {
    const harness = benchWithRoute(answer('🔬 标题模型选择'), { provider: 'cliproxyapi', model: 'ollama/glm-5.3' })
    await harness.run({ policy: {} })
    expect(harness.options[0]).toMatchObject({ provider: 'cliproxyapi', model: 'ollama/glm-5.3' })
  })

  it('refuses a provider with no model instead of falling back', async () => {
    const harness = benchWithRoute(answer('🔬 标题模型选择'), { provider: 'main', model: 'chat' })
    // Falling back here would title with a model the deployment did not choose.
    expect(refusalOf(await harness.run({ policy: { provider: 'cliproxyapi' } })))
      .toContain('provider and model must be configured together')
    expect(harness.options).toHaveLength(0)
  })

  it('refuses a model with no provider instead of falling back', async () => {
    const harness = benchWithRoute(answer('🔬 标题模型选择'), { provider: 'main', model: 'chat' })
    expect(refusalOf(await harness.run({ policy: { model: 'cc/deepseek-v4.1-flash' } })))
      .toContain('provider and model must be configured together')
    expect(harness.options).toHaveLength(0)
  })

  it('still refuses when neither a pair nor a session route exists', async () => {
    const harness = bench(answer('🔬 标题模型选择'))
    expect(refusalOf(await harness.run({ policy: {} })))
      .toContain('no logged request route is available')
    expect(harness.options).toHaveLength(0)
  })

  it('an explicit pair works before any session route exists', async () => {
    const harness = bench(answer('🔬 标题模型选择'))
    await harness.run({ policy: { provider: 'cliproxyapi', model: 'cc/deepseek-v4.1-flash' } })
    expect(harness.options[0]).toMatchObject({ provider: 'cliproxyapi', model: 'cc/deepseek-v4.1-flash' })
  })

  it('omits reasoningEffort entirely when none is configured', async () => {
    const harness = benchWithRoute(answer('🔬 标题模型选择'), { provider: 'main', model: 'chat' })
    await harness.run({ policy: { provider: 'p', model: 'm' } })
    // Absent, not undefined-valued: the seam reads presence, and pi-ai applies
    // the profile's own effort when the field is missing.
    expect('reasoningEffort' in (harness.options[0] as GenerateOptions)).toBe(false)
  })

  it('passes a configured reasoningEffort through to the request', async () => {
    const harness = bench(answer('🔬 标题模型选择'))
    await harness.run({ policy: { provider: 'p', model: 'm', reasoningEffort: 'off' } })
    expect(harness.options[0]?.reasoningEffort).toBe('off')
  })

  it('applies the configured effort to a fallback route too', async () => {
    const harness = benchWithRoute(answer('🔬 标题模型选择'), { provider: 'main', model: 'chat' })
    await harness.run({ policy: { reasoningEffort: 'low' } })
    expect(harness.options[0]).toMatchObject({ provider: 'main', model: 'chat', reasoningEffort: 'low' })
  })

  it('reports the route it actually used as the title provenance', async () => {
    // The logged `session/title` source.model must name the override, not the
    // session route: provenance that disagrees with the call is a lie.
    const harness = benchWithRoute(answer('🔬 标题模型选择'), { provider: 'main', model: 'chat' })
    const result = resultOf(await harness.run({ policy: { provider: 'cliproxyapi', model: 'cc/deepseek-v4.1-flash' } }))
    expect(result.model).toEqual({ provider: 'cliproxyapi', model: 'cc/deepseek-v4.1-flash' })
  })

  it('never sends a tool schema or a second message', async () => {
    const harness = bench(answer('🔬 标题模型选择'))
    await harness.run({ policy: { provider: 'p', model: 'm' } })
    expect(harness.options[0]?.messages).toHaveLength(1)
    expect(harness.options[0]?.tools).toBeUndefined()
    expect(harness.options[0]?.purpose).toBe('session-title')
  })
})

describe('deriveTitle - the framed input', () => {
  it('shows the standing title to the model as 原名称, and nothing when there is none', async () => {
    const withTitle = bench(answer('🔬 主题'))
    await withTitle.run({ currentTitle: '旧标题', policy: { provider: 'p', model: 'm' } })
    const framedWith = JSON.stringify((withTitle.options[0] as GenerateOptions).messages)
    expect(framedWith).toContain('原名称')
    expect(framedWith).toContain('旧标题')

    const withoutTitle = bench(answer('🔬 主题'))
    await withoutTitle.run({ policy: { provider: 'p', model: 'm' } })
    expect(JSON.stringify((withoutTitle.options[0] as GenerateOptions).messages)).not.toContain('原名称')
  })

  it('cites exactly the messages the frame carried, oldest first', async () => {
    const harness = bench(answer('🔬 主题'))
    const result = resultOf(await harness.run({
      policy: { provider: 'p', model: 'm' },
      messages: [{ seq: 4, text: 'a' }, { seq: 9, text: 'b' }],
    }))
    expect(result.messageSeqs).toEqual([4, 9])
  })

  it('keeps the first message plus the seven most recent, dropping the middle', async () => {
    const harness = bench(answer('🔬 主题'))
    const messages = Array.from({ length: 12 }, (_, index) => ({ seq: index + 1, text: `m${index + 1}` }))
    const result = resultOf(await harness.run({ policy: { provider: 'p', model: 'm' }, messages }))
    // First (1) plus the last seven (6..12) — the conversation's opening intent
    // and where it actually went.
    expect(result.messageSeqs).toEqual([1, 6, 7, 8, 9, 10, 11, 12])
  })

  it('drops the oldest non-first message until the frame fits the byte cap', async () => {
    const harness = bench(answer('🔬 主题'))
    // 400 NULs per message escape to 2 400 JSON bytes each, so the eight selected
    // messages (~19 kB) blow the 6 000-byte frame and the trim can only stop once
    // the first message plus the newest one remain. The first is never dropped.
    const messages = Array.from({ length: 9 }, (_, index) => ({
      seq: index + 1,
      text: '\u0000'.repeat(400),
    }))
    const result = resultOf(await harness.run({ policy: { provider: 'p', model: 'm' }, messages }))
    expect(result.messageSeqs).toEqual([1, 9])
  })

  it('refuses rather than trimming when even a lone message cannot fit the frame', async () => {
    // The last-resort arm of the trim: one message is capped at MAX_MESSAGE_CHARS,
    // but `currentTitle` is NOT capped, so an oversized standing title is what can
    // reach this throw. It exists to catch the constants drifting apart, and the
    // honest thing is to refuse rather than send a frame past the cap.
    const harness = bench(answer('🔬 主题'))
    expect(refusalOf(await harness.run({
      policy: { provider: 'p', model: 'm' },
      currentTitle: 'x'.repeat(8000),
    }))).toContain('framed title input exceeds 6000 bytes')
    expect(harness.options).toHaveLength(0)
  })

  it('caps each message at 400 characters before framing', async () => {
    const harness = bench(answer('🔬 主题'))
    const result = resultOf(await harness.run({
      policy: { provider: 'p', model: 'm' },
      messages: [{ seq: 1, text: 'y'.repeat(900) }],
    }))
    expect(result.messageSeqs).toEqual([1])
    const framed = JSON.stringify((harness.options[0] as GenerateOptions).messages)
    // The citation still names the message; only its carried text is capped.
    expect(framed).toContain('y'.repeat(400))
    expect(framed).not.toContain('y'.repeat(401))
  })

  it('refuses when no eligible message exists to derive a topic from', async () => {
    const harness = bench(answer('🔬 主题'))
    expect(refusalOf(await harness.run({ policy: { provider: 'p', model: 'm' }, messages: [] })))
      .toContain('at least one source message is required')
    expect(harness.options).toHaveLength(0)
  })
})

describe('deriveTitle - the auxiliary answer', () => {
  it('accepts a well-formed answer and normalizes it to the canonical line', async () => {
    const harness = bench(answer('🐛｜修复 会话标题'))
    const result = resultOf(await harness.run({ policy: { provider: 'p', model: 'm' } }))
    expect(result.title).toBe('🐛 修复 会话标题')
  })

  it('joins several text blocks rather than keeping only the first', async () => {
    const harness = bench([
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'text-delta', index: 0, text: '🔬 会话' },
      { type: 'block-end', index: 0, block: { type: 'text', text: '🔬 会话' } },
      { type: 'block-start', index: 1, blockType: 'text' },
      { type: 'text-delta', index: 1, text: '标题接缝' },
      { type: 'block-end', index: 1, block: { type: 'text', text: '标题接缝' } },
      { type: 'finish', reason: { kind: 'stop' } },
    ] as StreamChunk[])
    const result = resultOf(await harness.run({ policy: { provider: 'p', model: 'm' } }))
    expect(result.title).toBe('🔬 会话 标题接缝')
  })

  it('refuses a tool call in the answer', async () => {
    const harness = bench([
      { type: 'block-start', index: 0, blockType: 'tool-call' },
      { type: 'block-end', index: 0, block: { type: 'tool-call', id: 'call-1', name: 'x', arguments: '{}' } },
      { type: 'finish', reason: { kind: 'stop' } },
    ] as StreamChunk[])
    expect(refusalOf(await harness.run({ policy: { provider: 'p', model: 'm' } })))
      .toContain('title output must contain text only')
  })

  it.each([
    ['max-tokens', { kind: 'max-tokens' }, 'reached maxOutputTokens'],
    ['tool-calls', { kind: 'tool-calls' }, 'unexpectedly requested a tool'],
  ])('refuses a %s finish reason', async (_name, reason, expected) => {
    const harness = bench([{ type: 'finish', reason }] as StreamChunk[])
    expect(refusalOf(await harness.run({ policy: { provider: 'p', model: 'm' } }))).toContain(expected)
  })

  it('carries the provider failure message and code out of an error finish', async () => {
    const harness = bench([{
      type: 'finish',
      reason: { kind: 'error', failure: { message: 'upstream exploded', code: 'E_UPSTREAM' } },
    }] as StreamChunk[])
    const refusal = await harness.run({ policy: { provider: 'p', model: 'm' } })
    expect(refusalOf(refusal)).toBe('upstream exploded')
    expect((refusal as Error & { code?: string }).code).toBe('E_UPSTREAM')
  })

  it('carries an aborted finish out the same way', async () => {
    const harness = bench([{
      type: 'finish',
      reason: { kind: 'aborted', failure: { message: 'aborted by caller', code: 'E_ABORTED' } },
    }] as StreamChunk[])
    expect(refusalOf(await harness.run({ policy: { provider: 'p', model: 'm' } })))
      .toBe('aborted by caller')
  })

  it('refuses a finish reason this plugin does not know', async () => {
    // `FinishReasonMap` is merge-extensible, so an adapter can surface a kind
    // this switch has never heard of; the default arm is what keeps it honest.
    const unknown = [{ type: 'finish', reason: { kind: 'content-filter' } }] as unknown as StreamChunk[]
    const harness = bench(unknown)
    expect(refusalOf(await harness.run({ policy: { provider: 'p', model: 'm' } })))
      .toContain('unsupported finish reason "content-filter"')
  })

  it('refuses an answer the model declined to give a topic for', async () => {
    const harness = bench(answer('UNCHANGED'))
    expect(refusalOf(await harness.run({ policy: { provider: 'p', model: 'm' } })))
      .toContain('declined to name a topic')
  })

})

describe('deriveTitle - cancellation', () => {
  it('refuses before dispatching when the caller already aborted', async () => {
    const harness = bench(answer('🔬 主题'))
    harness.controller.abort()
    expect(await harness.run({ policy: { provider: 'p', model: 'm' } })).toBeInstanceOf(Error)
    expect(harness.options).toHaveLength(0)
  })

  it('stops assembling a stream superseded mid-flight', async () => {
    const controller = new AbortController()
    const options: GenerateOptions[] = []
    const llm: TitleModelAccess = {
      stream(dispatched: GenerateOptions): AsyncIterable<StreamChunk> {
        options.push(dispatched)
        return (async function* () {
          yield { type: 'block-start', index: 0, blockType: 'text' } as StreamChunk
          controller.abort()
          yield { type: 'text-delta', index: 0, text: '🔬 主题' } as StreamChunk
        })()
      },
    }
    const request = {
      session: { id: 's', append: () => undefined },
      messages: [{ seq: 1, text: 'x' }],
      signal: controller.signal,
    } as unknown as SessionTitleProviderRequest
    await expect(deriveTitle({ policy: { provider: 'p', model: 'm' }, request, currentTitle: undefined, llm }))
      .rejects.toThrow()
  })

  it('refuses a stream that ends after the deadline signal fired', async () => {
    const controller = new AbortController()
    const llm: TitleModelAccess = {
      stream(): AsyncIterable<StreamChunk> {
        return (async function* () {
          yield { type: 'block-start', index: 0, blockType: 'text' } as StreamChunk
          controller.abort()
          yield { type: 'finish', reason: { kind: 'stop' } } as StreamChunk
        })()
      },
    }
    const request = {
      session: { id: 's', append: () => undefined },
      messages: [{ seq: 1, text: 'x' }],
      signal: controller.signal,
    } as unknown as SessionTitleProviderRequest
    await expect(deriveTitle({ policy: { provider: 'p', model: 'm' }, request, currentTitle: undefined, llm }))
      .rejects.toThrow()
  })
})

/**
 * The Loader row adapter: the only place `Volatile` appears. Since the module now
 * takes plain values, "read the live policy on every call" is no longer
 * structural — it is this closure's job, and it is pinned here.
 */
describe('the Loader row adapter', () => {
  function stubContext(parts: { sessionTitle: unknown; llm: unknown }): Context {
    return {
      ...parts,
      inject: () => undefined,
      effect: () => undefined,
    } as unknown as Context
  }

  function liveConfig(values: { provider?: string; model?: string; reasoningEffort?: string }): Config {
    return {
      provider: { get: () => values.provider },
      model: { get: () => values.model },
      reasoningEffort: { get: () => values.reasoningEffort },
    } as unknown as Config
  }

  function captured(): { ctx: Context, provider: () => SessionTitleProvider } {
    let registered: SessionTitleProvider | undefined
    const ctx = stubContext({
      sessionTitle: {
        register: (provider: SessionTitleProvider) => { registered = provider },
        get: (): SessionTitleSnapshot | undefined => undefined,
      },
      llm: { stream: vi.fn() },
    })
    return {
      ctx,
      provider: () => {
        if (registered === undefined) throw new Error('apply() registered no provider')
        return registered
      },
    }
  }

  it('keeps the first-prompt cadence and the plugin id', () => {
    const { ctx, provider } = captured()
    apply(ctx)
    expect(provider().id).toBe('session-title-rules')
    expect(provider().automatic).toBe('first-prompt')
  })

  it('reads the live config on every call, not once at registration', async () => {
    // A volatile field is a reference: a Settings write must reach the NEXT
    // title without reloading the plugin.
    let provider = 'first'
    let model = 'first-model'
    let registered: SessionTitleProvider | undefined
    const options: GenerateOptions[] = []
    const ctx = stubContext({
      sessionTitle: {
        register: (candidate: SessionTitleProvider) => { registered = candidate },
        get: () => undefined,
      },
      llm: {
        stream: (dispatched: GenerateOptions): AsyncIterable<StreamChunk> => {
          options.push(dispatched)
          return streamOf(answer('🔬 主题'))
        },
      },
    })
    const config = {
      provider: { get: () => provider },
      model: { get: () => model },
      reasoningEffort: { get: () => undefined },
    } as unknown as Config
    apply(ctx, config)
    const request = {
      session: { id: 's', append: () => undefined },
      messages: [{ seq: 1, text: '为标题选择一个模型' }],
      signal: new AbortController().signal,
    } as unknown as SessionTitleProviderRequest

    await registered?.generate(request)
    provider = 'second'
    model = 'second-model'
    await registered?.generate(request)

    expect(options.map(option => `${option.provider}/${option.model}`)).toEqual([
      'first/first-model',
      'second/second-model',
    ])
  })

  it('hands the service the standing title, so the model sees 原名称', async () => {
    let registered: SessionTitleProvider | undefined
    const options: GenerateOptions[] = []
    const ctx = stubContext({
      sessionTitle: {
        register: (candidate: SessionTitleProvider) => { registered = candidate },
        get: () => ({ title: '服务里的旧标题' }) as unknown as SessionTitleSnapshot,
      },
      llm: {
        stream: (dispatched: GenerateOptions): AsyncIterable<StreamChunk> => {
          options.push(dispatched)
          return streamOf(answer('🔬 主题'))
        },
      },
    })
    apply(ctx, liveConfig({ provider: 'p', model: 'm' }))
    await registered?.generate({
      session: { id: 's', append: () => undefined },
      messages: [{ seq: 1, text: 'x' }],
      signal: new AbortController().signal,
    } as unknown as SessionTitleProviderRequest)
    expect(JSON.stringify(options[0]?.messages)).toContain('服务里的旧标题')
  })
})
