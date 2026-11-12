/**
 * Doubles for the public client services the plan-toggle client half consumes.
 *
 * The shapes below mirror the installed public contracts (sessions, conversation
 * input, shortcuts, locale) structurally: nothing imports the production
 * plugin, so a contract change surfaces as a failing observable behavior instead
 * of a stale import. `unknown` appears only at service boundaries.
 */
import { Context } from '@deepseek-ai/cordis'

/** Minimal observable-snapshot face (the public `ObservableSnapshot` shape). */
export interface DoubleSnapshot<T> {
  getSnapshot(): T
  subscribe(listener: () => void): () => void
}

export interface WritableSnapshot<T> extends DoubleSnapshot<T> {
  set(next: T): void
}

/** Snapshot source shared by the doubles; `set` republishes to subscribers. */
export function snapshot<T>(initial: T): WritableSnapshot<T> {
  let current = initial
  const listeners = new Set<() => void>()
  return {
    getSnapshot: () => current,
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    set(next) {
      current = next
      for (const listener of listeners) listener()
    },
  }
}

/** Cordis surface used to mount the plugin under test without a running app. */
interface CordisHost {
  provide(name: string, value: unknown): unknown
  plugin(plugin: unknown): PromiseLike<unknown>
  on(name: string, listener: (payload: unknown) => unknown): () => boolean
  extend(): Context
}

function host(ctx: Context): CordisHost {
  return ctx as unknown as CordisHost
}

/** Plugin entry resolved from the client module namespace. */
export interface PluginEntry {
  readonly apply: (ctx: Context) => unknown
  readonly inject: unknown
}

/** Accept both a default-exported plugin object and a named `apply`/`inject` module. */
export function resolvePluginEntry(namespace: object): PluginEntry {
  const record = namespace as { default?: unknown; apply?: unknown; inject?: unknown }
  const candidate: unknown = record.default ?? namespace
  if (typeof candidate !== 'object' || candidate === null) {
    throw new Error('client entry exposes no plugin object')
  }
  const shape = candidate as { apply?: unknown; inject?: unknown }
  if (typeof shape.apply !== 'function') {
    throw new Error('client plugin object exposes no apply()')
  }
  return { apply: shape.apply as (ctx: Context) => unknown, inject: shape.inject }
}

/** One catalog row's local ownership counts. */
export interface SessionRow {
  readonly id: string
  /** Local reference counts by consumer source; `mainView` marks the visible Session. */
  readonly retainedBy?: Readonly<Record<string, number>>
  /** False models a catalog row whose Client generation (binding + scope) is gone. */
  readonly retained?: boolean
  /** False models a retained row without a Client binding. */
  readonly binding?: boolean
  /** False models a retained row without an Agent scope. */
  readonly scope?: boolean
}

/** Host-computed plan projection values, untyped so tests can probe boundaries. */
export interface PlanProjectionState {
  readonly active?: unknown
  readonly pending?: unknown
}

export type InputPhaseName = 'plain' | 'adjudicating' | 'claimed' | 'submitting' | 'sending'

/** Claim carried by the input state while the composer holds a command token. */
export interface ClaimShape {
  readonly name: string
  readonly token: string
  readonly hint?: string
  readonly attachments?: boolean
}

/** Claim a trigger source hands to `beginCommand`, including its submit closure. */
export interface CommandClaimShape extends ClaimShape {
  submit?: (args: string, actx: unknown, attachments: readonly unknown[]) => Promise<unknown>
}

/** Published input state used by the doubles (the fields the shortcut observes). */
export interface InputStateShape {
  draft: string
  draftRev: number
  phase: InputPhaseName
  claim?: ClaimShape
}

export interface TokenSpanShape {
  start: number
  end: number
  draftRev: number
}

export interface FixedBindingShape {
  readonly code: string
  readonly secondCode?: string
  readonly modifiers: readonly string[]
}

/** Fixed command contributed through `shortcuts.registerFixed`. */
export interface FixedCommandShape {
  readonly id: string
  readonly keys: readonly string[]
  readonly bindings: readonly FixedBindingShape[]
  readonly group: string
  readonly label?: () => string
}

export interface GestureOverrides {
  code?: string
  control?: boolean
  alt?: boolean
  shift?: boolean
  meta?: boolean
  repeat?: boolean
  composing?: boolean
  defaultPrevented?: boolean
}

/** Physical-key gesture exactly as the shortcuts adapter publishes it. */
export function shortcutGesture(overrides: GestureOverrides = {}): Required<GestureOverrides> {
  return {
    code: 'Tab',
    control: false,
    alt: false,
    shift: true,
    meta: false,
    repeat: false,
    composing: false,
    defaultPrevented: false,
    ...overrides,
  }
}

export interface ComposerDomOptions {
  /** Place the keydown target inside `[data-composer-input]` (default true). */
  insideInput?: boolean
  /** Place that input inside `[data-composer-card]` (default true). */
  insideCard?: boolean
  /** Render an open `[data-trigger-menu]` inside the composer card. */
  triggerMenuOpen?: boolean
}

/**
 * Build the composer DOM the shortcut inspects and return the deepest element,
 * i.e. the element a keydown would target.
 */
export function composerTarget(options: ComposerDomOptions = {}): Element {
  const { insideInput = true, insideCard = true, triggerMenuOpen = false } = options
  const target = document.createElement('span')
  document.body.append(target)
  let container: Element = target
  if (insideInput) {
    const input = document.createElement('div')
    input.dataset.composerInput = ''
    input.append(container)
    container = input
  }
  if (insideCard) {
    const card = document.createElement('div')
    card.dataset.composerCard = ''
    card.append(container)
    if (triggerMenuOpen) {
      const menu = document.createElement('div')
      menu.dataset.triggerMenu = ''
      card.append(menu)
    }
    container = card
  }
  document.body.append(container)
  return target
}

export interface PressOptions extends GestureOverrides {
  /** Explicit keydown target; omitted builds one with `composerTarget()`. */
  target?: Element | null
  dom?: ComposerDomOptions
}

export interface HarnessOptions {
  rows?: readonly SessionRow[]
  projection?: PlanProjectionState | undefined
  phase?: InputPhaseName
  draft?: string
  draftRev?: number
  claim?: ClaimShape
  /** What the input machine answers for `beginCommand`. */
  beginCommandResult?: boolean
  /** Host settlement for `session.command(line)`; defaults to an accepted, matched command. */
  commandResult?: (line: string) => Promise<unknown>
}

export interface Notice {
  readonly level: string
  readonly text: string
}

export interface BeginCommandCall {
  readonly claim: CommandClaimShape
  readonly span: TokenSpanShape
  readonly result: boolean
}

export interface Harness {
  readonly ctx: Context
  /** Agent scope handed to the input resolver for the selected Session. */
  readonly scope: unknown
  /** Ordered action log: every observable verb the plugin invoked. */
  readonly log: string[]
  readonly commands: string[]
  readonly drafts: string[]
  readonly beginCommands: BeginCommandCall[]
  readonly consumeRequests: unknown[]
  readonly notices: Notice[]
  readonly fixedCommands: FixedCommandShape[]
  /** Fixed-input subscriptions registered through `shortcuts.observeFixedInput`. */
  readonly listenerRegistrations: number
  /** Composer dictionary registrations by namespace and locale. */
  readonly dictionaries: Map<string, Record<string, Record<string, string>>>
  /** Session ids passed to `sessions.binding`/`sessions.scope`, in call order. */
  readonly bindingIds: string[]
  readonly scopeIds: string[]
  /** Scopes passed to `conversation.input.for`. */
  readonly inputScopes: unknown[]
  /** Projection keys read through `session.projections.faceOf`. */
  readonly projectionKeys: string[]
  /** Session ids whose plan projection was read, in call order. */
  readonly projectionSessions: string[]
  /** Composer draft currently published by the input state. */
  currentDraft(): string
  /** Publish a new input state (draft, phase, claim) between presses. */
  setInput(next: Partial<InputStateShape>): void
  /** Publish a new plan projection between presses. */
  setProjection(next: PlanProjectionState | undefined): void
  /** Deliver one Shift+Tab keydown; returns whether the input was consumed. */
  press(options?: PressOptions): boolean
  /** Settle the asynchronous tail of one press (command round-trip, notices). */
  flush(): Promise<void>
}

const CONSUME_EVENT = 'slash/input-consume-token'

function unexpectable(name: string): never {
  throw new Error(`unexpected ${name} call`)
}

/**
 * Mount the client plugin on a real Cordis context with the four injected
 * services replaced by recording doubles.
 */
export async function startPlugin(entry: PluginEntry, options: HarnessOptions = {}): Promise<Harness> {
  const ctx = new Context()
  const cordis = host(ctx)
  const log: string[] = []
  const commands: string[] = []
  const drafts: string[] = []
  const beginCommands: BeginCommandCall[] = []
  const consumeRequests: unknown[] = []
  const notices: Notice[] = []
  const fixedCommands: FixedCommandShape[] = []
  const dictionaries = new Map<string, Record<string, Record<string, string>>>()
  const bindingIds: string[] = []
  const scopeIds: string[] = []
  const projectionKeys: string[] = []
  const projectionSessions: string[] = []
  const inputScopes: unknown[] = []

  const rows: readonly SessionRow[] =
    options.rows ?? [{ id: 'session-1', retainedBy: { mainView: 1 }, retained: true }]

  const list = snapshot({
    ids: rows.map((row) => row.id),
    byId: Object.fromEntries(rows.map((row) => [row.id, { id: row.id, retainedBy: row.retainedBy ?? {} }])),
    phase: 'ready' as const,
  })
  let projection: PlanProjectionState | undefined = options.projection
  const inputState = snapshot<InputStateShape>({
    draft: options.draft ?? '',
    draftRev: options.draftRev ?? 7,
    phase: options.phase ?? 'plain',
    ...(options.claim === undefined ? {} : { claim: options.claim }),
  })
  const scope = cordis.extend()
  const commandResult = options.commandResult ?? (() => Promise.resolve({ ok: true, value: { matched: true } }))

  const faces = new Map<string, object>()

  function rowOf(id: string): SessionRow | undefined {
    return rows.find((candidate) => candidate.id === id)
  }

  function retainedRow(id: string): SessionRow | undefined {
    const row = rowOf(id)
    return row === undefined || row.retained === false ? undefined : row
  }

  function faceFor(id: string): object {
    const existing = faces.get(id)
    if (existing !== undefined) return existing
    const created = {
      sessionId: id,
      projections: {
        faceOf(key: string) {
          projectionKeys.push(key)
          projectionSessions.push(id)
          return { getSnapshot: () => projection, subscribe: () => () => {} }
        },
      },
      command: (line: string): Promise<unknown> => {
        log.push(`command:${line}`)
        commands.push(line)
        return commandResult(line)
      },
      getSnapshot: () => ({}),
      subscribe: () => () => {},
    }
    faces.set(id, created)
    return created
  }

  const sessionsService = {
    list,
    searchResultLimit: 20,
    retain: () => unexpectable('sessions.retain'),
    using: () => unexpectable('sessions.using'),
    retainInfo: () => unexpectable('sessions.retainInfo'),
    create: () => unexpectable('sessions.create'),
    subagentAddress: () => undefined,
    refreshProjections: () => unexpectable('sessions.refreshProjections'),
    refresh: () => unexpectable('sessions.refresh'),
    search: () => unexpectable('sessions.search'),
    fork: () => unexpectable('sessions.fork'),
    binding(id: string) {
      bindingIds.push(id)
      const row = retainedRow(id)
      if (row === undefined || row.binding === false) return undefined
      return { sessionId: id, session: faceFor(id), eventSource: {}, ctx: scope }
    },
    scope(id: string) {
      scopeIds.push(id)
      const row = retainedRow(id)
      return row === undefined || row.scope === false ? undefined : scope
    },
    scopeOf: (actx: unknown) => (actx === scope && rows[0] !== undefined ? rows[0].id : undefined),
    sessionOf: (actx: unknown) => (actx === scope && rows[0] !== undefined ? faceFor(rows[0].id) : undefined),
  }

  const sessionInput = {
    state: inputState,
    beginCommand(claim: CommandClaimShape, span: TokenSpanShape): boolean {
      log.push('beginCommand')
      const result = options.beginCommandResult ?? true
      beginCommands.push({ claim, span, result })
      return result
    },
    insertReference: () => unexpectable('input.insertReference'),
    insertQuote: () => unexpectable('input.insertQuote'),
    setDraft(text: string): void {
      log.push(`setDraft:${text}`)
      drafts.push(text)
      inputState.set({ ...inputState.getSnapshot(), draft: text })
    },
    addAttachments: () => unexpectable('input.addAttachments'),
    removeAttachment: () => unexpectable('input.removeAttachment'),
    pruneAttachments: () => unexpectable('input.pruneAttachments'),
    submit: () => unexpectable('input.submit'),
    notify(level: string, text: string): void {
      log.push(`notify:${level}`)
      notices.push({ level, text })
    },
    focus(): void {
      log.push('focus')
    },
  }

  const conversationService = {
    input: {
      for(actx: unknown) {
        inputScopes.push(actx)
        return sessionInput
      },
      requestDraftInitialization: () => unexpectable('input.requestDraftInitialization'),
    },
    blocks: {},
    send: () => unexpectable('conversation.send'),
    updateQueue: () => unexpectable('conversation.updateQueue'),
    cancel: () => unexpectable('conversation.cancel'),
    loadOlder: () => unexpectable('conversation.loadOlder'),
  }

  let listenerRegistrations = 0
  const fixedListeners: ((input: unknown) => void)[] = []
  const shortcutsService = {
    runtime: 'web',
    platform: 'windows',
    stopSequenceMs: 500,
    catalog: snapshot([]),
    config: snapshot({}),
    fixedCatalog: snapshot([]),
    registerFixed(command: FixedCommandShape): () => void {
      fixedCommands.push(command)
      return () => undefined
    },
    observeFixedInput(listener: (input: unknown) => void): () => void {
      listenerRegistrations += 1
      fixedListeners.push(listener)
      return () => undefined
    },
    describeBinding: () => unexpectable('shortcuts.describeBinding'),
    edit: () => unexpectable('shortcuts.edit'),
    recording: () => unexpectable('shortcuts.recording'),
    closeWindow: () => unexpectable('shortcuts.closeWindow'),
    register: () => unexpectable('shortcuts.register'),
  }

  function recordDictionary(namespace: string, locale: string, dict: Record<string, string>): void {
    const namespaceDictionaries = dictionaries.get(namespace) ?? {}
    namespaceDictionaries[locale] = dict
    dictionaries.set(namespace, namespaceDictionaries)
  }

  const localeService = {
    getLocale: () => ({ active: 'en', locales: [], revision: 0 }),
    getSnapshot: () => ({ active: 'en', locales: [], revision: 0 }),
    subscribe: () => () => {},
    setLocale: () => unexpectable('locale.setLocale'),
    addLanguage: () => unexpectable('locale.addLanguage'),
    resolveText: () => unexpectable('locale.resolveText'),
    register(...args: unknown[]): () => void {
      if (args.length >= 3) {
        const [namespace, locale, dict] = args as [string, string, Record<string, string>]
        recordDictionary(namespace, locale, dict)
      } else {
        const [namespace, dicts] = args as [string, Record<string, Record<string, string>>]
        for (const [locale, dict] of Object.entries(dicts)) recordDictionary(namespace, locale, dict)
      }
      return () => undefined
    },
    bind(namespace: string): (key: string) => string {
      return (key: string) => `${namespace}:${key}`
    },
  }

  cordis.provide('sessions', sessionsService)
  cordis.provide('conversation', conversationService)
  cordis.provide('shortcuts', shortcutsService)
  cordis.provide('locale', localeService)

  cordis.on(CONSUME_EVENT, (request: unknown) => {
    log.push('consume-token')
    consumeRequests.push(request)
    const state = inputState.getSnapshot()
    const token = consumedText(request, state.draft)
    if (token !== undefined && token.length > 0 && state.draft.startsWith(token)) {
      inputState.set({ ...state, draft: state.draft.slice(token.length) })
    }
    return true
  })

  await cordis.plugin({ apply: entry.apply, inject: entry.inject })

  return {
    ctx,
    scope,
    log,
    commands,
    drafts,
    beginCommands,
    consumeRequests,
    notices,
    fixedCommands,
    get listenerRegistrations() {
      return listenerRegistrations
    },
    dictionaries,
    bindingIds,
    scopeIds,
    inputScopes,
    projectionKeys,
    projectionSessions,
    currentDraft: () => inputState.getSnapshot().draft,
    setInput(next: Partial<InputStateShape>) {
      inputState.set({ ...inputState.getSnapshot(), ...next })
    },
    setProjection(next: PlanProjectionState | undefined) {
      projection = next
    },
    press(pressOptions: PressOptions = {}): boolean {
      const listener = fixedListeners[0]
      if (listener === undefined) throw new Error('shortcuts.observeFixedInput registered no listener')
      const target = pressOptions.target === undefined ? composerTarget(pressOptions.dom ?? {}) : pressOptions.target
      let consumed = false
      listener({
        type: 'keydown',
        gesture: shortcutGesture(pressOptions),
        context: { source: 'keyboard', region: 'editable', modal: null, target },
        consume() {
          consumed = true
          log.push('consume')
        },
      })
      return consumed
    },
    async flush() {
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 0)
      })
    },
  }
}

type ConsumeGuard =
  | { readonly kind: 'bare-token'; readonly token: string }
  | { readonly kind: 'span'; readonly span: TokenSpanShape }

/** Read the guard a scoped consume request carries, in either declared form. */
function readGuard(request: unknown): ConsumeGuard | undefined {
  if (typeof request !== 'object' || request === null) return undefined
  const guard = (request as { guard?: unknown }).guard
  if (typeof guard !== 'object' || guard === null) return undefined
  const shaped = guard as { kind?: unknown; token?: unknown; span?: unknown }
  if (shaped.kind === 'bare-token' && typeof shaped.token === 'string') {
    return { kind: 'bare-token', token: shaped.token }
  }
  if (shaped.kind === 'span' && typeof shaped.span === 'object' && shaped.span !== null) {
    return { kind: 'span', span: shaped.span as TokenSpanShape }
  }
  return undefined
}

/** Text a consume guard removes from the draft. */
function consumedText(request: unknown, draft: string): string | undefined {
  const guard = readGuard(request)
  if (guard === undefined) return undefined
  return guard.kind === 'bare-token' ? guard.token : draft.slice(guard.span.start, guard.span.end)
}
