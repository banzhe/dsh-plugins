/**
 * The Workspace "..." menu extension. The shipped menu is hard-coded — ui-workspace's
 * `ProjectRowItem` renders `[{rename},{delete}]` as data rows with **no slot** to
 * register into — so this module performs DOM menu surgery instead: arm the row's
 * ellipsis trigger, watch `document.body` for the portal menu that click opens,
 * and graft one button into the list, cloned off the shipped rename row so it
 * joins the Menu primitive's styling, keyboard walk, and focus return untouched.
 *
 * The DOM contract this code reads (README "DOM contract"; tests build fixtures
 * from the same description):
 * - a real Workspace header row is `[data-row-key^="workspace:"]` with a
 *   non-empty suffix (the ungrouped bucket's suffix is empty and carries no
 *   menu); its FIRST `button` is the "..." trigger, the second is New session;
 * - the open menu portals a flat `<div role="menu">` into `document.body` whose
 *   `div[role=presentation]` viewport holds one wrapper div per `button[role=menuitem]`
 *   (rename first, danger delete last), each button carrying an icon span and a
 *   label span;
 * - closing: the Menu primitive listens for a document-level `keydown` Escape
 *   while open, so dispatching one settles the menu exactly like the keyboard.
 *
 * The open-in-app Host (shipped by the `dsh-web-app` bundle) gates everything:
 * one `GET open-in-app/apps` decides whether the feature arms at all, and a
 * click answers `POST open-in-app/open {app:'vscode', path}`.
 */
import {
  OPEN_IN_APP_APPS_ROUTE, OPEN_IN_APP_OPEN_ROUTE,
  type OpenInAppAppsPayload, type OpenInAppOpenPayload,
} from '@deepseek-ai/dsh-host-open-in-app/shared'
import type { MenuActionsKey } from './locales.ts'

/** Row attribute value prefix: `workspace:` + id. Ungrouped suffix is empty. */
const ROW_PREFIX = 'workspace:'

/** Marker attribute on the injected button: the idempotency guard and test hook. */
const MARKER = 'data-menu-actions'

/** Marker value naming this extension's injected row. */
const MARKER_VALUE = 'vscode'

/** open-in-app catalog id this row launches (the probe and the POST body share it). */
const VSCODE_APP_ID = 'vscode'

/**
 * Angle-bracket glyph for the injected row. The clone carries the rename
 * row's wrapper and button classes but must not keep its edit icon, so the
 * icon span's content is replaced with this inline path.
 */
const CODE_GLYPH = '<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 4.5 3 8l3 3.5M10 4.5 13 8l-3 3.5"/></svg>'

/** What the injected row needs from its owner: copy, label, path, and failure surface. */
export interface WorkspaceMenuOptions {
  /** Translate a dictionary key of the plugin namespace (toast copy included). */
  t: (key: MenuActionsKey, params?: Record<string, unknown>) => string
  /** Canonical directory of a Workspace, or undefined when the row's id is gone. */
  pathOf: (workspaceId: string) => string | undefined
  /** Surface one resolved failure notice after the menu has closed (the plugin's overlay toast). */
  showToast: (text: string) => void
}

/**
 * Read the Host's resolved-application list once: the feature arms only when
 * this Host actually resolved VS Code (an uninstalled app, an SSH launch
 * environment, or an unreachable route all read as "no VS Code" — the menu
 * then stays exactly as shipped).
 * @returns whether the `vscode` catalog id is available; never rejects.
 */
export async function probeVscode(): Promise<boolean> {
  try {
    const response = await fetch(OPEN_IN_APP_APPS_ROUTE, { headers: { accept: 'application/json' } })
    if (!response.ok) return false
    const payload = await response.json() as Partial<OpenInAppAppsPayload>
    return Array.isArray(payload.apps) && payload.apps.includes(VSCODE_APP_ID)
  } catch {
    return false
  }
}

/**
 * Resolve the arming pair for one event: the Workspace row's ellipsis trigger
 * and the row's Workspace id. Non-matches (no row, empty suffix, a target
 * outside the FIRST button) resolve to null so the caller clears — arming must
 * never survive a press the menu will not answer.
 * @param target - the event target (pointer or key).
 * @returns the trigger and Workspace id, or null when this press arms nothing.
 */
function rowAndTrigger(target: EventTarget | null): { trigger: HTMLElement; workspaceId: string } | null {
  if (!(target instanceof Element)) return null
  const row = target.closest<HTMLElement>(`[data-row-key^="${ROW_PREFIX}"]`)
  if (row === null) return null
  // The `^=` selector guarantees the attribute is there; the empty suffix of
  // the ungrouped bucket is the case the guard below answers.
  const workspaceId = (row.dataset.rowKey as string).slice(ROW_PREFIX.length)
  if (workspaceId === '') return null
  const trigger = row.querySelector<HTMLElement>('button')
  if (trigger === null || !trigger.contains(target)) return null
  return { trigger, workspaceId }
}

/**
 * Graft one menu row into an open Workspace menu: clone the rename row's
 * wrapper (same classes, so the Menu primitive styles and walks it as its
 * own), swap its icon content and label text, mark it, wire its click, and
 * insert it before the danger delete row — the shipped order reads rename →
 * open-in-vscode → delete, with the destructive row still last.
 *
 * Exported so the idempotency guard and the malformed-menu bail are directly
 * exercisable; the observer calls it once per armed open.
 * @param menu - the portal menu's `div[role=menu]` element.
 * @param workspaceId - the armed row's Workspace (its click resolves the path).
 * @param options - label/path/toast face from the plugin body.
 */
export function injectMenuItem(menu: HTMLElement, workspaceId: string, options: WorkspaceMenuOptions): void {
  // A second observation (or a re-entrant call) must not double the row.
  if (menu.querySelector(`[${MARKER}]`) !== null) return
  const items = Array.from(menu.querySelectorAll<HTMLButtonElement>('button[role="menuitem"]'))
  if (items.length === 0) return
  const source = items[0] as HTMLButtonElement
  const last = items[items.length - 1] as HTMLButtonElement
  const wrap = (source.parentElement as HTMLElement).cloneNode(true) as HTMLElement
  const button = wrap.querySelector<HTMLButtonElement>('button[role="menuitem"]') as HTMLButtonElement
  const spans = wrap.querySelectorAll<HTMLSpanElement>('span')
  ;(spans[0] as HTMLSpanElement).innerHTML = CODE_GLYPH
  ;(spans[1] as HTMLSpanElement).textContent = options.t('menu.openInVscode')
  button.setAttribute(MARKER, MARKER_VALUE)
  const lastWrap = last.parentElement as HTMLElement
  ;(lastWrap.parentNode as HTMLElement).insertBefore(wrap, lastWrap)

  button.addEventListener('click', () => {
    const path = options.pathOf(workspaceId)
    /** Both failure shapes (non-2xx answer, rejected request) report identically. */
    const failed = (detail: string): void => {
      console.warn('sidebar-menu-actions: open in VS Code failed:', detail)
      options.showToast(options.t('toast.vscodeFailed', { detail }))
    }
    // POST first, then settle the menu through the primitive's own Escape path,
    // so close/focus-return behave exactly like a shipped row's selection.
    const request = path === undefined
      ? undefined
      : fetch(OPEN_IN_APP_OPEN_ROUTE, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ app: VSCODE_APP_ID, path } satisfies OpenInAppOpenPayload),
      })
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    if (request === undefined) return
    void request.then(
      (response) => { if (!response.ok) failed(`HTTP ${String(response.status)}`) },
      (reason: unknown) => { failed(reason instanceof Error ? reason.message : String(reason)) },
    )
  })
}

/**
 * Install the Workspace-menu half: arm the row's ellipsis on pointer or
 * keyboard activation, and on each portal-menu appearance consume the arm and
 * — when the trigger still holds and the keyboard is where that gesture left
 * it (trigger, body, or inside the menu) — graft the row. The guards keep a
 * stale arm from a cancelled press out of a Session row's menu.
 * @param options - label/path/toast face from the plugin body.
 * @returns the disposer removing both capture listeners and the observer.
 */
export function installWorkspaceMenu(options: WorkspaceMenuOptions): () => void {
  let pending: { trigger: HTMLElement; workspaceId: string } | null = null

  const arm = (event: Event): void => { pending = rowAndTrigger(event.target) }
  const onPointerDown = arm
  const onKeyDown = (event: Event): void => {
    const key = (event as KeyboardEvent).key
    if (key !== 'Enter' && key !== ' ') return
    arm(event)
  }
  const observer = new MutationObserver((records) => {
    if (pending === null) return
    for (const record of records) {
      for (const node of record.addedNodes) {
        if (!(node instanceof HTMLElement) || node.getAttribute('role') !== 'menu') continue
        // Consume the arm on the first portal menu, whatever the guards decide:
        // an arm must not outlive the open it was raised for.
        const armed = pending
        pending = null
        if (!armed.trigger.isConnected) return
        const active = document.activeElement
        if (!(active === armed.trigger || active === document.body || node.contains(active))) return
        injectMenuItem(node, armed.workspaceId, options)
        return
      }
    }
  })

  document.addEventListener('pointerdown', onPointerDown, true)
  document.addEventListener('keydown', onKeyDown, true)
  observer.observe(document.body, { childList: true })
  return () => {
    document.removeEventListener('pointerdown', onPointerDown, true)
    document.removeEventListener('keydown', onKeyDown, true)
    observer.disconnect()
    pending = null
  }
}
