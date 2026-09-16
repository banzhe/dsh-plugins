// @vitest-environment jsdom
/**
 * Registration against the REAL slot registry, not a double.
 *
 * The published `@deepseek-ai/dsh-client-ui-renderer/client` artifact is a
 * browser bundle that registers itself through `window.__ModuleLoader__.load`,
 * so this spec materializes it the way the shell does (a module-table facade
 * answering its requires with the real packages) and then lets the plugin's own
 * `apply` register into the genuine `ctx.slots`.
 *
 * This is the seam a double cannot cover: the real `settings.general.item`
 * declaration, the real ledger's `inject`-waits-for-declaration behavior, the
 * registration options the registry actually validates, and disposal through
 * the plugin's fiber.
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import * as Cordis from '@deepseek-ai/cordis'
import * as UiSlots from '@deepseek-ai/dsh-client-ui-slots'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import * as React from 'react'
import * as ReactDom from 'react-dom'
import * as ReactDomClient from 'react-dom/client'
import * as JsxRuntime from 'react/jsx-runtime'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ISessions, SessionListState } from '@deepseek-ai/dsh-api-session-controller/client'
import { apply, inject } from '../src/client/index.ts'
import { en, NS } from '../src/client/locales.ts'
import { LocaleDouble } from './locale-double.ts'

/** The module-table words the renderer bundle requests. */
const SEED: Record<string, unknown> = {
  '@deepseek-ai/cordis': Cordis,
  '@deepseek-ai/dsh-client-ui-slots': UiSlots,
  'react': React,
  'react-dom': ReactDom,
  'react-dom/client': ReactDomClient,
  'react/jsx-runtime': JsxRuntime,
}

/**
 * Materialize one published browser bundle through a module-table facade.
 * @param packageName - package whose `lib/client.js` to load.
 * @returns the bundle's exports, exactly as the shell's module system yields them.
 */
function loadClientBundle(packageName: string): Record<string, unknown> {
  const path = resolve('node_modules', packageName, 'lib/client.js')
  const source = readFileSync(path, 'utf8')
  const registrations: { id: string; factory: (require: (spec: string) => unknown) => Record<string, unknown> }[] = []
  const previous = (globalThis as { window?: unknown }).window
  ;(globalThis as { window?: unknown }).window = {
    __ModuleLoader__: { load: (registration: never) => { registrations.push(registration) } },
  }
  try {
    new Function(source)()
  } finally {
    ;(globalThis as { window?: unknown }).window = previous
  }
  const registration = registrations[0]
  if (registration === undefined) throw new Error(`${packageName} registered no factory`)
  return registration.factory(spec => SEED[spec])
}

class FakeNotification {
  static permission: NotificationPermission = 'granted'
  static instances: FakeNotification[] = []
  onclick: (() => void) | null = null

  constructor(readonly title: string, readonly options?: NotificationOptions) {
    FakeNotification.instances.push(this)
  }

  close(): void {}
}

const renderer = loadClientBundle('@deepseek-ai/dsh-client-ui-renderer')

/**
 * Declare `settings.general.item` on the real registry the way the shipped
 * composition does: ui-settings-general's General section owns the declaration
 * and hands it down through its own `children` table. This spec exercises the
 * plugin against the real ledger, not ui-settings-general, so it declares the
 * seat itself — a slot that is never declared is exactly the "waits forever"
 * case the late-declaration spec covers.
 * @param ctx - context whose `slots` service receives the declaration.
 */
function declareGeneralItem(ctx: Context): void {
  ctx.slots.register(
    { name: 'root', children: { 'settings.general.item': { kind: 'list', scope: 'root' } } },
    () => null,
  )
}

/** Boot the plugin over the REAL slot registry. */
async function bench(permission: NotificationPermission = 'denied'): Promise<{
  ctx: Context
  slots: { entries: (key: string) => readonly { options: { id?: string; order?: number }; component: unknown }[]; getVersion: (key: string) => number }
  fiber: { dispose: () => Promise<void> }
}> {
  vi.stubGlobal('navigator', { setAppBadge: vi.fn(async () => {}), clearAppBadge: vi.fn(async () => {}) })
  FakeNotification.permission = permission
  vi.stubGlobal('Notification', FakeNotification)

  const ctx = new Context()
  ctx.provide('sessions', {
    list: createSnapshotStore<SessionListState>({
      ids: [], byId: {}, current: undefined, phase: 'ready',
      subagentsByParent: {}, jobsBySession: {}, currentAddress: undefined,
    }),
    open: vi.fn(),
  } as unknown as ISessions)
  ctx.provide('locale', new LocaleDouble() as never)
  // The genuine renderer provides ctx.slots (and its renderer install).
  const rendererFiber = ctx.plugin({ inject: [...((renderer.inject as string[] | undefined) ?? [])], apply: renderer.apply as (c: Context) => void })
  await rendererFiber.await()
  declareGeneralItem(ctx)
  const fiber = ctx.plugin({ inject: [...inject], apply })
  await fiber.await()
  const slots = ctx.get('slots') as unknown as {
    entries: (key: string) => readonly { options: { id?: string; order?: number }; component: unknown }[]
    getVersion: (key: string) => number
  }
  return { ctx, slots, fiber: fiber as unknown as { dispose: () => Promise<void> } }
}

afterEach(() => {
  FakeNotification.instances = []
  FakeNotification.permission = 'granted'
  vi.unstubAllGlobals()
  document.head.innerHTML = ''
})

describe('app-badge registration against the real slot registry', () => {
  it('lands its row on the real settings.general.item ledger', async () => {
    const { slots } = await bench()
    const entries = slots.entries('settings.general.item')
    // The row is real: the registry accepted the options and holds the component.
    expect(entries).toHaveLength(1)
    expect(entries[0]?.options.id).toBe('app-badge')
    expect(entries[0]?.options.order).toBe(20)
    expect(entries[0]?.component).toBeTypeOf('function')
    expect(slots.getVersion('settings.general.item')).toBeGreaterThan(0)
  })

  it('unloads the row from the real ledger with the plugin fiber', async () => {
    const { slots, fiber } = await bench()
    expect(slots.entries('settings.general.item')).toHaveLength(1)
    await fiber.dispose()
    expect(slots.entries('settings.general.item')).toHaveLength(0)
    expect(document.head.querySelectorAll('style[data-plugin]')).toHaveLength(0)
  })

  it('waits for the slot declaration instead of throwing when it arrives late', async () => {
    vi.stubGlobal('navigator', { setAppBadge: vi.fn(async () => {}), clearAppBadge: vi.fn(async () => {}) })
    vi.stubGlobal('Notification', FakeNotification)
    // No renderer yet: the declaration does not exist, so the plugin must not throw.
    const ctx = new Context()
    ctx.provide('sessions', {
      list: createSnapshotStore<SessionListState>({
        ids: [], byId: {}, current: undefined, phase: 'ready',
        subagentsByParent: {}, jobsBySession: {}, currentAddress: undefined,
      }),
      open: vi.fn(),
    } as unknown as ISessions)
    ctx.provide('locale', new LocaleDouble() as never)
    const fiber = ctx.plugin({ inject: [...inject], apply })
    await fiber.await()

    const rendererFiber = ctx.plugin({ inject: [], apply: renderer.apply as (c: Context) => void })
    await rendererFiber.await()
    declareGeneralItem(ctx)
    const slots = ctx.get('slots') as unknown as { entries: (k: string) => readonly unknown[] }
    // The pending registration resolved once the declaration appeared.
    expect(slots.entries('settings.general.item').length).toBeGreaterThan(0)
  })

  it('keeps the row on an incapable page so the silence stays explainable', async () => {
    vi.stubGlobal('navigator', {})
    vi.stubGlobal('Notification', undefined)
    const ctx = new Context()
    ctx.provide('sessions', {
      list: createSnapshotStore<SessionListState>({
        ids: [], byId: {}, current: undefined, phase: 'ready',
        subagentsByParent: {}, jobsBySession: {}, currentAddress: undefined,
      }),
      open: vi.fn(),
    } as unknown as ISessions)
    ctx.provide('locale', new LocaleDouble() as never)
    const rendererFiber = ctx.plugin({ inject: [], apply: renderer.apply as (c: Context) => void })
    await rendererFiber.await()
    declareGeneralItem(ctx)
    const fiber = ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    const slots = ctx.get('slots') as unknown as { entries: (k: string) => readonly { options: { id?: string } }[] }
    expect(slots.entries('settings.general.item').map(e => e.options.id)).toContain('app-badge')
    expect(ctx.locale.bind(NS)('settings.title')).toBe(en['settings.title'])
  })
})
