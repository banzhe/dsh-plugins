// @vitest-environment jsdom
/**
 * Browser-half lifecycle over a real Cordis context: dictionary registration
 * with fiber teardown, the stylesheet, the `shell.overlay` registration and the
 * face it injects, the Workspace hop a row jumps through, and the release of
 * both source subscriptions — the entry is registered unconditionally, so the
 * only lifetime that matters is the plugin's own.
 */
import { Context, type Fiber } from '@deepseek-ai/cordis'
import type { ISessions } from '@deepseek-ai/dsh-api-session-controller/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { apply, inject } from '../src/client/index.ts'
import { en, NS, zh, type AttentionKey } from '../src/client/locales.ts'
import { LocaleDouble } from './locale-double.ts'
import { sessionRow, sessionSources, type SessionRow, type SessionSources } from './session-list-double.ts'
import { SlotsDouble } from './slots-double.ts'

const ENTRY = 'session-attention.panel'
const PLUGIN_ID = '@banzhe/dsh-session-attention'

let fibers: Fiber[] = []

afterEach(async () => {
  const pending = fibers
  fibers = []
  for (const fiber of pending) await fiber.dispose()
  vi.restoreAllMocks()
  document.head.innerHTML = ''
})

interface Bench {
  readonly ctx: Context
  readonly fiber: Fiber
  readonly slots: SlotsDouble
  readonly surface: SessionSources
  readonly openSession: ReturnType<typeof vi.fn>
  /** Live source subscriptions this bench's wrappers have handed out. */
  readonly counts: { list: number; status: number }
}

/**
 * Boot the browser half over a context providing the five injected services.
 * Both Session sources are wrapped so the spec can prove the store lets them go
 * when the fiber unloads; everything else is the real plugin code.
 */
async function bench(rows: readonly SessionRow[] = []): Promise<Bench> {
  const surface = sessionSources(rows)
  const counts = { list: 0, status: 0 }
  const counted = <T>(source: { getSnapshot: () => T; subscribe: (fn: () => void) => () => void }, key: 'list' | 'status') => ({
    getSnapshot: () => source.getSnapshot(),
    subscribe: (fn: () => void) => {
      counts[key] += 1
      const unsubscribe = source.subscribe(fn)
      return () => {
        counts[key] -= 1
        unsubscribe()
      }
    },
  })
  const openSession = vi.fn()
  const ctx = new Context()
  ctx.provide('sessions', { list: counted(surface.list, 'list') } as unknown as ISessions)
  ctx.provide('uiSession', { sessionStatus: counted(surface.status, 'status') } as never)
  ctx.provide('uiWorkspace', { openSession } as never)
  ctx.provide('locale', new LocaleDouble() as never)
  // A cordis Service registers itself under its name in its own constructor.
  const slots = new SlotsDouble(ctx)
  const fiber = ctx.plugin({ inject: [...inject], apply })
  await fiber.await()
  fibers.push(fiber)
  return { ctx, fiber, slots, surface, openSession, counts }
}

/**
 * Dispose one bench's fiber inside the spec and untrack it, so the afterEach
 * sweep never disposes the same fiber twice.
 */
async function retire(b: Bench): Promise<void> {
  fibers = fibers.filter(fiber => fiber !== b.fiber)
  await b.fiber.dispose()
}

describe('session-attention browser half', () => {
  it('registers the overlay entry unconditionally, with its own id, order, and locale', async () => {
    const b = await bench()
    const entry = b.slots.entry(ENTRY)
    expect(entry).toBeDefined()
    expect(entry?.options.order).toBe(100)
    expect(entry?.options.locale).toBe(NS)
    expect(entry?.component).toBeTypeOf('function')
    const face = b.slots.injection(ENTRY)
    expect(face.useAttention).toBeTypeOf('function')
    expect(face.open).toBeTypeOf('function')
  })

  it('jumps through the Workspace owner', async () => {
    const b = await bench()
    b.slots.injection(ENTRY).open('sess-1' as never)
    expect(b.openSession).toHaveBeenCalledWith('sess-1')
  })

  it('injects its stylesheet once and takes it back with the fiber', async () => {
    const b = await bench()
    const styles = [...document.head.querySelectorAll<HTMLElement>('style[data-plugin]')]
    expect(styles).toHaveLength(1)
    expect(styles[0]?.dataset.plugin).toBe(PLUGIN_ID)
    expect(styles[0]?.dataset.pluginCss).toBe(`${PLUGIN_ID}/overlay.css`)
    expect(styles[0]?.textContent).toContain('.sa-root.sa-root')
    await retire(b)
    expect(document.head.querySelectorAll('style[data-plugin]')).toHaveLength(0)
    expect(b.slots.entry(ENTRY)).toBeUndefined()
  })

  it('draws the toggle outline from the shipped state colors, never from hand-picked ones', async () => {
    await bench()
    // The bundle carries the sheet compiled (the devkit's loaders minify every
    // mode), so these are the declarations a user's browser applies — and each
    // name here is a `--dsw-*` token, which is the rule this pins.
    const css = document.head.querySelector<HTMLElement>('style[data-plugin]')?.textContent ?? ''
    // Running work sweeps the DS blue stops ui-theme ships for the onboarding
    // ring, through the same animated conic angle that ring uses.
    expect(css).toContain('--dsw-gradient-onboarding-blue-stops')
    expect(css).toContain('@property --sa-outline-angle')
    expect(css).toContain('@keyframes sa-outline-sweep')
    // The two still rings are the StateDot colors the sidebar already uses for
    // the same facts: amber for a Session blocked on the user, green for one
    // that finished unread.
    expect(css).toContain('var(--dsw-alias-state-warn-primary)')
    expect(css).toContain('var(--dsw-alias-state-success-primary)')
    // The sweep is motion: reduced motion must drop the travel, keep the ring.
    expect(css).toMatch(/@media \(prefers-reduced-motion:\s*reduce\)/)
    // The toggle's edge belongs to the ring, so the elevation token's 0.5px
    // hairline layer is rebound away. Nothing else can pin this: the hairline
    // lives inside a box-shadow, which jsdom never resolves.
    expect(css).toMatch(/--dsw-elevation-stroke-color:\s*transparent/)
  })

  it('follows both sources and releases them with the fiber', async () => {
    const b = await bench([sessionRow('a', { running: true })])
    expect(b.counts).toEqual({ list: 1, status: 1 })
    // The store is live: a status push recomputes without throwing.
    b.surface.update((draft) => {
      draft.byId['a' as never] = sessionRow('a', { completed: true })
    })
    await retire(b)
    expect(b.counts).toEqual({ list: 0, status: 0 })
    // A later source update reaches nothing: the entry is gone and the store
    // has let go of both subscriptions.
    b.surface.update((draft) => {
      draft.ids.push('b' as never)
      draft.byId['b' as never] = sessionRow('b', { running: true })
    })
  })

  it('registers both dictionaries under its own namespace and releases them with the fiber', async () => {
    const b = await bench()
    b.ctx.locale.setLocale('zh')
    const translate = b.ctx.locale.bind(NS)
    expect(translate('panel.title')).toBe(zh['panel.title'])
    b.ctx.locale.setLocale('en')
    expect(translate('panel.title')).toBe(en['panel.title'])
    await retire(b)
    expect(translate('panel.title')).not.toBe(en['panel.title'])
  })

  it('localizes every key the entry asks for', () => {
    for (const key of Object.keys(zh) as AttentionKey[]) {
      expect(en[key]).toBeTypeOf('string')
      expect(en[key].length).toBeGreaterThan(0)
    }
  })
})

