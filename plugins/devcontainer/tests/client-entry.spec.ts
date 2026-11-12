// @vitest-environment jsdom
/**
 * The Dev Container settings page's browser entry over a real Cordis context:
 * the stylesheet it mounts, the `settings.section` row it registers with its nav
 * identity and faces, the roster read it offers, and the teardown that releases
 * every one of them.
 *
 * The published client entries of the injected packages (locale, renderer slots,
 * settings forms, the Remote carrier) are browser bundles, so each service here
 * is a double implementing only the members `apply` uses, with the contract the
 * spec asserts against. The roster namespace is the one dependency that may be
 * absent at runtime, so both of its branches are driven.
 */
import { Context, Service, type Fiber } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi, type Mock } from 'vitest'
import * as entry from '../src/client/index.ts'

/** The settings namespace the page owns. */
const NS = 'devcontainer'
/** The package identity the plugin reports on the DOM and its stylesheet path. */
const PLUGIN = '@banzhe/dsh-devcontainer'
const SHEET = `${PLUGIN}/styles.css`

/** A roster the Host could serve: two source presets and no derived variant. */
const ROSTER = {
  presets: [
    { id: 'standard', name: '标准模式', isDefault: true },
    { id: 'delegate-only', name: '委派模式', isDefault: false },
  ],
}

type RosterAnswer = { ok: boolean, value?: unknown }
type Listing = () => Promise<RosterAnswer>

type Dictionary = Record<string, string>
type Dictionaries = Record<string, Dictionary>

/** The page state the section renders, as the plugin publishes it. */
interface VariantsView {
  status: string
  failure: string | null
  rows: readonly { id: string, checked: boolean }[]
  sbxRows: readonly { id: string }[]
  checkedCount: number
  sbxCheckedCount: number
}

interface VariantsStore {
  getSnapshot(): VariantsView
  subscribe(listener: () => void): () => void
}

/** The face the section entry is injected with. */
interface SectionFace {
  load(): Promise<void>
  setChecked(id: string, checked: boolean): void
  toggleSbxSource(id: string): void
  setSbxTemplate(value: string): void
  hooks: { devcontainerVariants: VariantsStore }
}

interface SectionOptions {
  name?: string
  id?: string
  order?: number
  locale?: string
  label?: () => string
  inject?: () => Record<string, unknown>
}

/**
 * Double for the `locale` service: registration returns the disposer and `bind`
 * resolves the active language at call time, so a disposed namespace stops
 * resolving its keys.
 */
class LocaleDouble {
  private readonly dicts = new Map<string, Dictionaries>()
  private active = 'en'

  register(namespace: string, dictionaries: Dictionaries): () => void {
    this.dicts.set(namespace, dictionaries)
    return () => { this.dicts.delete(namespace) }
  }

  bind(namespace: string): (key: string, params?: Record<string, unknown>) => string {
    return (key, params) => {
      const template = this.dicts.get(namespace)?.[this.active]?.[key] ?? key
      if (params === undefined) return template
      return template.replace(/\{(\w+)\}/g, (match, name: string) => name in params ? String(params[name]) : match)
    }
  }

  setLocale(id: string): void { this.active = id }

  dictionary(namespace: string, locale = this.active): Dictionary {
    return this.dicts.get(namespace)?.[locale] ?? {}
  }
}

/**
 * Double for the `slots` service. `inject` runs its declaration on the caller's
 * fiber, as the real registry does, so unloading the plugin disposes what it
 * registered; `register` keeps the options and component for inspection.
 */
class SlotsDouble extends Service {
  private readonly entries = new Map<string, { options: SectionOptions, component: unknown }>()

  constructor(ctx: Context) {
    super(ctx, 'slots')
  }

  inject(key: string, callback: () => () => void): () => void {
    const dispose = this.ctx.effect(callback, `slots.inject(${key})`)
    return () => { void dispose() }
  }

  register(options: SectionOptions, component: unknown): () => void {
    const key = options.id ?? ''
    this.entries.set(key, { options, component })
    return () => { this.entries.delete(key) }
  }

  entry(id: string): { options: SectionOptions, component: unknown } | undefined {
    return this.entries.get(id)
  }
}

/** One shared configuration form, ready for editing. */
function formDouble(): Record<string, unknown> {
  const value = { sources: [], sbxSources: [], sbxTemplate: '' }
  const snapshot = { status: 'ready', value, base: undefined, user: undefined, revision: 1, writable: true }
  return {
    getSnapshot: () => snapshot,
    subscribe: () => () => {},
    mutate: async () => true,
    unset: async () => true,
    set: async () => true,
  }
}

/** Double for `configForms`: the page's form, served straight away. */
class ConfigFormsDouble {
  private readonly form = formDouble()

  get(_entryId: string): unknown {
    return this.form
  }

  whileServed(_namespaces: readonly string[], register: () => () => void): () => void {
    const dispose = register()
    return () => { dispose() }
  }
}

let fibers: Fiber[] = []

afterEach(async () => {
  const pending = fibers
  fibers = []
  for (const fiber of pending) await fiber.dispose()
  vi.restoreAllMocks()
  document.head.innerHTML = ''
})

interface Prepared {
  readonly ctx: Context
  readonly locale: LocaleDouble
  readonly slots: SlotsDouble
  readonly listing: Mock<Listing> | undefined
}

/**
 * Build a context carrying the five services the entry injects. `list` is the
 * roster listing, and its absence is the deployment whose `agentPresets`
 * namespace offers no listing at all.
 */
function prepare(options: { list?: Listing } = {}): Prepared {
  const ctx = new Context()
  const locale = new LocaleDouble()
  const listing = options.list === undefined ? undefined : vi.fn(options.list)
  const presets: Record<string, unknown> = listing === undefined ? {} : { list: listing }
  ctx.provide('remote', { agentPresets: presets } as never)
  ctx.provide('remote.agentPresets', presets as never)
  ctx.provide('configForms', new ConfigFormsDouble() as never)
  ctx.provide('locale', locale as never)
  const slots = new SlotsDouble(ctx)
  return { ctx, locale, slots, listing }
}

async function bench(options: { list?: Listing } = {}): Promise<Prepared & { fiber: Fiber }> {
  const prepared = prepare(options)
  const fiber = prepared.ctx.plugin({ inject: [...entry.inject], apply: entry.apply })
  await fiber.await()
  fibers.push(fiber)
  return { ...prepared, fiber }
}

/** Dispose one bench's fiber inside the spec and untrack it. */
async function retire(bench: Prepared & { fiber: Fiber }): Promise<void> {
  fibers = fibers.filter(fiber => fiber !== bench.fiber)
  await bench.fiber.dispose()
}

function styles(): HTMLStyleElement[] {
  return [...document.head.querySelectorAll<HTMLStyleElement>(`style[data-plugin="${PLUGIN}"]`)]
}

function optionsOf(bench: Prepared): SectionOptions {
  const record = bench.slots.entry(NS)
  if (record === undefined) throw new Error(`no live "${NS}" section registration`)
  return record.options
}

function faceOf(bench: Prepared): SectionFace {
  const inject = optionsOf(bench).inject
  if (inject === undefined) throw new Error('the section registered without an inject face')
  return inject() as unknown as SectionFace
}

describe('the Dev Container browser entry', () => {
  it('declares the five services it needs and applies as a plain function', () => {
    const prepared = prepare()
    expect(entry.inject).toEqual(['configForms', 'locale', 'remote', 'remote.agentPresets', 'slots'])
    expect(entry.apply).toBeTypeOf('function')
    const applied = vi.fn(entry.apply)
    applied(prepared.ctx)
    expect(applied).toHaveBeenCalledTimes(1)
    expect(applied.mock.results[0]?.value).toBeUndefined()
  })

  it('mounts exactly one stylesheet carrying the plugin identity and its own sheet', async () => {
    await bench()
    const mounted = styles()
    expect(mounted).toHaveLength(1)
    expect(mounted[0]?.dataset.plugin).toBe(PLUGIN)
    expect(mounted[0]?.dataset.pluginCss).toBe(SHEET)
    expect((mounted[0]?.textContent ?? '').trim()).not.toBe('')
  })

  it('registers one settings section with its nav id, order, and namespace', async () => {
    const b = await bench()
    const options = optionsOf(b)
    expect(options.name).toBe('settings.section')
    expect(options.id).toBe(NS)
    expect(options.order).toBe(31)
    expect(options.locale).toBe(NS)
    expect(options.label).toBeTypeOf('function')
    expect(options.inject).toBeTypeOf('function')
    expect(b.slots.entry(NS)?.component).toBeTypeOf('function')
  })

  it('localizes the nav label through the dictionary it registers', async () => {
    const b = await bench()
    const label = optionsOf(b).label as () => string
    const english = b.locale.dictionary(NS, 'en')
    const chinese = b.locale.dictionary(NS, 'zh')
    expect(label()).toBe(english['nav'])
    b.locale.setLocale('zh')
    expect(label()).toBe(chinese['nav'])
    expect(label()).not.toBe(english['nav'])
  })

  it('injects the controller surface the page renders from', async () => {
    const b = await bench()
    const face = faceOf(b)
    expect(typeof face.load).toBe('function')
    expect(typeof face.setChecked).toBe('function')
    expect(typeof face.toggleSbxSource).toBe('function')
    expect(typeof face.setSbxTemplate).toBe('function')
    const store = face.hooks.devcontainerVariants
    expect(typeof store.getSnapshot).toBe('function')
    expect(typeof store.subscribe).toBe('function')
    expect(store.getSnapshot().status).toBe('loading')
  })

  it('reads the roster through the injected namespace when one is listed', async () => {
    const b = await bench({ list: async () => ({ ok: true, value: ROSTER }) })
    const face = faceOf(b)
    await face.load()
    expect(b.listing).toHaveBeenCalledTimes(1)
    const state = face.hooks.devcontainerVariants.getSnapshot()
    expect(state.status).toBe('ready')
    expect(state.failure).toBeNull()
    expect(state.rows.map(row => row.id)).toEqual(['standard', 'delegate-only'])
    expect(state.sbxRows.map(row => row.id)).toEqual(['standard', 'delegate-only'])
    expect(state.checkedCount).toBe(0)
  })

  it('activates and reports an unreadable roster when the namespace offers no listing', async () => {
    const b = await bench()
    expect(b.listing).toBeUndefined()
    // The page is still there: only the roster read has nothing to call.
    expect(styles()).toHaveLength(1)
    const face = faceOf(b)
    await expect(face.load()).resolves.toBeUndefined()
    const state = face.hooks.devcontainerVariants.getSnapshot()
    expect(state.status).toBe('error')
    expect(state.failure).toBe('load')
    expect(state.rows).toEqual([])
    expect(state.sbxRows).toEqual([])
    expect(state.checkedCount).toBe(0)
    expect(state.sbxCheckedCount).toBe(0)
  })

  it('releases the stylesheet, the section row, and the dictionary with the fiber', async () => {
    const b = await bench()
    const label = optionsOf(b).label as () => string
    const translate = b.ctx.locale.bind(NS)
    expect(styles()).toHaveLength(1)
    expect(b.slots.entry(NS)).toBeDefined()
    expect(translate('nav')).toBe(b.locale.dictionary(NS, 'en')['nav'])
    expect(label()).toBe(b.locale.dictionary(NS, 'en')['nav'])

    await retire(b)

    expect(styles()).toHaveLength(0)
    expect(document.head.querySelectorAll('style')).toHaveLength(0)
    expect(b.slots.entry(NS)).toBeUndefined()
    // The namespace is gone, so every key it defined now resolves to itself.
    expect(translate('nav')).toBe('nav')
  })
})
