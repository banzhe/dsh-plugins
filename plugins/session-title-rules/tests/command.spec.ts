/**
 * `/title-refresh` command contract.
 *
 * The registration half runs the real `CommandRuntime` over a real Cordis
 * context, because the interesting facts are the catalog row the composer reads
 * (name, description, and the ABSENCE of an input hint, which is what makes a
 * bare pick execute) and that an argument-free line really reaches the handler.
 * The outcome half drives the handler directly with a stub `refresh`, so each
 * result mapping is pinned without a live model call or a real Session log.
 */
import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import CommandRuntime, { CommandId } from '@deepseek-ai/dsh-commands'
import type { CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands'
import type { SessionTitleSnapshot } from '@deepseek-ai/dsh-session-title'
import {
  executeTitleRefresh,
  registerTitleRefreshCommand,
  TITLE_REFRESH_COMMAND_NAME,
  type TitleRefreshTarget,
} from '../src/command.ts'

/** The agent shape the registry hands a handler, named without a direct dep. */
type TestAgent = CommandInvocation['agent']

const TITLE = '0916｜研究｜会话标题刷新命令'

/** A snapshot as `refresh()` returns it; only `title` is read by the command. */
const SNAPSHOT = {
  title: TITLE,
  messageSeqs: [],
  source: { kind: 'provider', provider: 'session-title-rules' },
  eventSeq: 12,
  updatedAt: 1_760_000_000_000,
} as unknown as SessionTitleSnapshot

/**
 * A Session stand-in that records what reaches it. The command never reads the
 * log — it delegates to `refresh()` — so the only real behaviour under test is
 * that an admitted command still writes its `command/run`/`command/done` pair,
 * which is exactly what `append` observes.
 */
interface RecordedSession {
  readonly recorded: Array<{ type: string; data: unknown }>
  append(type: string, data: unknown): unknown
}

function recordingSession(): RecordedSession {
  const recorded: Array<{ type: string; data: unknown }> = []
  return { recorded, append: (type, data) => { recorded.push({ type, data }); return undefined } }
}

/** One recording Session and the stand-in agent the registry addresses commands to. */
function testAgent(): { agent: TestAgent; session: RecordedSession } {
  const session = recordingSession()
  const agent = {
    session,
    status: 'idle',
    options: {},
    reserveTurnAdmission: () => () => undefined,
  } as unknown as TestAgent
  return { agent, session }
}

/** A stub title service recording the exact call it received. */
function stubTarget(): {
  target: TitleRefreshTarget
  refresh: ReturnType<typeof vi.fn>
} {
  const refresh = vi.fn(async () => SNAPSHOT)
  return { target: { refresh }, refresh }
}

/** One admitted invocation with an overridable raw input and signal. */
function invocation(
  agent: TestAgent,
  overrides: { rawInput?: string; signal?: AbortSignal } = {},
): CommandInvocation {
  return {
    commandId: CommandId('cmd-test-1'),
    agent,
    rawInput: overrides.rawInput ?? '',
    attachments: [],
    signal: overrides.signal ?? new AbortController().signal,
  }
}

/** Await the `ctx.inject` child that mounts once `commands` resolves. */
function settle(): Promise<void> {
  return new Promise(resolve => setImmediate(resolve))
}

describe(`/${TITLE_REFRESH_COMMAND_NAME} registration`, () => {
  it('contributes one catalog row with no input hint, and executes a bare line', async () => {
    const ctx = new Context()
    const { agent, session } = testAgent()
    const { target, refresh } = stubTarget()
    ctx.provide('sessionTitle', target as never)
    await ctx.plugin(CommandRuntime)
    registerTitleRefreshCommand(ctx)
    await settle()

    expect(ctx.commands.list(agent)).toEqual([{
      name: 'title-refresh',
      description: 'Regenerate this session title from the conversation',
    }])

    const execution = await ctx.commands.execute(agent, `/${TITLE_REFRESH_COMMAND_NAME}`, [], new AbortController().signal)
    expect(execution?.result).toEqual({ kind: 'success', text: `Regenerated title: ${TITLE}` })
    expect(session.recorded.map(event => event.type)).toEqual(['command/run', 'command/done'])
    expect(refresh).toHaveBeenCalledWith(session, expect.any(AbortSignal))
  })

  it('does not mount where no command registry is composed', () => {
    const ctx = new Context()
    registerTitleRefreshCommand(ctx)
    // The child stays parked instead of throwing, so the provider still loads
    // in a Profile that composes no human-command adapter.
    expect(ctx.get('commands')).toBeUndefined()
  })

  it('withdraws the catalog row when its owning fiber unloads', async () => {
    const ctx = new Context()
    const { agent } = testAgent()
    const { target } = stubTarget()
    ctx.provide('sessionTitle', target as never)
    await ctx.plugin(CommandRuntime)
    // The profile reloads patches live, so a reload must not leave a second
    // `title-refresh` behind: the child fiber has to take the row with it.
    const owner = await ctx.plugin({
      apply: (ownerCtx: Context) => { registerTitleRefreshCommand(ownerCtx) },
    })
    await settle()
    expect(ctx.commands.list(agent)).toHaveLength(1)

    await owner.dispose()
    expect(ctx.commands.list(agent)).toEqual([])
  })
})

describe('executeTitleRefresh', () => {
  it('reports the accepted title and cites no source event', async () => {
    const { agent, session } = testAgent()
    const { target, refresh } = stubTarget()
    const result = await executeTitleRefresh(target, invocation(agent))
    expect(result).toEqual({ kind: 'success', text: `Regenerated title: ${TITLE}` })
    expect(refresh).toHaveBeenCalledExactlyOnceWith(session, expect.any(AbortSignal))
  })

  it('refuses any argument without touching the title service', async () => {
    const { agent } = testAgent()
    const { target, refresh } = stubTarget()
    const result = await executeTitleRefresh(target, invocation(agent, { rawInput: ' extra' }))
    expect(result).toEqual({
      kind: 'error',
      text: `Usage: /${TITLE_REFRESH_COMMAND_NAME} (no arguments)`,
    })
    expect(refresh).not.toHaveBeenCalled()
  })

  it('errors when no eligible conversation text exists yet', async () => {
    const { agent } = testAgent()
    const refresh = vi.fn(async () => undefined)
    const result = await executeTitleRefresh({ refresh }, invocation(agent))
    expect(result).toEqual({ kind: 'error', text: 'No conversation text to derive a title from yet.' })
  })

  it('surfaces the provider failure that made the refresh fail', async () => {
    const { agent } = testAgent()
    const refresh = vi.fn(() => Promise.reject(
      new Error('session-title-rules: no logged request route is available for this session'),
    ))
    const result = await executeTitleRefresh({ refresh }, invocation(agent))
    expect(result).toEqual({
      kind: 'error',
      text: 'Could not regenerate the title: session-title-rules: no logged request route is available for this session',
    })
  })

  it('renders a non-Error rejection through its string form', async () => {
    const { agent } = testAgent()
    const refresh = vi.fn(() => Promise.reject('plain string failure'))
    const result = await executeTitleRefresh({ refresh }, invocation(agent))
    expect(result).toEqual({
      kind: 'error',
      text: 'Could not regenerate the title: plain string failure',
    })
  })

  it('keeps a chained cause visible in the failure text', async () => {
    const { agent } = testAgent()
    // The provider aborts composed signals, so the useful reason is often the
    // cause rather than the wrapper message.
    const refresh = vi.fn(() => Promise.reject(
      new Error('session-title-rules: title generation superseded', { cause: new Error('timeout') }),
    ))
    const result = await executeTitleRefresh({ refresh }, invocation(agent))
    expect(result).toEqual({
      kind: 'error',
      text: 'Could not regenerate the title: session-title-rules: title generation superseded: timeout',
    })
  })

  it('reports cancellation when the dispatch request aborts mid-refresh', async () => {
    const { agent } = testAgent()
    const controller = new AbortController()
    // The UI abort is what supersedes a title call, so the abort arrives while
    // the refresh is in flight — which is the only path that reaches this text.
    const refresh = vi.fn(async () => {
      controller.abort()
      throw new Error('title generation superseded')
    })
    const result = await executeTitleRefresh({ refresh }, invocation(agent, { signal: controller.signal }))
    expect(result).toEqual({ kind: 'error', text: 'Title refresh cancelled.' })
  })

  it('keeps the title unchanged on every failure path', async () => {
    const { agent, session } = testAgent()
    const failures: Promise<CommandResult>[] = [
      executeTitleRefresh(stubTarget().target, invocation(agent, { rawInput: 'x' })),
      executeTitleRefresh({ refresh: async () => undefined }, invocation(agent)),
      executeTitleRefresh({ refresh: () => Promise.reject(new Error('boom')) }, invocation(agent)),
    ]
    for (const settled of await Promise.all(failures)) expect(settled.kind).toBe('error')
    // Nothing but `refresh()` may write a title, and `refresh` appends only a
    // validated result, so the handler itself writes no title event at all.
    expect(session.recorded.some(event => event.type === 'session/title')).toBe(false)
  })
})
