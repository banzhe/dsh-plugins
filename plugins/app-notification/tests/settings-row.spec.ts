// @vitest-environment jsdom
/**
 * The settings row's rendered contract: what the readouts say for each
 * permission/badge state, which buttons are enabled, and what each button does
 * — including the state the readout must land on when the platform refuses.
 *
 * Rendered through react-dom directly rather than a testing library: the row is
 * a plain function of its composed slot props, so a fake `t` plus the injected
 * face is the whole fixture.
 */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { NotificationPermissionState } from '../src/client/presenter.ts'
import { CompletionSettingsRow, type CompletionSettingsInjected } from '../src/client/SettingsRow.tsx'
import { en, zh, type AppBadgeKey } from '../src/client/locales.ts'

/** Translate through the Chinese dictionary (the key-set source of truth). */
const t = ((key: AppBadgeKey, params?: Record<string, unknown>) => {
  const template = zh[key]
  if (params === undefined) return template
  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    name in params ? String(params[name]) : match)
}) as never

interface Harness {
  readonly root: Root
  readonly injected: CompletionSettingsInjected
  text(): string
  button(label: string): HTMLButtonElement
  rerender(): Promise<void>
  click(label: string): Promise<void>
}

let roots: Root[] = []

// React only honors act() when it is told it runs in a test environment.
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

/**
 * Mount the row over a controllable injected face.
 * @param options.permission - value `permission()` reports and actions reset to.
 * @param options.badge - whether the page supports the icon badge.
 * @param options.requestResult - what `request()` resolves to (defaults to `permission`).
 * @param options.testResult - what `test()` returns (defaults to `permission === 'granted'`).
 * @returns the harness driving the mounted tree.
 */
async function mount(options: {
  permission: NotificationPermissionState
  badge?: boolean
  requestResult?: NotificationPermissionState
  testResult?: boolean
  rejectRequest?: boolean
}): Promise<Harness> {
  let current = options.permission
  const injected: CompletionSettingsInjected = {
    permission: () => current,
    badgeSupported: () => options.badge ?? true,
    request: vi.fn(async () => {
      if (options.rejectRequest === true) throw new Error('insecure context')
      current = options.requestResult ?? options.permission
      return current
    }),
    test: vi.fn(() => options.testResult ?? current === 'granted'),
  }
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  roots.push(root)
  const render = async (): Promise<void> => {
    await act(async () => {
      // createElement, never a direct call: hooks require React to own the render.
      root.render(createElement(CompletionSettingsRow, { t, ...injected }))
    })
  }
  await render()
  const button = (label: string): HTMLButtonElement => {
    const found = [...host.querySelectorAll('button')].find(node => node.textContent === label)
    if (found === undefined) throw new Error(`no button labelled "${label}"`)
    return found
  }
  return {
    root,
    injected,
    text: () => host.textContent ?? '',
    button,
    rerender: render,
    click: async (label: string): Promise<void> => {
      await act(async () => { button(label).click() })
    },
  }
}

afterEach(() => {
  for (const root of roots) root.unmount()
  roots = []
  document.body.innerHTML = ''
  vi.clearAllMocks()
})

describe('CompletionSettingsRow', () => {
  it('reports a granted permission and an available badge', async () => {
    const row = await mount({ permission: 'granted' })
    expect(row.text()).toContain(zh['settings.title'])
    expect(row.text()).toContain(zh['settings.permission.granted'])
    expect(row.text()).toContain(zh['settings.badge.supported'])
  })

  it('reports denied and unsupported states it did not cause', async () => {
    const denied = await mount({ permission: 'denied', badge: false })
    expect(denied.text()).toContain(zh['settings.permission.denied'])
    expect(denied.text()).toContain(zh['settings.badge.unsupported'])

    const unsupported = await mount({ permission: 'unsupported' })
    expect(unsupported.text()).toContain(zh['settings.permission.unsupported'])
  })

  it('offers the request button only while there is something left to ask', async () => {
    const ungranted = await mount({ permission: 'default' })
    expect(ungranted.button(zh['settings.request']).disabled).toBe(false)

    const granted = await mount({ permission: 'granted' })
    expect(granted.button(zh['settings.request']).disabled).toBe(true)

    // Nothing to ask a browser that has no notification API at all.
    const unsupported = await mount({ permission: 'unsupported' })
    expect(unsupported.button(zh['settings.request']).disabled).toBe(true)
  })

  it('enables the test button only once a notification can actually be built', async () => {
    const ungranted = await mount({ permission: 'default' })
    expect(ungranted.button(zh['settings.test']).disabled).toBe(true)

    const granted = await mount({ permission: 'granted' })
    expect(granted.button(zh['settings.test']).disabled).toBe(false)
  })

  it('requests the permission and moves the readout to the granted state', async () => {
    const row = await mount({ permission: 'default', requestResult: 'granted' })
    await row.click(zh['settings.request'])
    expect(row.injected.request).toHaveBeenCalledTimes(1)
    expect(row.text()).toContain(zh['settings.permission.granted'])
  })

  it('leaves a denied answer on the readout instead of pretending it worked', async () => {
    const row = await mount({ permission: 'default', requestResult: 'denied' })
    await row.click(zh['settings.request'])
    expect(row.text()).toContain(zh['settings.permission.denied'])
  })

  it('re-reads the live permission when the request itself rejects', async () => {
    const row = await mount({ permission: 'denied', rejectRequest: true })
    await row.click(zh['settings.request'])
    // The readout reports the platform, not the failed attempt.
    expect(row.text()).toContain(zh['settings.permission.denied'])
    expect(row.text()).not.toContain(zh['settings.requesting'])
  })

  it('shows the request button as busy while the platform prompt is open', async () => {
    // A deferred request: the browser's permission prompt is open, so the row
    // must show the busy label and refuse a second ask.
    let settle: ((value: NotificationPermissionState) => void) | undefined
    const pending = new Promise<NotificationPermissionState>((resolve) => { settle = resolve })
    const host = document.createElement('div')
    document.body.append(host)
    const root = createRoot(host)
    roots.push(root)
    await act(async () => {
      root.render(createElement(CompletionSettingsRow, {
        t,
        permission: () => 'default',
        badgeSupported: () => true,
        request: () => pending,
        test: () => false,
      }))
    })
    const button = (): HTMLButtonElement => {
      const found = [...host.querySelectorAll('button')][0]
      if (found === undefined) throw new Error('no request button')
      return found
    }
    await act(async () => { button().click() })
    expect(button().disabled).toBe(true)
    expect(host.textContent).toContain(zh['settings.requesting'])
    await act(async () => { settle?.('granted') })
    expect(host.textContent).toContain(zh['settings.permission.granted'])
  })

  it('confirms a sent test notification', async () => {
    const row = await mount({ permission: 'granted', testResult: true })
    await row.click(zh['settings.test'])
    expect(row.injected.test).toHaveBeenCalledTimes(1)
    expect(row.text()).toContain(zh['settings.test.sent'])
  })

  it('reports a refused test notification as a failure, not a success', async () => {
    const row = await mount({ permission: 'granted', testResult: false })
    await row.click(zh['settings.test'])
    expect(row.text()).toContain(zh['settings.test.failed'])
  })

  it('renders English copy through the same keys', async () => {
    const host = document.createElement('div')
    document.body.append(host)
    const root = createRoot(host)
    roots.push(root)
    const englishT = ((key: AppBadgeKey) => en[key]) as never
    await act(async () => {
      root.render(createElement(CompletionSettingsRow, {
        t: englishT,
        permission: () => 'granted',
        badgeSupported: () => true,
        request: async () => 'granted',
        test: () => true,
      }))
    })
    expect(host.textContent).toContain(en['settings.title'])
    expect(host.textContent).toContain(en['settings.permission.granted'])
  })
})
