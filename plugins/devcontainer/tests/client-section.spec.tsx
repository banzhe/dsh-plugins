// @vitest-environment jsdom
/**
 * The settings section's rendered contract: which rows appear, what each state
 * shows, and what a click does.
 *
 * Rendered through react-dom directly rather than a testing library: the section
 * is a plain function of its composed slot props, so a fake `t` plus the injected
 * face is the whole fixture. The behaviour it must not lose is that a write in
 * flight does NOT lock the rows — the controller queues a toggle that lands
 * mid-write, so a disabled row would silently drop the click that queue exists for.
 */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { VariantsState } from '../src/client/controller.ts'
import { zh, type DevcontainerVariantsKey } from '../src/client/locales.ts'
import { DevcontainerVariantsSection, type DevcontainerVariantsSectionProps } from '../src/client/VariantsSection.tsx'

/** Translate through the Chinese dictionary, the key-set source of truth. */
const t = ((key: DevcontainerVariantsKey, params?: Record<string, unknown>) => {
  const template = zh[key]
  if (params === undefined) return template
  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    name in params ? String(params[name]) : match)
}) as never

const ROWS: VariantsState['rows'] = [
  { id: 'standard', name: '标准模式', description: 'works directly', checked: true, derived: true },
  { id: 'delegate-only', name: '委派模式', description: '', checked: false, derived: false },
  { id: 'subagent-coder', name: 'coder', description: 'writes code', checked: true, derived: false },
]

const READY: VariantsState = {
  status: 'ready',
  failure: null,
  writable: true,
  saving: false,
  rows: ROWS,
  sbxRows: [],
  checkedCount: 2,
  sbxCheckedCount: 0,
}

/** Both tracks populated: the layout the page shows on a real deployment. */
const BOTH: VariantsState = {
  ...READY,
  sbxRows: [
    { id: 'standard', name: '标准模式', description: 'works directly', checked: true, derived: true },
    { id: 'delegate-only', name: '委派模式', description: '', checked: false, derived: false },
  ],
  sbxCheckedCount: 1,
}

interface Harness {
  readonly host: HTMLElement
  readonly load: ReturnType<typeof vi.fn>
  readonly setChecked: ReturnType<typeof vi.fn>
  readonly toggleSbxSource: ReturnType<typeof vi.fn>
  show(state: VariantsState): Promise<void>
  boxes(): HTMLInputElement[]
  row(index: number): HTMLElement
  group(kind: 'devcontainer' | 'sbx'): HTMLElement
  text(): string
  button(label: string): HTMLButtonElement
  click(input: HTMLInputElement): Promise<void>
  clickButton(label: string): Promise<void>
}

let roots: Root[] = []

// React only honors act() when it is told it runs in a test environment.
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

async function mount(state: VariantsState): Promise<Harness> {
  const load = vi.fn(async () => {})
  const setChecked = vi.fn()
  const toggleSbxSource = vi.fn()
  let current = state
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  roots.push(root)
  const props = {
    t,
    useDevcontainerVariants: <T,>(selector: (snapshot: VariantsState) => T): T => selector(current),
    load,
    setChecked,
    toggleSbxSource,
    close: () => {},
  } as unknown as DevcontainerVariantsSectionProps
  const show = async (next: VariantsState): Promise<void> => {
    current = next
    await act(async () => { root.render(createElement(DevcontainerVariantsSection, props)) })
  }
  await show(state)
  const boxes = (): HTMLInputElement[] => [...host.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')]
  const button = (label: string): HTMLButtonElement => {
    const found = [...host.querySelectorAll('button')].find(node => node.textContent === label)
    if (found === undefined) throw new Error(`no button labelled "${label}"`)
    return found
  }
  return {
    host,
    load,
    setChecked,
    toggleSbxSource,
    show,
    boxes,
    row: index => host.querySelectorAll<HTMLElement>('li')[index] as HTMLElement,
    group: kind => host.querySelector<HTMLElement>(`[data-track="${kind}"]`) as HTMLElement,
    text: () => host.textContent ?? '',
    button,
    click: async (input: HTMLInputElement): Promise<void> => { await act(async () => { input.click() }) },
    clickButton: async (label: string): Promise<void> => { await act(async () => { button(label).click() }) },
  }
}

afterEach(async () => {
  await act(async () => {
    for (const root of roots) root.unmount()
  })
  roots = []
  document.body.innerHTML = ''
  vi.clearAllMocks()
})

describe('DevcontainerVariantsSection', () => {
  it('loads on mount and lists every source preset with its state', async () => {
    const page = await mount(READY)
    expect(page.load).toHaveBeenCalledTimes(1)
    expect(page.boxes()).toHaveLength(3)
    expect(page.text()).toContain(zh.nav)
    expect(page.text()).toContain(zh.intro)
    expect(page.text()).toContain(zh.refreshHint)
    expect(page.boxes().map(box => box.checked)).toEqual([true, false, true])
    expect(page.text()).toContain(zh.checkedCount.replace('{count}', '2'))
    expect(page.row(0).getAttribute('data-checked')).toBe('true')
    expect(page.row(1).getAttribute('data-checked')).toBeNull()
  })

  it('marks a registered variant available and a pending one as waiting', async () => {
    const page = await mount(READY)
    expect(page.row(0).querySelector('[data-tone="success"]')?.textContent).toBe(zh.derivedBadge)
    expect(page.row(2).querySelector('[data-tone="warning"]')?.textContent).toBe(zh.pendingBadge)
    // An unchecked row carries no badge at all.
    expect(page.row(1).querySelector('[data-tone]')).toBeNull()
  })

  it('shows the preset id beside a named preset and the description when it has one', async () => {
    const page = await mount(READY)
    expect(page.row(0).querySelector('.dcv-id')?.textContent).toBe('standard')
    expect(page.row(0).querySelector('.dcv-description')?.textContent).toBe('works directly')
    expect(page.row(1).querySelector('.dcv-description')).toBeNull()
  })

  it('says nothing is derived when no box is checked', async () => {
    const page = await mount({ ...READY, rows: ROWS.map(row => ({ ...row, checked: false, derived: false })), checkedCount: 0 })
    expect(page.text()).toContain(zh.noneChecked)
  })

  it('says so when this deployment declares no preset', async () => {
    const page = await mount({ ...READY, rows: [], checkedCount: 0 })
    expect(page.text()).toContain(zh.empty)
    expect(page.boxes()).toHaveLength(0)
  })

  it('keeps the rows interactive while a write is in flight', async () => {
    const page = await mount({ ...READY, saving: true })
    expect(page.boxes().every(box => !box.disabled)).toBe(true)
  })

  it('locks the rows when the Host does not accept writes, and says why', async () => {
    const page = await mount({ ...READY, writable: false })
    expect(page.text()).toContain(zh.readOnly)
    expect(page.boxes().every(box => box.disabled)).toBe(true)
  })

  it('asks the face to derive on check and to drop on clear', async () => {
    const page = await mount(READY)
    await page.click(page.boxes()[1] as HTMLInputElement)
    expect(page.setChecked).toHaveBeenCalledWith('delegate-only', true)
    await page.click(page.boxes()[0] as HTMLInputElement)
    expect(page.setChecked).toHaveBeenLastCalledWith('standard', false)
  })

  it('offers a retry when the roster read failed, and retries on click', async () => {
    const page = await mount({ ...READY, status: 'error', failure: 'load', rows: [], checkedCount: 0 })
    expect(page.text()).toContain(zh.failed)
    await page.clickButton(zh.retry)
    expect(page.load).toHaveBeenCalledTimes(2)
  })

  it('reports a refused write', async () => {
    const page = await mount({ ...READY, failure: 'write' })
    expect(page.text()).toContain(zh.writeFailed)
  })

  it('reports a namespace that is loading, and one this deployment does not serve', async () => {
    const loading = await mount({ ...READY, status: 'loading', rows: [] })
    expect(loading.text()).toContain(zh.loading)
    expect(loading.boxes()).toHaveLength(0)

    const unavailable = await mount({ ...READY, status: 'unavailable', rows: [] })
    expect(unavailable.text()).toContain(zh.unavailable)
    expect(unavailable.host.querySelectorAll('input')).toHaveLength(0)
  })
})
describe('the two derivative tracks', () => {
  it('renders one card per track with that track\'s suffix on its heading', async () => {
    const page = await mount(BOTH)
    expect(page.group('devcontainer').querySelector('.dcv-group-title')?.textContent)
      .toBe(zh.devcontainerTitle + '(devContainer)')
    expect(page.group('sbx').querySelector('.dcv-group-title')?.textContent)
      .toBe(zh.sbxTitle + '(sbx)')
    expect(page.group('devcontainer').querySelector('.dcv-group-description')?.textContent)
      .toBe(zh.devcontainerDescription)
    expect(page.group('sbx').querySelector('.dcv-group-description')?.textContent)
      .toBe(zh.sbxDescription)
  })

  it('lists the same presets on both tracks and keeps their boxes independent', async () => {
    const page = await mount(BOTH)
    expect(page.group('devcontainer').querySelectorAll('li')).toHaveLength(3)
    expect(page.group('sbx').querySelectorAll('li')).toHaveLength(2)
    expect(page.boxes().map(box => box.checked)).toEqual([true, false, true, true, false])
    expect(page.group('sbx').textContent).toContain(zh.sbxCheckedCount.replace('{count}', '1'))
  })

  it('reports each track\'s own variant state, not the other track\'s', async () => {
    const page = await mount({
      ...READY,
      rows: ROWS.map(row => ({ ...row, derived: false })),
      sbxRows: [{ id: 'standard', name: '标准模式', description: '', checked: true, derived: true }],
      checkedCount: 2,
      sbxCheckedCount: 1,
    })
    expect(page.group('devcontainer').querySelector('[data-tone="success"]')).toBeNull()
    expect(page.group('sbx').querySelector('[data-tone="success"]')?.textContent).toBe(zh.derivedBadge)
  })

  it('toggles the sbx track through its own callback', async () => {
    const page = await mount(BOTH)
    await page.click(page.boxes()[4] as HTMLInputElement)
    expect(page.toggleSbxSource).toHaveBeenCalledWith('delegate-only')
    expect(page.setChecked).not.toHaveBeenCalled()
  })

  it('says so when a track has nothing to derive', async () => {
    const page = await mount(READY)
    expect(page.group('sbx').textContent).toContain(zh.sbxEmpty)
    expect(page.group('sbx').querySelectorAll('li')).toHaveLength(0)
  })

  it('says a track derives nothing while the other one still does', async () => {
    const page = await mount({ ...READY, sbxRows: BOTH.sbxRows.map(row => ({ ...row, checked: false, derived: false })) })
    expect(page.group('sbx').textContent).toContain(zh.sbxNoneChecked)
    expect(page.group('devcontainer').textContent).toContain(zh.checkedCount.replace('{count}', '2'))
  })
})
describe('a preset the registry could not mount', () => {
  const BROKEN_STATE: VariantsState = {
    status: 'ready',
    failure: null,
    writable: true,
    saving: false,
    rows: [
      { id: 'standard', name: '标准模式', description: 'works directly', checked: false, derived: false },
      { id: 'broken-one', name: '坏掉的', description: 'cannot mount', checked: false, derived: false, broken: 'row tool-bash is unavailable' },
      { id: 'stored-broken', name: '已存的坏预设', description: '', checked: true, derived: false, broken: 'row tool-bash is unavailable' },
    ],
    sbxRows: [],
    checkedCount: 1,
    sbxCheckedCount: 0,
  }

  it('refuses to check it and says why', async () => {
    const page = await mount(BROKEN_STATE)
    expect(page.boxes()[1]?.disabled).toBe(true)
    expect(page.row(1).querySelector('[data-tone="danger"]')?.textContent).toBe(zh.brokenBadge)
    expect(page.row(1).getAttribute('data-broken')).toBe('true')
    expect(page.boxes()[1]?.closest('label')?.getAttribute('title')).toContain('row tool-bash is unavailable')
  })

  it('still lets a stored broken row be cleared', async () => {
    const page = await mount(BROKEN_STATE)
    expect(page.boxes()[2]?.disabled).toBe(false)
    await page.click(page.boxes()[2] as HTMLInputElement)
    expect(page.setChecked).toHaveBeenCalledWith('stored-broken', false)
  })

  it('leaves a healthy row untouched', async () => {
    const page = await mount(BROKEN_STATE)
    expect(page.boxes()[0]?.disabled).toBe(false)
    expect(page.row(0).querySelector('[data-tone="danger"]')).toBeNull()
    expect(page.row(0).getAttribute('data-broken')).toBeNull()
  })
})
