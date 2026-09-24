/**
 * The route-resolution contract behind `generateTitle`.
 *
 * This is the one decision that changes which model writes a title, and it has
 * three outcomes the plugin must keep distinct:
 *
 * 1. an explicit `provider`+`model` pair wins over the session's own route;
 * 2. an absent pair falls back to the Session's logged `request/header` route —
 *    the original behaviour, preserved exactly;
 * 3. half a pair is a REFUSAL, never a silent fallback to the session route,
 *    because a deployment that set only `provider` asked for something the
 *    plugin cannot honour and quietly titles with a different model instead.
 *
 * `resolveTitleRoute` is not exported (it is internal to the provider), so these
 * rows drive it through the public `apply()` seam with a stubbed
 * `ctx.sessionTitle.register`: the registered `generate` closure is the real
 * call path, which keeps the test honest about the wiring rather than only
 * about a helper.
 */
import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import type { SessionTitleProvider, SessionTitleProviderRequest } from '@deepseek-ai/dsh-session-title'
import { apply, type Config } from '../src/index.ts'

/**
 * Build the minimal `Context` `apply()` needs. `apply` also registers the
 * `/title-refresh` command through `ctx.inject(['commands'], …)`; that wiring is
 * covered by `command.spec.ts`, so the stub answers the injection without
 * running its callback and this suite stays about route resolution only.
 * @param parts - the sessionTitle and llm faces under test.
 * @returns the stub context.
 */
function stubContext(parts: {
  sessionTitle: unknown
  llm: unknown
}): Context {
  return {
    ...parts,
    inject: () => undefined,
    effect: () => undefined,
  } as unknown as Context
}

/** A `Volatile`-shaped stand-in: the provider only ever calls `.get()`. */
function volatile<T>(value: T): { get: () => T } {
  return { get: () => value }
}

/** Live-policy config as the Loader would hand it to `apply`. */
function config(values: { provider?: string; model?: string; reasoningEffort?: string }): Config {
  return {
    provider: volatile(values.provider),
    model: volatile(values.model),
    reasoningEffort: volatile(values.reasoningEffort),
  } as unknown as Config
}

/** The model options one `apply` + `generate` call actually dispatched. */
interface Harness {
  readonly options: GenerateOptions[]
  readonly request: SessionTitleProviderRequest
}

/**
 * Register the provider against a stub service, then run one generation and
 * return the exact `GenerateOptions` it streamed.
 * @param policy - live config to hand `apply`, or undefined for no config.
 * @param route - the session route the service would supply, if any.
 * @returns the dispatched options, or the thrown failure.
 */
async function dispatch(
  policy: Config | undefined,
  route: { provider: string; model: string } | undefined,
): Promise<Harness | Error> {
  let registered: SessionTitleProvider | undefined
  const options: GenerateOptions[] = []
  const session = {
    id: 'session-1',
    append: () => undefined,
    // `generateTitle` reads the standing title through the service, not the
    // session, so the session only needs to exist.
  }
  const ctx = stubContext({
    sessionTitle: {
      register: (provider: SessionTitleProvider) => { registered = provider },
      get: () => undefined,
    },
    llm: {
      // One terminal chunk is enough: the provider validates the FINISH reason,
      // and `stop` with a well-formed title is the accepted shape.
      stream: (dispatched: GenerateOptions): AsyncIterable<StreamChunk> => {
        options.push(dispatched)
        return (async function* () {
          yield { type: 'block-start', index: 0, blockType: 'text' } as StreamChunk
          yield { type: 'text-delta', index: 0, text: '🔬 标题模型选择' } as StreamChunk
          yield { type: 'block-end', index: 0, block: { type: 'text', text: '🔬 标题模型选择' } } as StreamChunk
          yield { type: 'finish', reason: { kind: 'stop' } } as StreamChunk
        })()
      },
    },
  })

  apply(ctx, policy)
  const provider = registered
  if (provider === undefined) throw new Error('apply() registered no provider')

  const request = {
    session,
    messages: [{ seq: 1, text: '为标题选择一个模型' }],
    ...route === undefined ? {} : { route },
    signal: new AbortController().signal,
  } as unknown as SessionTitleProviderRequest

  try {
    await provider.generate(request)
  } catch (error: unknown) {
    return error instanceof Error ? error : new Error(String(error))
  }
  return { options, request }
}

/** Assert a dispatch succeeded and return its options. */
async function optionsOf(
  policy: Config | undefined,
  route: { provider: string; model: string } | undefined,
): Promise<GenerateOptions> {
  const result = await dispatch(policy, route)
  if (result instanceof Error) throw result
  return result.options[0] as GenerateOptions
}

describe('auxiliary route resolution', () => {
  it('prefers an explicit provider/model pair over the session route', async () => {
    const options = await optionsOf(
      config({ provider: 'cliproxyapi', model: 'cc/deepseek-v4.1-flash' }),
      { provider: 'deepseek-official', model: 'deepseek-flash' },
    )
    expect(options).toMatchObject({ provider: 'cliproxyapi', model: 'cc/deepseek-v4.1-flash' })
  })

  it('falls back to the session route when no pair is configured', async () => {
    const options = await optionsOf(config({}), { provider: 'cliproxyapi', model: 'ollama/glm-5.3' })
    expect(options).toMatchObject({ provider: 'cliproxyapi', model: 'ollama/glm-5.3' })
  })

  it('falls back to the session route when the row carries no config at all', async () => {
    const options = await optionsOf(undefined, { provider: 'main', model: 'chat' })
    expect(options).toMatchObject({ provider: 'main', model: 'chat' })
  })

  it('refuses a provider with no model instead of falling back', async () => {
    const result = await dispatch(config({ provider: 'cliproxyapi' }), { provider: 'main', model: 'chat' })
    // Falling back here would title with a model the deployment did not choose.
    expect(result).toBeInstanceOf(Error)
    expect((result as Error).message).toContain('provider and model must be configured together')
  })

  it('refuses a model with no provider instead of falling back', async () => {
    const result = await dispatch(config({ model: 'cc/deepseek-v4.1-flash' }), { provider: 'main', model: 'chat' })
    expect(result).toBeInstanceOf(Error)
    expect((result as Error).message).toContain('provider and model must be configured together')
  })

  it('still refuses when neither a pair nor a session route exists', async () => {
    const result = await dispatch(config({}), undefined)
    expect(result).toBeInstanceOf(Error)
    expect((result as Error).message).toContain('no logged request route is available')
  })

  it('an explicit pair works before any session route exists', async () => {
    // This is the case the override exists for: `/title-refresh` on a session
    // whose first model request has not happened yet has no logged route.
    const options = await optionsOf(
      config({ provider: 'cliproxyapi', model: 'cc/deepseek-v4.1-flash' }),
      undefined,
    )
    expect(options).toMatchObject({ provider: 'cliproxyapi', model: 'cc/deepseek-v4.1-flash' })
  })

  it('omits reasoningEffort entirely when none is configured', async () => {
    const options = await optionsOf(config({ provider: 'p', model: 'm' }), undefined)
    // Absent, not undefined-valued: the seam reads presence, and pi-ai applies
    // the profile's own effort when the field is missing.
    expect('reasoningEffort' in options).toBe(false)
  })

  it('passes a configured reasoningEffort through to the request', async () => {
    const options = await optionsOf(
      config({ provider: 'p', model: 'm', reasoningEffort: 'off' }),
      undefined,
    )
    expect(options.reasoningEffort).toBe('off')
  })

  it('applies the configured effort to a fallback route too', async () => {
    const options = await optionsOf(
      config({ reasoningEffort: 'low' }),
      { provider: 'main', model: 'chat' },
    )
    expect(options).toMatchObject({ provider: 'main', model: 'chat', reasoningEffort: 'low' })
  })

  it('reads the live config on every call, not once at registration', async () => {
    // A volatile field is a reference: a Settings write must reach the NEXT
    // title without reloading the plugin.
    let provider = 'first'
    let model = 'first-model'
    const live = {
      provider: { get: () => provider },
      model: { get: () => model },
      reasoningEffort: { get: () => undefined },
    } as unknown as Config

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
          return (async function* () {
            yield { type: 'block-start', index: 0, blockType: 'text' } as StreamChunk
            yield { type: 'text-delta', index: 0, text: '🔬 主题' } as StreamChunk
            yield { type: 'block-end', index: 0, block: { type: 'text', text: '🔬 主题' } } as StreamChunk
            yield { type: 'finish', reason: { kind: 'stop' } } as StreamChunk
          })()
        },
      },
    })
    apply(ctx, live)
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

  it('reports the route it actually used as the title provenance', async () => {
    // The logged `session/title` source.model must name the override, not the
    // session route: provenance that disagrees with the call is a lie.
    let registered: SessionTitleProvider | undefined
    const ctx = stubContext({
      sessionTitle: {
        register: (candidate: SessionTitleProvider) => { registered = candidate },
        get: () => undefined,
      },
      llm: {
        stream: (): AsyncIterable<StreamChunk> => (async function* () {
          yield { type: 'block-start', index: 0, blockType: 'text' } as StreamChunk
          yield { type: 'text-delta', index: 0, text: '🔬 主题' } as StreamChunk
          yield { type: 'block-end', index: 0, block: { type: 'text', text: '🔬 主题' } } as StreamChunk
          yield { type: 'finish', reason: { kind: 'stop' } } as StreamChunk
        })(),
      },
    })
    apply(ctx, config({ provider: 'cliproxyapi', model: 'cc/deepseek-v4.1-flash' }))
    const result = await registered?.generate({
      session: { id: 's', append: () => undefined },
      messages: [{ seq: 1, text: '为标题选择一个模型' }],
      route: { provider: 'main', model: 'chat' },
      signal: new AbortController().signal,
    } as unknown as SessionTitleProviderRequest)
    expect(result?.model).toEqual({ provider: 'cliproxyapi', model: 'cc/deepseek-v4.1-flash' })
  })

  it('never sends a tool schema or a second message', async () => {
    const options = await optionsOf(config({ provider: 'p', model: 'm' }), undefined)
    expect(options.messages).toHaveLength(1)
    expect(options.tools).toBeUndefined()
    expect(options.purpose).toBe('session-title')
  })
})

describe('provider registration', () => {
  it('keeps the first-prompt cadence and the plugin id', () => {
    let registered: SessionTitleProvider | undefined
    const ctx = stubContext({
      sessionTitle: { register: (candidate: SessionTitleProvider) => { registered = candidate }, get: () => undefined },
      llm: { stream: vi.fn() },
    })
    apply(ctx)
    expect(registered?.id).toBe('session-title-rules')
    expect(registered?.automatic).toBe('first-prompt')
  })
})
