// @vitest-environment jsdom
import { act, createElement, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DRAIN_INTERVAL_MS } from '../src/client/drain.ts'
import { zh } from '../src/client/locales.ts'
import { SessionTopicMapBody } from '../src/client/TopicMapPanel.tsx'
import { applyAnalysis, EMPTY_PROGRESS_GRAPH, type AnalysisBatch, type ProgressGraph } from '../src/progress-graph.ts'
import { ANALYZE_TIMEOUT_MS } from '../src/client/api.ts'

interface PanelProps {
  readonly t: (key: string, params?: Record<string, string | number>) => string
  readonly sessionId: string
}

const Panel = SessionTopicMapBody as unknown as (props: PanelProps) => ReactNode

function fill(template: string, params: Record<string, string | number> = {}): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) => (key in params ? String(params[key]) : match))
}

const t = (key: string, params?: Record<string, string | number>): string => {
  const template = zh[key as keyof typeof zh] ?? key
  return fill(template, params)
}

const MODELS = {
  providers: [{ provider: 'p', name: 'P', models: [{ id: 'm', name: 'M' }] }],
}

interface AnalyzeAnswer {
  readonly graph: ProgressGraph
  readonly analyzed: { readonly fromSeq: number; readonly toSeq: number; readonly messages: number; readonly topics: number }
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

function emptyAnswer(): AnalyzeAnswer {
  return { graph: EMPTY_PROGRESS_GRAPH, analyzed: { fromSeq: 0, toSeq: 0, messages: 0, topics: 0 } }
}

function messageAnswer(messages: number): AnalyzeAnswer {
  return { graph: EMPTY_PROGRESS_GRAPH, analyzed: { fromSeq: 1, toSeq: 2, messages, topics: 0 } }
}

type Outcome = (() => Promise<Response>) | AnalyzeAnswer

interface Call {
  readonly url: string
  readonly method: string
  readonly body: unknown
}

interface Harness {
  readonly calls: Call[]
  readonly outcomes: Outcome[]
  stateGraphFor: (sessionId: string) => ProgressGraph
}

function neverSettles(): Promise<Response> {
  return new Promise<Response>(() => {})
}

function installFetch(): Harness {
  const harness: Harness = {
    calls: [],
    outcomes: [],
    stateGraphFor: () => EMPTY_PROGRESS_GRAPH,
  }
  const stub = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    const method = init?.method ?? 'GET'
    const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined
    harness.calls.push({ url, method, body })
    if (url === 'api/session-topic-map/models') return jsonResponse(MODELS)
    if (url.startsWith('api/session-topic-map/state?sessionId=')) {
      const sessionId = decodeURIComponent(url.slice('api/session-topic-map/state?sessionId='.length))
      return jsonResponse({ graph: harness.stateGraphFor(sessionId), updatedAt: null })
    }
    if (url === 'api/session-topic-map/analyze') {
      const next = harness.outcomes.shift() ?? emptyAnswer()
      if (typeof next === 'function') return next()
      return jsonResponse(next)
    }
    return new Response('not found', { status: 404 })
  })
  vi.stubGlobal('fetch', stub)
  return harness
}

function postCalls(harness: Harness): Call[] {
  return harness.calls.filter((call) => call.method === 'POST')
}

function buttonWithText(container: HTMLElement, text: string): HTMLButtonElement | undefined {
  return Array.from(container.querySelectorAll('button')).find((button) => button.textContent?.trim() === text)
}

function nodeGroup(container: HTMLElement, id: string): SVGGElement | null {
  return container.querySelector<SVGGElement>(`[data-session-topic-map-node="${id}"]`)
}

function rectPosition(group: SVGGElement | null): { readonly x: string | null; readonly y: string | null } {
  const rect = group?.querySelector('rect')
  return { x: rect?.getAttribute('x') ?? null, y: rect?.getAttribute('y') ?? null }
}
async function settle(ms = 0): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms)
  })
}

function bodyAt(container: HTMLElement): HTMLElement {
  const panel = container.querySelector<HTMLElement>('[data-session-topic-map]')
  if (!panel) throw new Error('panel root not rendered')
  return panel
}

describe('SessionTopicMapBody', () => {
  let container: HTMLDivElement
  let root: Root | null
  let harness: Harness

  beforeEach(() => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
    vi.useFakeTimers()
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    harness = installFetch()
  })

  afterEach(async () => {
    if (root) {
      await act(async () => {
        root?.unmount()
      })
    }
    root = null
    container.remove()
    document.body.innerHTML = ''
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  async function mount(sessionId: string): Promise<void> {
    await act(async () => {
      root?.render(createElement(Panel, { t, sessionId }))
    })
    await settle()
  }

  async function start(): Promise<void> {
    const button = buttonWithText(container, t('panel.start'))
    if (!button) throw new Error('start button not rendered')
    await act(async () => {
      button.click()
    })
    await settle()
  }

  it('loads models and state on mount and never posts before confirmation', async () => {
    await mount('s1')

    const urls = harness.calls.map((call) => call.url)
    expect(urls.filter((url) => url === 'api/session-topic-map/models')).toHaveLength(1)
    expect(urls.filter((url) => url === 'api/session-topic-map/state?sessionId=s1')).toHaveLength(1)
    expect(postCalls(harness)).toHaveLength(0)
  })

  it('defaults the model picker to the first model and enables the start button', async () => {
    await mount('s1')

    const button = buttonWithText(container, t('panel.start'))
    expect(button).toBeDefined()
    expect(button?.disabled).toBe(false)
    expect(container.textContent).toContain('M')
  })

  it('posts the confirmed request and shows the pause label while running', async () => {
    harness.outcomes.push(messageAnswer(0))
    await mount('s1')
    await start()

    const posts = postCalls(harness)
    expect(posts).toHaveLength(1)
    expect(posts[0]?.url).toBe('api/session-topic-map/analyze')
    expect(posts[0]?.body).toEqual({ sessionId: 's1', provider: 'p', model: 'm', confirm: true })
    expect(buttonWithText(container, t('panel.pause'))).toBeDefined()
  })

  it('drains immediately after a step with messages and waits DRAIN_INTERVAL_MS after an empty step', async () => {
    harness.outcomes.push(messageAnswer(2), messageAnswer(0))
    await mount('s1')
    await start()

    expect(postCalls(harness)).toHaveLength(2)

    await settle(DRAIN_INTERVAL_MS - 1)
    expect(postCalls(harness)).toHaveLength(2)

    await settle(1)
    expect(postCalls(harness)).toHaveLength(3)
  })

  it('pauses: no further POST after the pause button, even after many intervals', async () => {
    await mount('s1')
    await start()
    expect(postCalls(harness)).toHaveLength(1)

    const pause = buttonWithText(container, t('panel.pause'))
    expect(pause).toBeDefined()
    await act(async () => {
      pause?.click()
    })
    const before = postCalls(harness).length

    await settle(DRAIN_INTERVAL_MS * 10)
    expect(postCalls(harness)).toHaveLength(before)
  })

  it('after a pause shows the start button again and needs a fresh click to post', async () => {
    await mount('s1')
    await start()
    const pause = buttonWithText(container, t('panel.pause'))
    await act(async () => {
      pause?.click()
    })
    await settle()

    expect(buttonWithText(container, t('panel.start'))).toBeDefined()
    const before = postCalls(harness).length
    await settle(DRAIN_INTERVAL_MS * 3)
    expect(postCalls(harness)).toHaveLength(before)

    await start()
    expect(postCalls(harness).length).toBe(before + 1)
  })

  it('aborts the loop when the sessionId prop changes and loads the new session state', async () => {
    await mount('s1')
    await start()
    const before = postCalls(harness).length

    await mount('s2')
    await settle(DRAIN_INTERVAL_MS * 5)

    expect(harness.calls.some((call) => call.url === 'api/session-topic-map/state?sessionId=s2')).toBe(true)
    expect(postCalls(harness)).toHaveLength(before)
    expect(postCalls(harness).some((call) => (call.body as { sessionId?: string }).sessionId === 's2')).toBe(false)
  })

  it('aborts the loop on unmount', async () => {
    await mount('s1')
    await start()
    const before = postCalls(harness).length

    await act(async () => {
      root?.unmount()
    })
    root = null
    await settle(DRAIN_INTERVAL_MS * 5)

    expect(postCalls(harness)).toHaveLength(before)
  })

  it('renders one independent node per topic, each keyed n-<seq>#<topic>', async () => {
    const batch: AnalysisBatch = { fromSeq: 1, toSeq: 4, turn: 1, contributions: [{ seq: 2, turn: 1, topics: ['alpha', 'beta'] }] }
    harness.stateGraphFor = () => applyAnalysis(EMPTY_PROGRESS_GRAPH, batch)

    await mount('s1')

    expect(container.querySelectorAll('[data-session-topic-map-node]')).toHaveLength(2)
    expect(nodeGroup(container, 'n-2#alpha')).not.toBeNull()
    expect(nodeGroup(container, 'n-2#beta')).not.toBeNull()
  })

  it('percent-encodes non-ASCII and spaced topics in the node id', async () => {
    const batch: AnalysisBatch = { fromSeq: 1, toSeq: 4, turn: 1, contributions: [{ seq: 2, turn: 1, topics: ['主题 a'] }] }
    harness.stateGraphFor = () => applyAnalysis(EMPTY_PROGRESS_GRAPH, batch)

    await mount('s1')

    expect(nodeGroup(container, 'n-2#%E4%B8%BB%E9%A2%98%20a')).not.toBeNull()
  })

  it('renders each node as a focusable button labelled with the focus copy', async () => {
    const batch: AnalysisBatch = { fromSeq: 1, toSeq: 4, turn: 1, contributions: [{ seq: 2, turn: 1, topics: ['alpha'] }] }
    harness.stateGraphFor = () => applyAnalysis(EMPTY_PROGRESS_GRAPH, batch)

    await mount('s1')

    const group = nodeGroup(container, 'n-2#alpha')
    expect(group?.getAttribute('role')).toBe('button')
    expect(group?.getAttribute('tabindex')).toBe('0')
    expect(group?.getAttribute('aria-label')).toBe(t('node.focus'))
    expect(group?.querySelector('rect')?.getAttribute('rx')).toBe('8')
  })

  it('labels a node with its single topic and a bare #seq meta text', async () => {
    const batch: AnalysisBatch = { fromSeq: 1, toSeq: 4, turn: 1, contributions: [{ seq: 2, turn: 1, topics: ['alpha'] }] }
    harness.stateGraphFor = () => applyAnalysis(EMPTY_PROGRESS_GRAPH, batch)

    await mount('s1')

    const texts = Array.from(nodeGroup(container, 'n-2#alpha')?.querySelectorAll('text') ?? []).map((el) => el.textContent ?? '')
    expect(texts).toContain('alpha')
    expect(texts).toContain('#2')
    expect(texts.some((text) => text.includes('·'))).toBe(false)
  })

  it('truncates topic labels longer than 10 characters to 9 characters plus an ellipsis', async () => {
    const batch: AnalysisBatch = {
      fromSeq: 1,
      toSeq: 4,
      turn: 1,
      contributions: [{ seq: 2, turn: 1, topics: ['abcdefghijkl', 'abcdefghij'] }],
    }
    harness.stateGraphFor = () => applyAnalysis(EMPTY_PROGRESS_GRAPH, batch)

    await mount('s1')

    const longTexts = Array.from(nodeGroup(container, 'n-2#abcdefghijkl')?.querySelectorAll('text') ?? []).map((el) => el.textContent ?? '')
    expect(longTexts).toContain('abcdefghi…')
    expect(longTexts).not.toContain('abcdefghijkl')

    const exactTexts = Array.from(nodeGroup(container, 'n-2#abcdefghij')?.querySelectorAll('text') ?? []).map((el) => el.textContent ?? '')
    expect(exactTexts).toContain('abcdefghij')
  })

  it('places topics of the same reply on the same row (y) in different lanes (x)', async () => {
    const batch: AnalysisBatch = { fromSeq: 1, toSeq: 4, turn: 1, contributions: [{ seq: 2, turn: 1, topics: ['alpha', 'beta'] }] }
    harness.stateGraphFor = () => applyAnalysis(EMPTY_PROGRESS_GRAPH, batch)

    await mount('s1')

    const alpha = rectPosition(nodeGroup(container, 'n-2#alpha'))
    const beta = rectPosition(nodeGroup(container, 'n-2#beta'))
    expect(alpha.y).not.toBeNull()
    expect(alpha.y).toBe(beta.y)
    expect(alpha.x).not.toBeNull()
    expect(beta.x).not.toBeNull()
    expect(alpha.x).not.toBe(beta.x)
  })

  it('keeps a topic in one lane across replies, moves it down by seq, and links it with a branch edge but no merge edge', async () => {
    const batchOne: AnalysisBatch = { fromSeq: 1, toSeq: 4, turn: 1, contributions: [{ seq: 2, turn: 1, topics: ['alpha'] }] }
    const batchTwo: AnalysisBatch = { fromSeq: 5, toSeq: 8, turn: 2, contributions: [{ seq: 6, turn: 2, topics: ['alpha'] }] }
    harness.stateGraphFor = () => applyAnalysis(applyAnalysis(EMPTY_PROGRESS_GRAPH, batchOne), batchTwo)

    await mount('s1')

    const first = rectPosition(nodeGroup(container, 'n-2#alpha'))
    const second = rectPosition(nodeGroup(container, 'n-6#alpha'))
    expect(first.x).not.toBeNull()
    expect(first.y).not.toBeNull()
    expect(second.y).not.toBeNull()
    expect(second.x).toBe(first.x)
    expect(Number(second.y)).toBeGreaterThan(Number(first.y))

    expect(container.querySelectorAll('path[data-kind="branch"]').length).toBeGreaterThan(0)
    expect(container.querySelector('[data-kind="merge"]')).toBeNull()
  })
  it('draws one box per node and focuses the transcript row of that node own turn', async () => {
    const batchOne: AnalysisBatch = { fromSeq: 1, toSeq: 4, turn: 1, contributions: [{ seq: 2, turn: 1, topics: ['alpha'] }] }
    const batchTwo: AnalysisBatch = { fromSeq: 5, toSeq: 8, turn: 2, contributions: [{ seq: 6, turn: 2, topics: ['beta'] }] }
    const graph = applyAnalysis(applyAnalysis(EMPTY_PROGRESS_GRAPH, batchOne), batchTwo)
    harness.stateGraphFor = () => graph

    const first = document.createElement('div')
    first.setAttribute('data-chat-turn', '1')
    const second = document.createElement('div')
    second.setAttribute('data-chat-turn', '2')
    document.body.append(first, second)

    await mount('s1')

    const boxes = Array.from(container.querySelectorAll<HTMLElement>('[role="button"]')).filter((box) => box.textContent?.includes('alpha') || box.textContent?.includes('beta'))
    expect(boxes).toHaveLength(2)

    const betaBox = boxes.find((box) => box.textContent?.includes('beta'))
    expect(betaBox).toBeDefined()
    await act(async () => {
      betaBox?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    await settle()

    expect(second.hasAttribute('data-session-topic-map-focus')).toBe(true)
    expect(first.hasAttribute('data-session-topic-map-focus')).toBe(false)
  })

  it('focuses the last row of the node own turn and always shows the turn-only notice', async () => {
    const batch: AnalysisBatch = { fromSeq: 1, toSeq: 8, turn: 2, contributions: [{ seq: 6, turn: 2, topics: ['beta'] }] }
    harness.stateGraphFor = () => applyAnalysis(EMPTY_PROGRESS_GRAPH, batch)

    const first = document.createElement('div')
    first.setAttribute('data-chat-turn', '2')
    const last = document.createElement('div')
    last.setAttribute('data-chat-turn', '2')
    last.setAttribute('data-chat-node-key', 'user:6')
    document.body.append(first, last)

    await mount('s1')
    const box = Array.from(container.querySelectorAll<HTMLElement>('[role="button"]')).find((candidate) => candidate.textContent?.includes('beta'))
    await act(async () => {
      box?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    await settle()

    expect(last.hasAttribute('data-session-topic-map-focus')).toBe(true)
    expect(first.hasAttribute('data-session-topic-map-focus')).toBe(false)
    expect(container.textContent).toContain(t('panel.turnOnly', { turn: 2 }))
  })
  it('shows the turn-only notice on a turn hit', async () => {
    const batch: AnalysisBatch = { fromSeq: 1, toSeq: 8, turn: 2, contributions: [{ seq: 6, turn: 2, topics: ['beta'] }] }
    harness.stateGraphFor = () => applyAnalysis(EMPTY_PROGRESS_GRAPH, batch)

    const turnRow = document.createElement('div')
    turnRow.setAttribute('data-chat-turn', '2')
    document.body.append(turnRow)

    await mount('s1')
    const box = Array.from(container.querySelectorAll<HTMLElement>('[role="button"]')).find((candidate) => candidate.textContent?.includes('beta'))
    await act(async () => {
      box?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    await settle()

    expect(turnRow.hasAttribute('data-session-topic-map-focus')).toBe(true)
    expect(container.textContent).toContain(t('panel.turnOnly', { turn: 2 }))
  })

  it('shows the focus-missing notice and no focus when the turn is not rendered', async () => {
    const batch: AnalysisBatch = { fromSeq: 1, toSeq: 8, turn: 5, contributions: [{ seq: 6, turn: 5, topics: ['beta'] }] }
    harness.stateGraphFor = () => applyAnalysis(EMPTY_PROGRESS_GRAPH, batch)

    await mount('s1')
    const box = Array.from(container.querySelectorAll<HTMLElement>('[role="button"]')).find((candidate) => candidate.textContent?.includes('beta'))
    await act(async () => {
      box?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    await settle()

    expect(container.querySelector('[data-session-topic-map-focus]')).toBeNull()
    expect(container.textContent).toContain(t('panel.focusMissing', { turn: 5 }))
  })

  it('drops its transcript outline when the pane unmounts', async () => {
    const batch: AnalysisBatch = { fromSeq: 1, toSeq: 8, turn: 2, contributions: [{ seq: 6, turn: 2, topics: ['beta'] }] }
    harness.stateGraphFor = () => applyAnalysis(EMPTY_PROGRESS_GRAPH, batch)

    const turnRow = document.createElement('div')
    turnRow.setAttribute('data-chat-turn', '2')
    document.body.append(turnRow)

    await mount('s1')
    const box = Array.from(container.querySelectorAll<HTMLElement>('[role="button"]')).find((candidate) => candidate.textContent?.includes('beta'))
    await act(async () => {
      box?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    await settle()
    expect(turnRow.hasAttribute('data-session-topic-map-focus')).toBe(true)

    await act(async () => {
      root?.unmount()
    })
    root = null
    expect(turnRow.hasAttribute('data-session-topic-map-focus')).toBe(false)
  })

  it('drops the outline of the previous Session when the Session changes', async () => {
    const batch: AnalysisBatch = { fromSeq: 1, toSeq: 8, turn: 2, contributions: [{ seq: 6, turn: 2, topics: ['beta'] }] }
    harness.stateGraphFor = () => applyAnalysis(EMPTY_PROGRESS_GRAPH, batch)

    const turnRow = document.createElement('div')
    turnRow.setAttribute('data-chat-turn', '2')
    document.body.append(turnRow)

    await mount('s1')
    const box = Array.from(container.querySelectorAll<HTMLElement>('[role="button"]')).find((candidate) => candidate.textContent?.includes('beta'))
    await act(async () => {
      box?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    await settle()
    expect(turnRow.hasAttribute('data-session-topic-map-focus')).toBe(true)

    await mount('s2')
    expect(turnRow.hasAttribute('data-session-topic-map-focus')).toBe(false)
  })

  describe('error surfacing', () => {
    it('shows the timeout copy after ANALYZE_TIMEOUT_MS, stops running and offers retry', async () => {
      harness.outcomes.push(neverSettles)
      await mount('s1')
      await start()
      expect(bodyAt(container).hasAttribute('data-running')).toBe(true)

      await settle(ANALYZE_TIMEOUT_MS)

      const alert = container.querySelector('[data-session-topic-map-error]')
      expect(alert?.getAttribute('role')).toBe('alert')
      expect(alert?.textContent).toContain(zh['failure.timeout'])
      expect(bodyAt(container).hasAttribute('data-running')).toBe(false)
      expect(container.querySelector('[data-session-topic-map-control]')?.getAttribute('data-state')).toBe('idle')
      expect(buttonWithText(container, t('panel.start'))).toBeDefined()
      expect(container.querySelector('[data-session-topic-map-retry]')).not.toBeNull()
    })

    it('shows the network copy when fetch rejects', async () => {
      harness.outcomes.push(async () => {
        throw new TypeError('fetch failed')
      })
      await mount('s1')
      await start()

      expect(container.querySelector('[data-session-topic-map-error]')?.textContent).toContain(zh['failure.network'])
    })

    it('shows the body copy for an answer that is not JSON', async () => {
      harness.outcomes.push(async () => new Response('<html>', { status: 200 }))
      await mount('s1')
      await start()

      expect(container.querySelector('[data-session-topic-map-error]')?.textContent).toContain(zh['failure.body'])
    })

    it('shows the Host message verbatim for an http failure that carries one', async () => {
      harness.outcomes.push(async () => jsonResponse({ code: 'analysis-failed', message: '模型暂时不可用' }, 409))
      await mount('s1')
      await start()

      expect(container.querySelector('[data-session-topic-map-error]')?.textContent).toContain('模型暂时不可用')
    })


    it('shows the http copy with the status when the Host gives no message', async () => {
      harness.outcomes.push(async () => jsonResponse({ code: 'weird' }, 500))
      await mount('s1')
      await start()

      expect(container.querySelector('[data-session-topic-map-error]')?.textContent).toContain(fill(zh['failure.http'], { status: 500 }))
    })

    it('retry issues exactly one new confirmed POST, shows running again, and a successful step clears the banner', async () => {
      harness.outcomes.push(async () => jsonResponse({ code: 'analysis-failed', message: '不可用' }, 409), messageAnswer(0))
      await mount('s1')
      await start()
      expect(container.querySelector('[data-session-topic-map-error]')).not.toBeNull()
      const before = postCalls(harness).length

      const retry = container.querySelector<HTMLButtonElement>('[data-session-topic-map-retry]')
      await act(async () => {
        retry?.click()
      })
      await settle()

      expect(postCalls(harness)).toHaveLength(before + 1)
      const last = postCalls(harness).at(-1)
      expect(last?.body).toEqual({ sessionId: 's1', provider: 'p', model: 'm', confirm: true })
      expect(bodyAt(container).hasAttribute('data-running')).toBe(true)
      expect(container.querySelector('[data-session-topic-map-error]')).toBeNull()
    })

    it('does not show an error banner while the loop is running', async () => {
      harness.outcomes.push(messageAnswer(0))
      await mount('s1')
      await start()

      expect(bodyAt(container).hasAttribute('data-running')).toBe(true)
      expect(container.querySelector('[data-session-topic-map-error]')).toBeNull()
    })

    it('shows no error banner after the user pauses a run that was still in flight', async () => {
      harness.outcomes.push(neverSettles)
      await mount('s1')
      await start()
      const pause = buttonWithText(container, t('panel.pause'))
      await act(async () => {
        pause?.click()
      })
      await settle(ANALYZE_TIMEOUT_MS)

      expect(container.querySelector('[data-session-topic-map-error]')).toBeNull()
    })
  })
})


