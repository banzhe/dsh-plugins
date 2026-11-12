// @vitest-environment jsdom
/**
 * The header control as a user meets it: which half is on screen, what a press
 * opens, what the list remembers, and what a refused launch reports.
 *
 * The transport, the stores and the notice seat are plain callbacks here, so the
 * spec drives one gesture at a time and reads only what the user would see.
 */
import { act } from 'react'
import * as React from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { LaunchResult } from '../src/client/api.ts'
import { en } from '../src/client/locales.ts'
import { OpenInSelect, type OpenInSelectProps } from '../src/client/OpenInSelect.tsx'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

/** Translate through the shipped English dictionary, params included. */
function translate(key: string, params?: Record<string, unknown>): string {
  const template = (en as Record<string, string>)[key] ?? key
  if (params === undefined) return template
  return template.replace(/\{(\w+)\}/g, (match, name: string) => (name in params ? String(params[name]) : match))
}

interface Choices {
  apps?: readonly string[]
  choice?: string
  launch?: (appId: string, path: string) => Promise<LaunchResult>
  choose?: (appId: string) => void
  report?: (text: string) => void
  iconUrl?: (appId: string) => string
}

/** The composed props, with only the seats the control reads. */
function props(choices: Choices = {}): OpenInSelectProps {
  const apps = choices.apps ?? ['vscode']
  const choice = choices.choice ?? ''
  return {
    absolutePath: '/work/demo',
    useOpenInSelectApps: (selector: (apps: readonly string[]) => unknown) => selector(apps),
    useOpenInSelectChoice: (selector: (choice: string) => unknown) => selector(choice),
    launch: choices.launch ?? (async () => ({ kind: 'opened' })),
    choose: choices.choose ?? (() => {}),
    report: choices.report ?? (() => {}),
    iconUrl: choices.iconUrl ?? (appId => 'open-in-app/icon/' + appId),
    t: translate,
  } as unknown as OpenInSelectProps
}

const mounted: { root: Root, container: HTMLElement }[] = []

/** Mount the control and return its container plus a way to re-render it. */
async function mount(initial: OpenInSelectProps): Promise<{
  container: HTMLElement
  render: (next: OpenInSelectProps) => Promise<void>
}> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  mounted.push({ root, container })
  const render = async (next: OpenInSelectProps): Promise<void> => {
    await act(async () => { root.render(React.createElement(OpenInSelect, next)) })
  }
  await render(initial)
  return { container, render }
}

const buttonsIn = (container: HTMLElement): HTMLButtonElement[] => [
  ...container.querySelectorAll('button'),
]

const chevronIn = (container: HTMLElement): HTMLButtonElement | undefined =>
  buttonsIn(container).find(button => button.getAttribute('aria-haspopup') === 'menu')

const menuIn = (container: HTMLElement): HTMLElement | null => container.querySelector('[role="menu"]')

afterEach(async () => {
  const open = mounted.splice(0, mounted.length)
  for (const entry of open) {
    await act(async () => { entry.root.unmount() })
    entry.container.remove()
  }
})

describe('what the header shows', () => {
  it('renders nothing while the Host resolved no application', async () => {
    const { container } = await mount(props({ apps: [] }))
    expect(container.innerHTML).toBe('')
  })

  it('shows one icon-only button and no chevron for a single application', async () => {
    const { container } = await mount(props({ apps: ['vscode'] }))
    expect(buttonsIn(container)).toHaveLength(1)
    const button = buttonsIn(container)[0]
    expect(button?.textContent).toBe('')
    expect(button?.getAttribute('aria-label')).toBe('Open in VS Code')
    expect(container.querySelector('img')?.getAttribute('src')).toBe('open-in-app/icon/vscode')
    expect(chevronIn(container)).toBeUndefined()
    expect(container.querySelector('[data-tooltip]')?.getAttribute('data-tooltip')).toBe('Open in VS Code')
  })

  it('opens the Session directory in the current application', async () => {
    const launch = vi.fn(async () => ({ kind: 'opened' }) satisfies LaunchResult)
    const choose = vi.fn()
    const { container } = await mount(props({ apps: ['vscode'], launch, choose }))
    await act(async () => { buttonsIn(container)[0]?.click() })
    expect(launch).toHaveBeenCalledWith('vscode', '/work/demo')
    expect(choose).not.toHaveBeenCalled()
  })

  it('opens in the remembered application while the Host still resolves it', async () => {
    const { container } = await mount(props({ apps: ['vscode', 'cursor'], choice: 'cursor' }))
    expect(buttonsIn(container)[0]?.getAttribute('aria-label')).toBe('Open in Cursor')
    expect(container.querySelector('img')?.getAttribute('src')).toBe('open-in-app/icon/cursor')
  })

  it('opens the first application when the remembered one is gone', async () => {
    const { container } = await mount(props({ apps: ['vscode', 'cursor'], choice: 'zed' }))
    expect(buttonsIn(container)[0]?.getAttribute('aria-label')).toBe('Open in VS Code')
  })
})

describe('the application list', () => {
  it('lists the applications in Host order and remembers the pick', async () => {
    const launch = vi.fn(async () => ({ kind: 'opened' }) satisfies LaunchResult)
    const choose = vi.fn()
    const { container } = await mount(props({ apps: ['vscode', 'cursor'], launch, choose }))
    const chevron = chevronIn(container)
    expect(chevron?.getAttribute('aria-expanded')).toBe('false')
    await act(async () => { chevron?.click() })
    expect(chevronIn(container)?.getAttribute('aria-expanded')).toBe('true')
    const rows = [...(menuIn(container)?.querySelectorAll('[role="menuitem"]') ?? [])]
    expect(rows.map(row => row.textContent)).toEqual(['VS Code', 'Cursor'])
    expect(menuIn(container)?.getAttribute('data-selected')).toBe('vscode')
    await act(async () => { (rows[1] as HTMLElement | undefined)?.click() })
    expect(launch).toHaveBeenCalledWith('cursor', '/work/demo')
    expect(choose).toHaveBeenCalledWith('cursor')
    expect(menuIn(container)).toBeNull()
  })

  it('reports a pick the Host refused and keeps the current default', async () => {
    const launch = vi.fn(async () => ({ kind: 'refused', status: 404 }) satisfies LaunchResult)
    const choose = vi.fn()
    const report = vi.fn()
    const { container } = await mount(props({ apps: ['vscode', 'cursor'], launch, choose, report }))
    await act(async () => { chevronIn(container)?.click() })
    const row = container.querySelector('[role="menuitem"][data-app="cursor"]')
    await act(async () => { (row as HTMLElement | null)?.click() })
    expect(choose).not.toHaveBeenCalled()
    expect(report).toHaveBeenCalledWith('Could not open: the application or the path is unavailable')
  })

  it('shows the number for a refusal status it has no copy for', async () => {
    const launch = vi.fn(async () => ({ kind: 'refused', status: 500 }) satisfies LaunchResult)
    const report = vi.fn()
    const { container } = await mount(props({ apps: ['vscode', 'cursor'], launch, report }))
    await act(async () => { chevronIn(container)?.click() })
    const row = container.querySelector('[role="menuitem"][data-app="cursor"]')
    await act(async () => { (row as HTMLElement | null)?.click() })
    expect(report).toHaveBeenCalledWith('Could not open (HTTP 500)')
  })

  it('reports an unreachable Host', async () => {
    const launch = vi.fn(async () => ({ kind: 'unreachable' }) satisfies LaunchResult)
    const report = vi.fn()
    const { container } = await mount(props({ launch, report }))
    await act(async () => { buttonsIn(container)[0]?.click() })
    expect(report).toHaveBeenCalledWith('Could not open: DSH could not be reached')
  })

  it('drops a second press while the launch is in flight', async () => {
    let release: (() => void) | undefined
    const launch = vi.fn(() => new Promise<LaunchResult>((resolve) => {
      release = () => { resolve({ kind: 'opened' } satisfies LaunchResult) }
    }))
    const { container } = await mount(props({ launch }))
    const button = buttonsIn(container)[0]
    await act(async () => { button?.click() })
    expect(launch).toHaveBeenCalledTimes(1)
    expect(buttonsIn(container)[0]?.getAttribute('aria-disabled')).toBe('true')
    expect(buttonsIn(container)[0]?.disabled).toBe(false)
    await act(async () => { buttonsIn(container)[0]?.click() })
    expect(launch).toHaveBeenCalledTimes(1)
    await act(async () => { release?.() })
    expect(buttonsIn(container)[0]?.getAttribute('aria-disabled')).toBe('false')
  })

  it('locks both halves, and the list, while the launch is in flight', async () => {
    let release: (() => void) | undefined
    const launch = vi.fn(() => new Promise<LaunchResult>((resolve) => {
      release = () => { resolve({ kind: 'opened' } satisfies LaunchResult) }
    }))
    const { container } = await mount(props({ apps: ['vscode', 'cursor'], launch }))
    await act(async () => { chevronIn(container)?.click() })
    expect(chevronIn(container)?.getAttribute('aria-expanded')).toBe('true')
    await act(async () => { buttonsIn(container)[0]?.click() })
    // Unavailable, not disabled: the halves stay focusable, clickable and
    // pointer-cursored, so the native attribute must never appear.
    const halves = (): HTMLButtonElement[] =>
      buttonsIn(container).filter(button => button.getAttribute('role') !== 'menuitem')
    expect(halves().map(button => button.getAttribute('aria-disabled'))).toEqual(['true', 'true'])
    expect(halves().map(button => button.disabled)).toEqual([false, false])
    expect(menuIn(container)).toBeNull()
    // The chevron stays clickable (pointer affordance), so the press is dropped
    // by the toggle guard instead: the list reopens once the launch settles.
    await act(async () => { chevronIn(container)?.click() })
    expect(menuIn(container)).toBeNull()
    await act(async () => { release?.() })
    expect(halves().map(button => button.getAttribute('aria-disabled'))).toEqual(['false', 'false'])
    expect(menuIn(container)).not.toBeNull()
  })

  it('closes the list while a launch is in flight', async () => {
    let release: (() => void) | undefined
    const launch = vi.fn(() => new Promise<LaunchResult>((resolve) => {
      release = () => { resolve({ kind: 'opened' } satisfies LaunchResult) }
    }))
    const { container } = await mount(props({ apps: ['vscode', 'cursor'], launch }))
    await act(async () => { chevronIn(container)?.click() })
    expect(menuIn(container)).not.toBeNull()
    await act(async () => { buttonsIn(container)[0]?.click() })
    expect(menuIn(container)).toBeNull()
    await act(async () => { release?.() })
  })
})

describe('the icon', () => {
  it('falls back to the glyph when one source fails, and retries another', async () => {
    const { container, render } = await mount(props({ apps: ['vscode'] }))
    const img = container.querySelector('img')
    if (img === null) throw new Error('no icon rendered')
    await act(async () => { img.dispatchEvent(new Event('error')) })
    expect(container.querySelector('img')).toBeNull()
    expect(container.querySelector('[data-test-icon="open"]')).not.toBeNull()
    await render(props({ apps: ['cursor'] }))
    expect(container.querySelector('img')?.getAttribute('src')).toBe('open-in-app/icon/cursor')
  })
})
