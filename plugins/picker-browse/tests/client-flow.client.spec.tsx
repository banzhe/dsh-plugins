// @vitest-environment jsdom
/**
 * The published wiring as the dialog's owner meets it: the two directory-flow
 * holes, the dialog's dictionaries, and the injected browse face — driven
 * through a real Cordis context with service doubles for `slots` and `locale`.
 *
 * Upstream ran this spec on `@deepseek-ai/dsh-client-test-runtime` (the live
 * registry, the locale runtime, and pinned browser languages). That package is
 * not installed in this workspace, so the doubles reproduce the contracts the
 * plugin actually depends on — declaration-scoped `inject`, single-occupant
 * `register`, transactional iterables, one dictionary owner per namespace and
 * locale — and the locale double opens in `zh`, the language the shipped
 * dialog defaults and the profile this Bundle serves run.
 */
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { DirectoryListing } from '@deepseek-ai/dsh-api-remotes/client'
import type { DirectoryFlowOwnerProps } from '@deepseek-ai/dsh-client-ui-workspace/client'
import { apply, inject } from '../src/client/index.ts'
import { BrowseDirectoryFlow } from '../src/client/flow.ts'
import { apply as nodeApply } from '../src/index.ts'
import { LocaleDouble } from './locale-double.ts'
import { SlotsDouble } from './slots-double.ts'

afterEach(cleanup)

const HOLES = ['conversation.hero.workspace.directoryFlow', 'sidebar.workspaces.directoryFlow'] as const

const HOME = '/home/u'
const homeListing: DirectoryListing = {
  path: HOME,
  home: HOME,
  crumbs: [{ name: '/', path: '/', hidden: false }, { name: 'u', path: HOME, hidden: false }],
  entries: [{ name: 'Documents', path: `${HOME}/Documents`, hidden: false }],
  truncated: false,
}

function provideService(ctx: Context, name: string, value: unknown): void {
  const loose = ctx as unknown as { provide(name: string, value: unknown): () => void }
  loose.provide(name, value)
}

async function bench() {
  const ctx = new Context()
  const slots = new SlotsDouble(ctx)
  new LocaleDouble(ctx)
  const listDirectory = vi.fn(async (_path?: string): Promise<DirectoryListing> => homeListing)
  const createDirectory = vi.fn(async (path: string, name: string) => `${path}/${name}`)
  provideService(ctx, 'uiWorkspace', { listDirectory, createDirectory })
  return { ctx, slots, listDirectory, createDirectory, declare: () => { slots.declare([...HOLES]) } }
}

function owner(overrides: Partial<DirectoryFlowOwnerProps> = {}): DirectoryFlowOwnerProps {
  return {
    open: true, busy: false,
    onPicked: vi.fn(), onCancel: vi.fn(), onError: vi.fn(),
    ...overrides,
  }
}

describe('picker-browse client half', () => {
  it('declares the services it drives', () => {
    expect(inject).toEqual(['slots', 'uiWorkspace', 'locale'])
  })

  it('fills both directory-flow holes for declarations before or after apply, and leaves with its fiber', async () => {
    const before = await bench()
    before.declare()
    const fiber = before.ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    for (const hole of HOLES) expect(before.slots.entries(hole)).toHaveLength(1)
    // Registry-contribution disposal proof: the fiber going down empties the holes.
    await fiber.dispose()
    for (const hole of HOLES) expect(before.slots.entries(hole)).toHaveLength(0)

    const after = await bench()
    await after.ctx.plugin({ inject: [...inject], apply }).await()
    for (const hole of HOLES) expect(after.slots.entries(hole)).toHaveLength(0)
    after.declare()
    for (const hole of HOLES) expect(after.slots.entries(hole)).toHaveLength(1)
  })

  it('rolls back the outer injection when the second hole is already occupied', async () => {
    const b = await bench()
    b.declare()
    // Foreign occupant in the SECOND registered hole: the pair construction
    // throws after the outer injection installed its subscription.
    b.slots.register({ name: HOLES[1] }, () => null)
    const rejections: unknown[] = []
    const onUnhandled = (reason: unknown): void => { rejections.push(reason) }
    process.on('unhandledRejection', onUnhandled)
    try {
      const fiber = b.ctx.plugin({ inject: [...inject], apply })
      await expect(fiber.await()).rejects.toThrow(/already has a registration/)
      // A leaked first deferral would now race this probe registration and
      // throw from its orphaned subscription against the HERO hole; the
      // rollback leaves only the activation failure itself.
      const disposeProbe = b.slots.register({ name: HOLES[0] }, () => null)
      await new Promise(resolve => setTimeout(resolve, 20))
      expect(rejections.map(String).filter(text => text.includes(HOLES[0]))).toEqual([])
      disposeProbe()
    } finally {
      process.off('unhandledRejection', onUnhandled)
    }
  })

  it('rolls back wholesale and reports loudly when a rival injection wins declaration activation', async () => {
    const b = await bench()
    const rejections: unknown[] = []
    const onUnhandled = (reason: unknown): void => { rejections.push(reason) }
    process.on('unhandledRejection', onUnhandled)
    process.on('uncaughtException', onUnhandled)
    try {
      // The rival subscribes first, so the declaration notification lets it
      // occupy the pair before this provider's waiting injection runs.
      b.slots.inject(HOLES[0], () => b.slots.inject(HOLES[1], function* () {
        yield b.slots.register({ name: HOLES[0] }, () => null)
        yield b.slots.register({ name: HOLES[1] }, () => null)
      }))
      await b.ctx.plugin({ inject: [...inject], apply }).await()
      b.declare()
      await new Promise(resolve => setTimeout(resolve, 20))
      // The rival keeps both holes; this provider rolled back wholesale and
      // surfaced the conflict on the fail-loud channel — no partial mix.
      for (const hole of HOLES) expect(b.slots.entries(hole)).toHaveLength(1)
      expect(rejections.map(String).join('\n')).toContain('already has a registration')

      // Non-Error conflicts wrap before the loud rethrow (same channel).
      const c = await bench()
      await c.ctx.plugin({ inject: [...inject], apply }).await()
      const original = c.slots.register.bind(c.slots)
      c.slots.register = (options: { name?: string | undefined }, component: unknown) => {
        if (options.name === HOLES[0]) throw 'string conflict'
        return original(options, component)
      }
      c.declare()
      await new Promise(resolve => setTimeout(resolve, 20))
      expect(rejections.map(String).join('\n')).toContain('string conflict')
    } finally {
      process.off('unhandledRejection', onUnhandled)
      process.off('uncaughtException', onUnhandled)
    }
  })

  it('rolls back the zh dictionary when a rival already owns the namespace en slot', async () => {
    const b = await bench()
    b.declare()
    const locale = b.ctx.get('locale') as unknown as LocaleDouble
    const disposeRival = locale.register('directory-browser', 'en', { 'browser.title': 'rival' })
    const rejections: unknown[] = []
    const onUnhandled = (reason: unknown): void => { rejections.push(reason) }
    // cordis re-raises the apply throw as a late rejection (fail-loud contract).
    process.on('unhandledRejection', onUnhandled)
    try {
      const fiber = b.ctx.plugin({ inject: [...inject], apply })
      await expect(fiber.await()).rejects.toThrow(/already has locale/)
      // The zh registration rolled back with the failure: once the rival
      // leaves, a fresh registrant owns the whole namespace again.
      disposeRival()
      const disposeZh = locale.register('directory-browser', 'zh', { 'browser.title': '空闲' })
      disposeZh()
    } finally {
      await new Promise(resolve => setTimeout(resolve, 0))
      process.off('unhandledRejection', onUnhandled)
    }
  })

  it('registers the dialog dictionaries and binds this package namespace', async () => {
    const b = await bench()
    b.declare()
    await b.ctx.plugin({ inject: [...inject], apply }).await()
    const entry = b.slots.entries(HOLES[0])[0]!
    const injected = (entry.inject as () => { t: (key: string, params?: Record<string, unknown>) => string })()
    // zh is the shipped default locale.
    expect(injected.t('browser.title')).toBe('选择工作区目录')
    expect(injected.t('browser.newFolder')).toBe('新建文件夹')
    expect(injected.t('browser.showHidden')).toBe('显示隐藏文件')
    // The drive row's copy rides the same namespace in all eight dictionaries.
    expect(injected.t('browser.drives')).toBe('驱动器')
    expect(injected.t('browser.drive', { name: 'C:' })).toBe('驱动器 C:')
    const locale = b.ctx.get('locale') as unknown as LocaleDouble
    for (const id of ['en', 'ja', 'es', 'fr', 'de', 'ru', 'pt']) {
      locale.setLocale(id)
      for (const key of ['browser.title', 'browser.drives', 'browser.drive']) {
        expect(injected.t(key)).not.toBe(key)
      }
    }
  })

  it('drives the injected browse calls through the hole entry', async () => {
    const b = await bench()
    b.declare()
    await b.ctx.plugin({ inject: [...inject], apply }).await()
    const entry = b.slots.entries(HOLES[1])[0]!
    const injected = (entry.inject as () => {
      listDirectory: (path?: string) => Promise<DirectoryListing>
      createDirectory: (path: string, name: string) => Promise<string>
      probeDrives: (signal: AbortSignal) => Promise<readonly string[]>
    })()
    await expect(injected.listDirectory()).resolves.toBe(homeListing)
    await expect(injected.createDirectory(HOME, 'fresh')).resolves.toBe(`${HOME}/fresh`)
    expect(b.listDirectory).toHaveBeenCalledOnce()
    expect(b.createDirectory).toHaveBeenCalledWith(HOME, 'fresh')
  })

  it('probes the drive letters through the same Host listing call', async () => {
    const b = await bench()
    b.declare()
    await b.ctx.plugin({ inject: [...inject], apply }).await()
    const entry = b.slots.entries(HOLES[0])[0]!
    const injected = (entry.inject as () => { probeDrives: (signal: AbortSignal) => Promise<readonly string[]> })()
    // Only two roots answer; the other twenty-two are refused like an absent drive.
    b.listDirectory.mockImplementation(async (path?: string) => {
      if (path === 'C:\\' || path === 'F:\\') return homeListing
      throw new Error(`cannot list ${String(path)}`)
    })
    await expect(injected.probeDrives(new AbortController().signal)).resolves.toEqual(['C:\\', 'F:\\'])
    const probed = b.listDirectory.mock.calls.map(call => call[0])
    expect(probed).toHaveLength(24)
    expect(probed[0]).toBe('C:\\')
    expect(probed.at(-1)).toBe('Z:\\')
  })

  it('adapts the owner conversation onto the dialog: confirm picks, dismissal cancels', async () => {
    const props = owner()
    const listDirectory = vi.fn(async (_path?: string): Promise<DirectoryListing> => homeListing)
    const t = (key: string): string => key
    render(
      <BrowseDirectoryFlow
        {...props}
        listDirectory={listDirectory}
        createDirectory={vi.fn(async () => '')}
        probeDrives={async () => []}
        t={t}
      />,
    )
    // The dialog opened at home; its confirm (browser.open) adopts the listed level.
    const openButton = screen.getByRole<HTMLButtonElement>('button', { name: 'browser.open' })
    await waitFor(() => { expect(openButton.disabled).toBe(false) })
    fireEvent.click(openButton)
    expect(props.onPicked).toHaveBeenCalledWith(HOME)
    fireEvent.click(screen.getByRole('button', { name: 'browser.cancel' }))
    expect(props.onCancel).toHaveBeenCalled()
    expect(props.onError).not.toHaveBeenCalled()
  })

  it('renders nothing while the flow is closed', () => {
    const view = render(
      <BrowseDirectoryFlow
        {...owner({ open: false })}
        listDirectory={vi.fn(async () => homeListing)}
        createDirectory={vi.fn(async () => '')}
        probeDrives={async () => []}
        t={key => key}
      />,
    )
    expect(view.container.innerHTML).toBe('')
  })
})

describe('picker-browse node half', () => {
  it('the node apply is an inert loader seat', () => {
    expect(() => { nodeApply() }).not.toThrow()
  })
})
