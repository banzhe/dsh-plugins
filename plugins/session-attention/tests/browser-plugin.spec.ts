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
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { apply, inject } from '../src/client/index.ts'
import { en, NS, zh, type AttentionKey } from '../src/client/locales.ts'
import { LocaleDouble } from './locale-double.ts'
import { descendantChain, parentWithChildren, sessionRow, sessionSources, subagentRow, type SessionRow, type SessionSources } from './session-list-double.ts'
import { SlotsDouble } from './slots-double.ts'
import { workspaceSource, type WorkspaceSource } from './workspace-source-double.ts'

const ENTRY = 'session-attention.panel'
const PLUGIN_ID = '@banzhe/dsh-session-attention'

let fibers: Fiber[] = []

afterEach(async () => {
  const pending = fibers
  fibers = []
  for (const fiber of pending) await fiber.dispose()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  document.head.innerHTML = ''
})

interface Bench {
  readonly ctx: Context
  readonly fiber: Fiber
  readonly slots: SlotsDouble
  readonly surface: SessionSources
  readonly workspaces: WorkspaceSource
  readonly openSession: ReturnType<typeof vi.fn>
  readonly refreshProjections: ReturnType<typeof vi.fn<(sessionId: string) => Promise<void>>>
  readonly counts: { list: number; status: number; workspaces: number }
}

/**
 * Boot the browser half over a context providing the six injected services.
 * Every source is wrapped so the spec can prove the store lets them go when the
 * fiber unloads; everything else is the real plugin code.
 */
async function bench(rows: readonly SessionRow[] = []): Promise<Bench> {
  const surface = sessionSources(rows)
  const workspaces = workspaceSource()
  const counts = { list: 0, status: 0, workspaces: 0 }
  const counted = <T>(source: { getSnapshot: () => T; subscribe: (fn: () => void) => () => void }, key: keyof typeof counts) => ({
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
  const refreshProjections = vi.fn<(sessionId: string) => Promise<void>>(() => Promise.resolve())
  const ctx = new Context()
  ctx.provide('sessions', {
    list: counted(surface.list, 'list'),
    refreshProjections,
  } as unknown as ISessions)
  ctx.provide('uiSession', { sessionStatus: counted(surface.status, 'status') } as never)
  ctx.provide('uiWorkspace', { openSession } as never)
  ctx.provide('workspaces', { list: counted(workspaces.source, 'workspaces') } as never)
  ctx.provide('locale', new LocaleDouble() as never)
  // A cordis Service registers itself under its name in its own constructor.
  const slots = new SlotsDouble(ctx)
  const fiber = ctx.plugin({ inject: [...inject], apply })
  await fiber.await()
  fibers.push(fiber)
  return { ctx, fiber, slots, surface, workspaces, openSession, refreshProjections, counts }
}

/** Rejection handlers and the retry they start both run as microtasks. */
async function flushMicrotasks(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

function callsFor(b: Bench, id: string): number {
  return b.refreshProjections.mock.calls.filter(call => call[0] === id).length
}

function refreshedIds(b: Bench): string[] {
  return b.refreshProjections.mock.calls.map(call => call[0])
}

function metadataOf(b: Bench, id: string): object {
  return b.surface.list.getSnapshot().projectionsBySession[id as never]?.values ?? {}
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

  it('follows all three sources and releases them with the fiber', async () => {
    const b = await bench([sessionRow('a', { running: true })])
    // The store follows the list, the duration column follows it again so a
    // Session that arrives without a prompt-time projection still gets a read,
    // and the archive set gets its own subscription beside them.
    expect(b.counts).toEqual({ list: 2, status: 1, workspaces: 1 })
    // The store is live: a status push recomputes without throwing.
    b.surface.update((draft) => {
      draft.byId['a' as never] = sessionRow('a', { completed: true })
    })
    await retire(b)
    expect(b.counts).toEqual({ list: 0, status: 0, workspaces: 0 })
    // A later source update reaches nothing: the entry is gone and the store
    // has let go of every subscription.
    b.surface.update((draft) => {
      draft.ids.push('b' as never)
      draft.byId['b' as never] = sessionRow('b', { running: true })
    })
    b.workspaces.setArchived('a')
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

describe('taskbar pulse through the desktop bridge', () => {
  function stubProgressBar(): ReturnType<typeof vi.fn> {
    const setProgressBar = vi.fn(async () => {})
    vi.stubGlobal('dshDesktop', { window: { setProgressBar } })
    return setProgressBar
  }

  it('pulses the taskbar for a running session on boot and clears when it completes', async () => {
    const setProgressBar = stubProgressBar()
    const b = await bench([sessionRow('a', { running: true })])
    expect(setProgressBar.mock.calls).toEqual([[2]])

    b.surface.update((draft) => {
      draft.byId['a' as never] = sessionRow('a', { completed: true })
    })
    expect(setProgressBar.mock.calls).toEqual([[2], [-1]])

    await retire(b)
    expect(setProgressBar.mock.calls).toEqual([[2], [-1]])
  })

  it('clears a pulse when the fiber unloads while a session is still running', async () => {
    const setProgressBar = stubProgressBar()
    const b = await bench([sessionRow('a', { running: true })])
    expect(setProgressBar.mock.calls).toEqual([[2]])
    await retire(b)
    expect(setProgressBar.mock.calls).toEqual([[2], [-1]])
  })

  it('does not pulse a blocked running session', async () => {
    const setProgressBar = stubProgressBar()
    await bench([sessionRow('a', { running: true, blocked: true })])
    expect(setProgressBar).not.toHaveBeenCalledWith(2)
  })

  it('does not pulse when a running session shares the list with unread', async () => {
    const setProgressBar = stubProgressBar()
    await bench([
      sessionRow('a', { running: true }),
      sessionRow('b', { completed: true }),
    ])
    expect(setProgressBar).not.toHaveBeenCalledWith(2)
  })

  it('boots without a progress bridge and never calls a progress function', async () => {
    const reveal = vi.fn()
    vi.stubGlobal('dshDesktop', { protocolVersion: 1, window: { reveal } })
    await expect(bench([sessionRow('a', { running: true })])).resolves.toBeTruthy()
    expect(reveal).not.toHaveBeenCalled()
  })
})


describe('durable prompt-time reads', () => {
  it('reads the displayed rows and their running children, not the whole list', async () => {
    const b = await bench([
      sessionRow('a', { running: true }),
      sessionRow('b', { lastPromptAt: 50 }),
      sessionRow('done', { completed: true }),
      sessionRow('sub', { origin: 'subagent', parentId: 'a' as SessionId, running: true }),
      sessionRow('blank', { blank: true }),
    ])
    await flushMicrotasks()
    // The panel lists `a` (running, with the running child mounted under it)
    // and nothing else: the idle and settled rows render no anchor, and the
    // blank placeholder never lists. The child rides the parent, listed even
    // though the host list does not have it; the child's own version read is
    // what carries the child's turn timing.
    expect(b.refreshProjections).toHaveBeenCalledTimes(2)
    expect(refreshedIds(b)).toEqual(['a', 'sub'])
    expect(callsFor(b, 'b')).toBe(0)
    expect(callsFor(b, 'done')).toBe(0)
    expect(callsFor(b, 'blank')).toBe(0)

    b.surface.publish((draft) => {
      draft.ids.push('missing' as never)
    })
    await flushMicrotasks()
    expect(b.refreshProjections).toHaveBeenCalledTimes(2)
    expect(callsFor(b, 'missing')).toBe(0)
  })

  it('reads a row that enters the panel, and drops the row that leaves it', async () => {
    const b = await bench([sessionRow('a', { running: true })])
    await flushMicrotasks()
    expect(callsFor(b, 'a')).toBe(1)

    // The row finishes without a reminder. The host publishes the list and the
    // status separately, so the fold first sees the new row beside the old
    // running status — one read for that version — and then the settled truth.
    b.surface.update((draft) => {
      draft.byId['a' as never] = sessionRow('a', { updatedAt: 2, completed: false })
    })
    await flushMicrotasks()
    expect(callsFor(b, 'a')).toBe(2)

    // The row is out of the panel now: later versions of it stay unread.
    b.surface.update((draft) => {
      draft.byId['a' as never] = sessionRow('a', { updatedAt: 4, completed: false })
    })
    await flushMicrotasks()
    expect(callsFor(b, 'a')).toBe(2)
  })

  it('never reads a container row, but reads its running children', async () => {
    const rows = parentWithChildren(sessionRow('parent'), [
      ['child-1', { running: true }],
      ['child-2', {}],
    ])
    const b = await bench(rows)
    await flushMicrotasks()
    // The container parent's `lastPromptAt` renders nowhere (no duration on a
    // container row), but the running child's turn timing is the block's own
    // cell, so the child's version reads even though the host list does not
    // list the child.
    expect(refreshedIds(b)).toEqual(['child-1'])
  })

  it('reads a running grandchild through the same path as a running child', async () => {
    const b = await bench(descendantChain(sessionRow('parent'), [
      ['child', {}],
      ['grandchild', { running: true, updatedAt: 1 }],
    ]))
    await flushMicrotasks()
    // Only the deepest running row has a version to read: the two container
    // rows above it render no duration cell, exactly as an idle direct parent
    // does, so neither gets a read.
    expect(refreshedIds(b)).toEqual(['grandchild'])

    // The same version republished: the claim holds, no reread.
    b.surface.publish(() => {})
    await flushMicrotasks()
    expect(callsFor(b, 'grandchild')).toBe(1)

    // A newer version carrying the grandchild's turn timing is one more read,
    // the same claim a running direct child gets.
    b.surface.update((draft) => {
      draft.byId['grandchild' as never] = subagentRow('grandchild', {
        parentId: 'child' as SessionId, running: true, updatedAt: 2, activeSince: 500,
      })
    })
    await flushMicrotasks()
    expect(refreshedIds(b)).toEqual(['grandchild', 'grandchild'])
  })

  it('reads a running child version once, rereads when its updatedAt moves', async () => {
    const b = await bench(parentWithChildren(sessionRow('parent', { running: true, updatedAt: 2 }), [
      ['sub', { running: true, updatedAt: 2 }],
    ]))
    await flushMicrotasks()
    // The running parent reads its own version beside the child's.
    expect(callsFor(b, 'parent')).toBe(1)
    expect(callsFor(b, 'sub')).toBe(1)

    // The same child version republished: the claim holds, no reread.
    b.surface.publish(() => {})
    await flushMicrotasks()
    expect(callsFor(b, 'sub')).toBe(1)

    // A settled child never mounts. The host publishes the list beside the old
    // running status first — the fold still sees the child for that instant,
    // one read for the new version — then the settled truth, which reads no
    // more.
    b.surface.update((draft) => {
      draft.byId['sub' as never] = sessionRow('sub', {
        origin: 'subagent', parentId: 'parent' as SessionId, updatedAt: 3,
      })
    })
    await flushMicrotasks()
    expect(callsFor(b, 'sub')).toBe(2)
  })

  it('does not reread when the same version is republished without metadata', async () => {
    const b = await bench([sessionRow('a', { running: true, updatedAt: 5 })])
    await flushMicrotasks()
    expect(callsFor(b, 'a')).toBe(1)
    expect(metadataOf(b, 'a')).not.toHaveProperty('sessionListMetadata')

    b.surface.publish(() => {})
    await flushMicrotasks()
    expect(b.refreshProjections).toHaveBeenCalledTimes(1)
    expect(metadataOf(b, 'a')).not.toHaveProperty('sessionListMetadata')

    b.surface.update((draft) => {
      draft.byId['a' as never] = sessionRow('a', { updatedAt: 5 })
    })
    await flushMicrotasks()
    expect(b.refreshProjections).toHaveBeenCalledTimes(1)
    expect(b.refreshProjections).toHaveBeenCalledWith('a')
    expect(metadataOf(b, 'a')).not.toHaveProperty('sessionListMetadata')
  })

  it('reads only a newly eligible session', async () => {
    const b = await bench([sessionRow('a', { running: true })])
    expect(callsFor(b, 'a')).toBe(1)

    b.surface.update((draft) => {
      draft.ids.push('b' as never)
      draft.byId['b' as never] = sessionRow('b', { running: true })
    })
    await flushMicrotasks()
    expect(b.refreshProjections).toHaveBeenCalledTimes(2)
    expect(callsFor(b, 'a')).toBe(1)
    expect(callsFor(b, 'b')).toBe(1)
  })

  it('rereads a session only when updatedAt increases', async () => {
    const b = await bench([sessionRow('a', { running: true, updatedAt: 10, displayTitle: 'a' })])
    expect(callsFor(b, 'a')).toBe(1)

    b.surface.update((draft) => {
      draft.byId['a' as never] = sessionRow('a', { running: true, updatedAt: 10, displayTitle: 'renamed' })
    })
    await flushMicrotasks()
    expect(b.refreshProjections).toHaveBeenCalledTimes(1)

    b.surface.update((draft) => {
      draft.byId['a' as never] = sessionRow('a', { running: true, updatedAt: 9, displayTitle: 'renamed' })
    })
    await flushMicrotasks()
    expect(b.refreshProjections).toHaveBeenCalledTimes(1)

    b.surface.update((draft) => {
      draft.byId['a' as never] = sessionRow('a', { running: true, updatedAt: 11, displayTitle: 'renamed' })
    })
    await flushMicrotasks()
    expect(b.refreshProjections).toHaveBeenCalledTimes(2)
    expect(b.refreshProjections.mock.calls.map(call => call[0])).toEqual(['a', 'a'])
  })

  it('retries a rejected refresh once, immediately, then keeps that version', async () => {
    const b = await bench()
    b.refreshProjections.mockRejectedValueOnce(new Error('unread'))
    b.surface.update((draft) => {
      draft.ids.push('a' as never)
      draft.byId['a' as never] = sessionRow('a', { running: true, updatedAt: 3 })
    })
    expect(b.refreshProjections).toHaveBeenCalledTimes(1)
    await expect(b.refreshProjections.mock.results[0]?.value).rejects.toThrow('unread')
    await flushMicrotasks()
    // The rejection itself starts the one retry. No later publication is required.
    expect(refreshedIds(b)).toEqual(['a', 'a'])

    b.surface.publish(() => {})
    await flushMicrotasks()
    expect(b.refreshProjections).toHaveBeenCalledTimes(2)
  })

  it('stops after a second rejection of the same version', async () => {
    const b = await bench()
    b.refreshProjections.mockRejectedValue(new Error('down'))
    b.surface.update((draft) => {
      draft.ids.push('a' as never)
      draft.byId['a' as never] = sessionRow('a', { running: true, updatedAt: 1 })
    })
    await flushMicrotasks()
    expect(refreshedIds(b)).toEqual(['a', 'a'])

    b.surface.publish(() => {})
    await flushMicrotasks()
    expect(b.refreshProjections).toHaveBeenCalledTimes(2)

    b.surface.update((draft) => {
      draft.byId['a' as never] = sessionRow('a', { running: true, updatedAt: 2 })
    })
    await flushMicrotasks()
    // A newer version is its own read plus one retry, then it stops too.
    expect(refreshedIds(b)).toEqual(['a', 'a', 'a', 'a'])
  })

  it('does not start a second read while that version is still in flight', async () => {
    const b = await bench()
    let resolveRead!: () => void
    b.refreshProjections.mockImplementationOnce(() => new Promise<void>((resolve) => {
      resolveRead = resolve
    }))
    b.surface.update((draft) => {
      draft.ids.push('a' as never)
      draft.byId['a' as never] = sessionRow('a', { running: true, updatedAt: 4 })
    })
    b.surface.publish(() => {})
    expect(b.refreshProjections).toHaveBeenCalledTimes(1)
    expect(b.refreshProjections).toHaveBeenCalledWith('a')

    resolveRead()
    await flushMicrotasks()
    b.surface.publish(() => {})
    await flushMicrotasks()
    expect(refreshedIds(b)).toEqual(['a'])
  })

  it('does not read again when a call settles after dispose', async () => {
    const b = await bench()
    let rejectRead!: (error: Error) => void
    b.refreshProjections.mockImplementation(() => new Promise<void>((_resolve, reject) => {
      rejectRead = reject
    }))
    b.surface.update((draft) => {
      draft.ids.push('a' as never)
      draft.byId['a' as never] = sessionRow('a', { running: true, updatedAt: 1 })
    })
    expect(b.refreshProjections).toHaveBeenCalledTimes(1)
    expect(b.refreshProjections).toHaveBeenCalledWith('a')

    const pending = b.refreshProjections.mock.results[0]?.value as Promise<void> | undefined
    await retire(b)
    rejectRead(new Error('late'))
    await expect(pending).rejects.toThrow('late')
    await flushMicrotasks()
    b.surface.publish(() => {})
    b.surface.update((draft) => {
      draft.byId['a' as never] = sessionRow('a', { running: true, updatedAt: 2 })
    })
    await flushMicrotasks()
    expect(refreshedIds(b)).toEqual(['a'])
  })
})

