import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { IconWorkspaceTreeOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: merges sessionId and useSessions onto the session standard kit.
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type { TopicAnalyzeSpan, TopicProvider } from '../shared.ts'
import { EMPTY_PROGRESS_GRAPH, type ProgressGraph } from '../progress-graph.ts'
import { analyzeSession, readModels, readState, type TopicFailure } from './api.ts'
import { clearFocus, focusTurn } from './anchor.ts'
import { runDrain, waitFor } from './drain.ts'
import { layoutGraph } from './graph-layout.ts'
import type { SessionTopicMapKey } from './locales.ts'
import css from './panel.module.css'

interface TopicMapTabInfo {
  tab: { title: string }
}

/**
 * The two `sidebar.right.pane.tab` seats, restated for this package's own type check.
 *
 * ui-sidebar-right owns both keys and declares them as keyed session slots. The
 * seat supplies the session standard kit and the body's own hook context, so this
 * module names only what it renders with. That package ships no types and is not
 * a workspace dependency, so the declaration is restated here.
 */
declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    'sidebar.right.pane.tab': {
      kind: 'keyed'
      scope: 'session'
      keyProps: Record<string, object>
      hookContext: unknown
      inject: { hooks: { tabInfo: (standard: object, hookContext: unknown) => () => TopicMapTabInfo } }
    }
    'sidebar.right.pane.tab.title': {
      kind: 'keyed'
      scope: 'session'
      keyProps: Record<string, object>
      hookContext: unknown
      inject: { hooks: { tabInfo: (standard: object, hookContext: unknown) => () => TopicMapTabInfo } }
    }
  }

  interface LocaleNamespaceMap {
    'session-topic-map': SessionTopicMapKey
  }
}

export type SessionTopicMapBodyProps =
  PropsRuntime<'sidebar.right.pane.tab'>
  & PropsLocale<'session-topic-map'>

export type SessionTopicMapTitleProps = PropsRuntime<'sidebar.right.pane.tab.title'>

/** One confirmed route; both halves travel together. */
interface ModelChoice {
  readonly provider: string
  readonly model: string
}

/** Longest topic label a box draws before it is truncated. */
const MAX_DRAWN_TOPIC = 10

/** The provider's first model, which is the one a pick starts on. */
function firstChoiceOf(provider: TopicProvider): ModelChoice | null {
  const model = provider.models[0]
  return model === undefined ? null : { provider: provider.provider, model: model.id }
}

function firstChoiceOfAny(providers: readonly TopicProvider[]): ModelChoice | null {
  for (const provider of providers) {
    const choice = firstChoiceOf(provider)
    if (choice !== null) return choice
  }
  return null
}

function drawnTopic(topic: string): string {
  return topic.length <= MAX_DRAWN_TOPIC ? topic : topic.slice(0, MAX_DRAWN_TOPIC - 1) + '…'
}

/**
 * What the panel says about a failed call: the Host's own message when it sent
 * one, the specific copy for the two failures a user can act on, and otherwise a
 * description of the transport that failed.
 */
function describeFailure(t: SessionTopicMapBodyProps['t'], failure: TopicFailure): string {
  if (failure.kind === 'timeout') return t('failure.timeout')
  if (failure.kind === 'network') return t('failure.network')
  if (failure.message !== null) return failure.message
  if (failure.kind === 'http') {
    return t('failure.http', { status: failure.status === null ? '-' : String(failure.status) })
  }
  return t('failure.body')
}

/** The meta row: the reply's own seq. */
function metaOf(node: { readonly seq: number }): string {
  return '#' + String(node.seq)
}

/**
 * The tab body: pick a model, confirm, and watch the Session's graph keep up.
 *
 * Two rules shape this component. No model is called before the user confirms —
 * the request carries `confirm: true` only from the start button, and the Host
 * refuses a request without it. And once running, the panel keeps analyzing in
 * the background: while a run finds messages it runs again immediately, and when
 * it finds none it looks again after {@link DRAIN_INTERVAL_MS}, which never
 * reaches a model. Pausing, switching Session, or unmounting aborts the loop and
 * leaves the button requiring a fresh confirmation.
 */
export function SessionTopicMapBody({ t, sessionId }: SessionTopicMapBodyProps): ReactNode {
  const [providers, setProviders] = useState<readonly TopicProvider[] | null>(null)
  const [choice, setChoice] = useState<ModelChoice | null>(null)
  const [graph, setGraph] = useState<ProgressGraph>(EMPTY_PROGRESS_GRAPH)
  const [span, setSpan] = useState<TopicAnalyzeSpan | null>(null)
  const [running, setRunning] = useState(false)
  const [notice, setNotice] = useState<{ text: string; failed: boolean } | null>(null)
  const [failure, setFailure] = useState<TopicFailure | null>(null)
  const [modelsFailure, setModelsFailure] = useState<TopicFailure | null>(null)
  const loop = useRef<AbortController | null>(null)
  const focused = useRef<HTMLElement | null>(null)
  const alive = useRef(true)

  useEffect(() => {
    // Set on mount, not just at module creation: a remount (React's own strict
    // double-invocation) must revive this instance instead of leaving it dead.
    alive.current = true
    return () => {
      alive.current = false
      loop.current?.abort()
      loop.current = null
      // The outline sits on a chat row this panel does not own, so it goes with
      // the pane that drew it instead of outliving it.
      clearFocus(focused.current)
      focused.current = null
    }
  }, [])

  useEffect(() => {
    const controller = new AbortController()
    void readModels(controller.signal).then((result) => {
      if (controller.signal.aborted || !alive.current) return
      if (!result.ok) {
        setProviders([])
        // The failure itself is kept; its copy is resolved at render so this
        // effect does not depend on the locale identity.
        if (result.kind !== 'cancelled') setModelsFailure(result)
        return
      }
      setModelsFailure(null)
      setProviders(result.providers)
      setChoice((current) => current ?? firstChoiceOfAny(result.providers))
    })
    return () => { controller.abort() }
  }, [])

  useEffect(() => {
    loop.current?.abort()
    loop.current = null
    clearFocus(focused.current)
    focused.current = null
    setRunning(false)
    setGraph(EMPTY_PROGRESS_GRAPH)
    setSpan(null)
    setNotice(null)
    setFailure(null)
    const controller = new AbortController()
    void readState(sessionId, controller.signal).then((result) => {
      if (controller.signal.aborted || !alive.current) return
      if (!result.ok) {
        if (result.kind !== 'cancelled') setFailure(result)
        return
      }
      setGraph(result.state.graph)
    })
    return () => { controller.abort() }
  }, [sessionId])

  const pause = useCallback(() => {
    loop.current?.abort()
    loop.current = null
    if (alive.current) setRunning(false)
  }, [])

  const start = useCallback(() => {
    if (choice === null || loop.current !== null) return
    const controller = new AbortController()
    loop.current = controller
    setRunning(true)
    setNotice(null)
    setFailure(null)
    const { provider, model } = choice
    void runDrain({
      analyze: async (signal) => {
        const result = await analyzeSession({ sessionId, provider, model, confirm: true }, signal)
        if (!result.ok) {
          // A cancelled run is this panel's own pause; anything else is the
          // failure the banner and the retry control exist for.
          if (result.kind !== 'cancelled' && alive.current) setFailure(result)
          throw new Error(result.kind === 'cancelled' ? 'cancelled' : describeFailure(t, result))
        }
        if (alive.current) {
          setFailure(null)
          setGraph(result.result.graph)
          setSpan(result.result.analyzed)
        }
        return { messages: result.result.analyzed.messages, topics: result.result.analyzed.topics }
      },
      wait: waitFor,
      onStep: () => {},
      // The failure is already in state; the loop ends so the button stops
      // claiming the run is alive.
      onFailure: () => {},
    }, controller.signal).finally(() => {
      if (!alive.current || loop.current !== controller) return
      loop.current = null
      setRunning(false)
    })
  }, [choice, sessionId, t])

  const selectProvider = useCallback((known: readonly TopicProvider[], providerId: string) => {
    const provider = known.find(entry => entry.provider === providerId)
    setChoice(provider === undefined ? null : firstChoiceOf(provider))
  }, [])

  const selectModel = useCallback((providerId: string, modelId: string) => {
    setChoice({ provider: providerId, model: modelId })
  }, [])

  const jump = useCallback((turn: number) => {
    const element = focusTurn(document, turn, focused.current)
    focused.current = element
    if (element === null) {
      setNotice({ text: t('panel.focusMissing', { turn }), failed: false })
      return
    }
    // Located by turn, which is all the transcript markers allow: the panel says
    // so rather than implying it found the exact message.
    setNotice({ text: t('panel.turnOnly', { turn }), failed: false })
  }, [t])

  const failureText = failure === null ? null : describeFailure(t, failure)
  const layout = useMemo(() => layoutGraph(graph), [graph])
  const current = providers?.find(entry => entry.provider === choice?.provider)
  let status: string | null = null
  if (running && span === null) {
    status = t('panel.running')
  }
  else if (span !== null) {
    status = span.messages === 0
      ? t('panel.nothingNew')
      : t('panel.analyzed', { messages: span.messages, topics: span.topics })
  }
  else if (graph.checkpoint >= 0) {
    status = t('panel.checkpoint', { seq: graph.checkpoint })
  }

  return (
    <div className={css.root} data-session-topic-map="" data-running={running ? '' : undefined}>
      <div className={css.toolbar}>
        <span className={css.selectLabel}>{t('panel.model')}</span>
        <select
          className={css.select}
          aria-label={t('panel.model')}
          data-session-topic-map-provider=""
          value={choice?.provider ?? ''}
          disabled={providers === null || running}
          onChange={(event) => { if (providers !== null) selectProvider(providers, event.target.value) }}
        >
          {(providers ?? []).map(provider => (
            <option key={provider.provider} value={provider.provider}>{provider.name}</option>
          ))}
        </select>
        <select
          className={css.select}
          aria-label={t('panel.model')}
          data-session-topic-map-model=""
          value={choice?.model ?? ''}
          disabled={current === undefined || running}
          onChange={(event) => { selectModel(choice?.provider ?? '', event.target.value) }}
        >
          {(current?.models ?? []).map(model => (
            <option key={model.id} value={model.id}>{model.name}</option>
          ))}
        </select>
        <button
          type="button"
          className={css.start}
          data-session-topic-map-control=""
          data-state={running ? 'running' : 'idle'}
          disabled={running ? false : choice === null}
          onClick={running ? pause : start}
        >
          {running ? t('panel.pause') : t('panel.start')}
        </button>
      </div>
      <p className={css.hint}>{t('panel.confirmHint')}</p>
      {notice === null ? null : <p className={css.notice} data-failed={notice.failed ? '' : undefined}>{notice.text}</p>}
      {modelsFailure === null
        ? null
        : <p className={css.notice} data-failed="">{describeFailure(t, modelsFailure)}</p>}
      {failureText === null
        ? null
        : (
          <div className={css.failure} data-session-topic-map-error="" role="alert">
            <span className={css.failureText}>{failureText}</span>
            <button
              type="button"
              className={css.retry}
              data-session-topic-map-retry=""
              disabled={running || choice === null}
              onClick={start}
            >
              {t('panel.retry')}
            </button>
          </div>
        )}
      {status === null ? null : <p className={css.status} data-session-topic-map-status="">{status}</p>}
      {modelsFailure === null && providers !== null && providers.length === 0
        ? <p className={css.notice} data-failed="">{t('panel.noModel')}</p>
        : null}
      <div className={css.canvas}>
        {layout.nodes.length === 0
          ? <p className={css.hint}>{t('panel.empty')}</p>
          : (
            <svg
              className={css.graph}
              data-session-topic-map-graph=""
              width={layout.width}
              height={layout.height}
              viewBox={['0 0', layout.width, layout.height].join(' ')}
              role="presentation"
            >
              {layout.edges.map(edge => (
                <path key={edge.from + '->' + edge.to} className={css.edge} data-kind={edge.kind} d={edge.path} />
              ))}
              {layout.nodes.map(node => (
                <g
                  key={node.id}
                  data-session-topic-map-node={node.id}
                  className={css.node}
                  role="button"
                  tabIndex={0}
                  aria-label={t('node.focus')}
                  onClick={() => { jump(node.turn) }}
                  onKeyDown={(event) => {
                    if (event.key !== 'Enter' && event.key !== ' ') return
                    event.preventDefault()
                    jump(node.turn)
                  }}
                >
                  <rect x={node.x} y={node.y} width={node.width} height={node.height} rx={8} />
                  <text className={css.nodeLabel} x={node.x + 10} y={node.y + 19}>{drawnTopic(node.topic)}</text>
                  <text className={css.nodeMeta} x={node.x + 10} y={node.y + 34}>{metaOf(node)}</text>
                </g>
              ))}
            </svg>
          )}
      </div>
    </div>
  )
}

/** The tab chip: icon plus the title captured when the tab opened. */
export function SessionTopicMapTitle({ useTabInfo }: SessionTopicMapTitleProps): ReactNode {
  const { tab } = useTabInfo()
  return (
    <>
      <IconWorkspaceTreeOutlineRegular size={16} className={css.titleIcon} />
      {tab.title}
    </>
  )
}
