import { expect, it, vi } from 'vitest'
import { LocaleDouble, SlotsDouble, TabsDouble } from './client-doubles.ts'

vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({
  IconBranchOutlineRegular: () => null,
}))

const { apply, inject } = await import('../src/client/index.ts')

const TAB_ID = '@banzhe/dsh-git'
const SIDEBAR_TAB_SLOT = 'sidebar.right.pane.tab'
const SIDEBAR_TAB_TITLE_SLOT = 'sidebar.right.pane.tab.title'

function composition() {
  const locale = new LocaleDouble()
  const slots = new SlotsDouble()
  const tabs = new TabsDouble()
  const disposers: Array<() => void> = []
  const ctx = {
    effect: (install: () => () => void) => {
      const dispose = install()
      disposers.push(dispose)
      return () => { dispose() }
    },
    locale,
    slots,
    sidebarRightTabs: tabs,
  }
  return { ctx: ctx as never, locale, slots, tabs, disposers }
}

function unload(parts: ReturnType<typeof composition>): void {
  for (const dispose of parts.disposers.splice(0)) dispose()
}

it('injects the three browser services it registers into', () => {
  expect([...inject].sort()).toEqual(['locale', 'sidebarRightTabs', 'slots'])
})

it('registers one builtin tab type whose copy follows the active language', () => {
  const parts = composition()
  apply(parts.ctx)
  expect(parts.tabs.definitions).toHaveLength(1)

  const definition = parts.tabs.definitions[0] as Record<string, unknown>
  expect(definition['id']).toBe(TAB_ID)
  expect(definition['kind']).toBe('git')
  expect(definition['priority']).toBe('builtin')

  const title = definition['title'] as () => string
  expect(title()).toBe('Git')
  parts.locale.setLocale('zh')
  expect(title()).toBe('Git')

  const guide = definition['guide']
  expect(Array.isArray(guide)).toBe(true)
  const entries = guide as Array<Record<string, unknown>>
  expect(entries).toHaveLength(1)
  const entry = entries[0] as Record<string, unknown>
  expect(entry['id']).toBe('workspace')
  expect(entry['order']).toBe(40)
  expect(typeof entry['icon']).toBe('function')

  const entryTitle = entry['title'] as () => string
  const entryDescription = entry['description'] as () => string
  expect(entryDescription()).toBe('查看当前工作区的变更')
  parts.locale.setLocale('en')
  expect(entryTitle()).toBe('Git')
  expect(entryDescription()).toBe('View changes in the current workspace')
})

it('registers one dictionary per language under its own namespace', () => {
  const parts = composition()
  apply(parts.ctx)
  expect(parts.locale.namespaces).toEqual(['git'])

  const translate = parts.locale.bind('git')
  expect(translate('guide.description')).toBe('View changes in the current workspace')
  expect(translate('panel.empty')).toBe('No file changes.')
  expect(translate('commit.done', { hash: 'abc1234' })).toBe('Committed abc1234')
  parts.locale.setLocale('zh')
  expect(translate('panel.empty')).toBe('没有文件变更。')
  expect(translate('commit.done', { hash: 'abc1234' })).toBe('已提交 abc1234')
})

it('registers the panel body and its title into the right-sidebar seats under one key', () => {
  const parts = composition()
  apply(parts.ctx)
  expect(parts.slots.injections).toEqual([SIDEBAR_TAB_SLOT, SIDEBAR_TAB_TITLE_SLOT])
  expect(parts.slots.entries.map(entry => entry.name)).toEqual([SIDEBAR_TAB_SLOT, SIDEBAR_TAB_TITLE_SLOT])
  expect(parts.slots.entries.map(entry => entry.key)).toEqual([TAB_ID, TAB_ID])
  for (const entry of parts.slots.entries) expect(typeof entry.component).toBe('function')
  expect(parts.slots.entries[0]?.locale).toBe('git')
})

it('withdraws every registration when the fiber unloads', () => {
  const parts = composition()
  apply(parts.ctx)
  expect(parts.disposers).toHaveLength(4)
  expect(parts.slots.entries).toHaveLength(2)

  unload(parts)
  expect(parts.tabs.definitions).toEqual([])
  expect(parts.locale.namespaces).toEqual([])
  expect(parts.slots.entries).toEqual([])
})
