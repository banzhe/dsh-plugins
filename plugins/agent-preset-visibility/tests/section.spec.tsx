// @vitest-environment jsdom
/**
 * The settings section's rendered contract: what each state shows, which rows are
 * interactive, and what a click does.
 *
 * Rendered through react-dom directly rather than a testing library: the section
 * is a plain function of its composed slot props, so a fake `t` plus the injected
 * face is the whole fixture. The one behaviour it must not lose is that a write in
 * flight does NOT lock the rows — the controller queues a toggle that lands
 * mid-write, so a disabled row would silently drop the click that queue exists for.
 */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PresetVisibilityState } from '../src/client/controller.ts'
import { zh, type PresetVisibilityKey } from '../src/client/locales.ts'
import {
  PresetVisibilitySection, type PresetVisibilitySectionProps,
} from '../src/client/PresetVisibilitySection.tsx'

/** Translate through the Chinese dictionary, the key-set source of truth. */
const t = ((key: PresetVisibilityKey, params?: Record<string, unknown>) => {
  const template = zh[key]
  if (params === undefined) return template
  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    name in params ? String(params[name]) : match)
}) as never

const ROWS: PresetVisibilityState['rows'] = [
  { id: 'standard', name: 'standard', hidden: false, isDefault: true, broken: false },
  { id: 'minimal', name: 'minimal', hidden: true, isDefault: false, broken: false },
  { id: 'subagent-coder', name: 'Coder', hidden: false, isDefault: false, broken: true },
]

const READY: PresetVisibilityState = {
  status: 'ready',
  failure: null,
  writable: true,
  saving: false,
  rows: ROWS,
  hiddenCount: 1,
}

interface Harness {
  readonly host: HTMLElement
  readonly load: ReturnType<typeof vi.fn>
  readonly setHidden: ReturnType<typeof vi.fn>
  show(state: PresetVisibilityState): Promise<void>
  boxes(): HTMLInputElement[]
  row(index: number): HTMLElement
  text(): string
  button(label: string): HTMLButtonElement
  click(input: HTMLInputElement): Promise<void>
  clickButton(label: string): Promise<void>
}

let roots: Root[] = []

// React only honors act() when it is told it runs in a test environment.
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

async function mount(state: PresetVisibilityState): Promise<Harness> {
  const load = vi.fn(async () => {})
  const setHidden = vi.fn()
  let current = state
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  roots.push(root)
  const props = {
    t,
    usePresetVisibility: <T,>(selector: (snapshot: PresetVisibilityState) => T): T => selector(current),
    load,
    setHidden,
    close: () => {},
  } as unknown as PresetVisibilitySectionProps
  const show = async (next: PresetVisibilityState): Promise<void> => {
    current = next
    await act(async () => { root.render(createElement(PresetVisibilitySection, props)) })
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
    setHidden,
    show,
    boxes,
    row: index => host.querySelectorAll<HTMLElement>('li')[index]!,
    text: () => host.textContent ?? '',
    button,
    click: async (input: HTMLInputElement): Promise<void> => {
      await act(async () => { input.click() })
    },
    clickButton: async (label: string): Promise<void> => {
      await act(async () => { button(label).click() })
    },
  }
}

afterEach(async () => {
  // Unmount inside act(): tearing a root down is itself an update in a test env.
  await act(async () => {
    for (const root of roots) root.unmount()
  })
  roots = []
  document.body.innerHTML = ''
  vi.clearAllMocks()
})

describe('PresetVisibilitySection', () => {
  it('loads on mount and lists every preset with its state, default and broken badges', async () => {
    const page = await mount(READY)
    expect(page.load).toHaveBeenCalledTimes(1)
    expect(page.boxes()).toHaveLength(3)
    expect(page.text()).toContain(zh.nav)
    expect(page.text()).toContain(zh.intro)
    expect(page.text()).toContain(zh.refreshHint)
    // A named preset shows its id next to the name; an unnamed one shows the id as the label.
    expect(page.row(0).querySelector('.apv-id')).toBeNull()
    expect(page.row(2).querySelector('.apv-id')?.textContent).toBe('subagent-coder')
    expect(page.row(0).querySelector('[data-tone="solid"]')?.textContent).toBe(zh.defaultBadge)
    expect(page.row(2).querySelector('[data-tone="danger"]')?.textContent).toBe(zh.brokenBadge)
    expect(page.row(1).getAttribute('data-hidden')).toBe('true')
    expect(page.row(0).getAttribute('data-hidden')).toBeNull()
    expect(page.boxes().map(box => box.checked)).toEqual([true, false, true])
    expect(page.text()).toContain(zh.hiddenCount.replace('{count}', '1'))
  })

  it('says every preset is shown when the hidden list is empty', async () => {
    const page = await mount({ ...READY, rows: [ROWS[0]!], hiddenCount: 0 })
    expect(page.text()).toContain(zh.allShown)
  })

  it('keeps the rows interactive while a write is in flight', async () => {
    const page = await mount({ ...READY, saving: true })
    expect(page.boxes().every(box => !box.disabled)).toBe(true)
    expect(page.boxes()[0]?.disabled).toBe(false)
  })

  it('locks the rows when the Host does not accept writes, and says why', async () => {
    const page = await mount({ ...READY, writable: false })
    expect(page.text()).toContain(zh.readOnly)
    expect(page.boxes().every(box => box.disabled)).toBe(true)
  })

  it('hides a shown preset and shows a hidden one, passing the next state to the face', async () => {
    const page = await mount(READY)
    await page.click(page.boxes()[0]!)
    expect(page.setHidden).toHaveBeenCalledWith('standard', true)
    await page.click(page.boxes()[1]!)
    expect(page.setHidden).toHaveBeenLastCalledWith('minimal', false)
  })

  it('offers a retry when the roster read failed, and retries on click', async () => {
    const page = await mount({ ...READY, status: 'error', failure: 'load', rows: [], hiddenCount: 0 })
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
