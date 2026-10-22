/**
 * The Workspace "..." menu extension. The shipped menu is hard-coded — ui-workspace's
 * `ProjectRowItem` renders `[{rename},{delete}]` as data rows with **no slot** to
 * register into — so this module performs DOM menu surgery instead: arm the row's
 * ellipsis trigger, watch `document.body` for the portal menu that click opens,
 * and graft the buttons into the list, cloned off the shipped rename row so they
 * join the Menu primitive's styling, keyboard walk, and focus return untouched.
 *
 * The DOM contract this code reads is the "DOM contract" table in
 * `docs/plugins/sidebar-menu-actions.md`; the tests build fixtures from the same
 * description.
 *
 * Closing goes through the primitive's own Escape listener, so the menu settles
 * exactly like the keyboard.
 *
 * The rows have different gates. Copying a directory is a browser-local
 * clipboard write, so that row is always grafted. The launch rows — VS Code, and
 * the OS's own file browser for the Workspace directory — need the Host: the
 * open-in-app Host (shipped by the `dsh-web-app` bundle) gates them, where one
 * `GET open-in-app/apps` decides which are grafted at all and a click answers
 * `POST open-in-app/open {app, path}`.
 *
 * The file-browser row is therefore Windows-only without a platform sniff: the
 * official catalog declares `explorer` on `win32` alone, so the probe reports it
 * only when the Host is Windows (and its `shell-open` launcher is the OS's
 * configured default handler for a directory, not a hard-coded `explorer.exe`).
 */
import {
  OPEN_IN_APP_APPS_ROUTE, OPEN_IN_APP_OPEN_ROUTE,
  type OpenInAppAppsPayload, type OpenInAppOpenPayload,
} from '@deepseek-ai/dsh-host-open-in-app/shared'
import type { MenuActionsKey } from './locales.ts'

/** Row attribute value prefix: `workspace:` + id. Ungrouped suffix is empty. */
const ROW_PREFIX = 'workspace:'

/** Marker attribute on the injected buttons: the idempotency guard and test hook. */
const MARKER_ATTR = 'data-menu-actions'

/** The closed set of marker values: one per graftable launch row, plus the copy row. */
type LaunchMarker = 'vscode' | 'explorer'
type RowMarker = LaunchMarker | 'copy-path'

const MARKER_COPY: RowMarker = 'copy-path'

/**
 * Wrap one icon's children in the 16px grid and 1.5px stroke envelope every row
 * shares. The clone carries the rename row's wrapper and button classes but must
 * not keep its edit icon, so the icon span's content is replaced with this.
 */
const glyph = (children: string): string =>
  `<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${children}</svg>`

/** Angle-bracket glyph for the VS Code row. */
const CODE_GLYPH = glyph('<path d="M6 4.5 3 8l3 3.5M10 4.5 13 8l-3 3.5"/>')

/** Folder glyph for the file-browser row. */
const FOLDER_GLYPH = glyph('<path d="M2.5 5.5a1.5 1.5 0 0 1 1.5-1.5h2l1.5 1.5h5a1.5 1.5 0 0 1 1.5 1.5v4.5a1.5 1.5 0 0 1-1.5 1.5H4a1.5 1.5 0 0 1-1.5-1.5z"/>')

/** Two-sheet glyph for the copy row. */
const COPY_GLYPH = glyph('<rect x="5.5" y="5.5" width="8" height="8" rx="2"/><path d="M10.5 4.5V4a1.5 1.5 0 0 0-1.5-1.5H4A1.5 1.5 0 0 0 2.5 4v5A1.5 1.5 0 0 0 4 10.5h.5"/>')

/** One graftable launch row: which catalog id to probe, and how to graft and report it. */
interface LaunchRow {
  readonly marker: LaunchMarker
  /** open-in-app catalog id, shared by the probe's gate and the POST body. */
  readonly app: string
  readonly label: MenuActionsKey
  readonly icon: string
  /** Notice raised for either failure shape; `{detail}` is the status or message. */
  readonly failure: MenuActionsKey
  /** Console line prefix for the same failure. */
  readonly failureLog: string
}

/**
 * The launch rows in graft order. Each is gated on the Host having resolved its
 * catalog id, and `explorer` is declared on `win32` alone by the official
 * catalog — so the file-browser row appears only on a Windows Host, with no
 * platform sniff here. Its launcher is the official `shell-open` entry, i.e. the
 * OS's open verb for a directory, which honors whichever file browser the user
 * has configured as the default rather than naming `explorer.exe`.
 */
const LAUNCH_ROWS: readonly LaunchRow[] = [
  {
    marker: 'vscode',
    app: 'vscode',
    label: 'menu.openInVscode',
    icon: CODE_GLYPH,
    failure: 'toast.vscodeFailed',
    failureLog: 'sidebar-menu-actions: open in VS Code failed:',
  },
  {
    marker: 'explorer',
    app: 'explorer',
    label: 'menu.openInFileBrowser',
    icon: FOLDER_GLYPH,
    failure: 'toast.fileBrowserFailed',
    failureLog: 'sidebar-menu-actions: open in the file browser failed:',
  },
]

/** The catalog ids the launch rows need, in graft order — the set a probe must answer. */
export const LAUNCH_APP_IDS: readonly string[] = LAUNCH_ROWS.map(row => row.app)

/** What the injected rows need from their owner: labels, path, and the two outcomes. */
export interface WorkspaceMenuOptions {
  /** Translate a dictionary key of the plugin namespace. */
  t: (key: MenuActionsKey, params?: Record<string, unknown>) => string
  /** Canonical directory of a Workspace, or undefined when the row's id is gone. */
  pathOf: (workspaceId: string) => string | undefined
  /** Surface one resolved failure notice after the menu has closed (the plugin's overlay toast). */
  showToast: (text: string) => void
  /**
   * The catalog ids this Host resolved, read at graft time. A probe that settles
   * after the first menu was opened still adds its rows to the next one.
   */
  launchableApps: () => ReadonlySet<string>
  /** Write one resolved directory to the clipboard; reports its own outcome as a notice. */
  copyPath: (path: string) => void
}

/**
 * Read the Host's resolved-application list once. A launch row is grafted only
 * when this Host actually resolved its id (an uninstalled app, an SSH launch
 * environment, or an unreachable route all read as an empty set, keeping only
 * the copy row). Never rejects.
 */
export async function probeOpenInApps(): Promise<ReadonlySet<string>> {
  try {
    const response = await fetch(OPEN_IN_APP_APPS_ROUTE, { headers: { accept: 'application/json' } })
    if (!response.ok) return new Set()
    const payload = await response.json() as Partial<OpenInAppAppsPayload>
    return new Set(Array.isArray(payload.apps) ? payload.apps : [])
  } catch {
    return new Set()
  }
}

/**
 * Resolve the arming pair for one event. Non-matches (no row, empty suffix, a
 * target outside the FIRST button) resolve to null so the caller clears —
 * arming must never survive a press the menu will not answer.
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

/** Close the open menu through the primitive's own Escape listener. */
function closeMenu(): void {
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
}

/**
 * Graft the rows into an open Workspace menu: clone the rename row's wrapper
 * (same classes, so the Menu primitive styles and walks it as its own) once per
 * row, swap its icon content and label text, mark it, wire its click, and insert
 * it before the danger delete row. Each row keeps the shipped order — VS Code,
 * the file browser, then the copy row, then delete.
 *
 * A launch row is skipped when the Host never resolved its app. Every row is
 * guarded by its own marker, so a second observation (or a re-entrant call)
 * doubles none of them.
 *
 * Exported so the idempotency guard and the malformed-menu bail are directly
 * exercisable; the observer calls it once per armed open.
 */
export function injectMenuItem(menu: HTMLElement, workspaceId: string, options: WorkspaceMenuOptions): void {
  const items = Array.from(menu.querySelectorAll<HTMLButtonElement>('button[role="menuitem"]'))
  if (items.length === 0) return
  const source = items[0] as HTMLButtonElement
  const last = items[items.length - 1] as HTMLButtonElement
  const lastWrap = last.parentElement as HTMLElement
  const viewport = lastWrap.parentNode as HTMLElement

  /** Clone the rename row into one marked row, returning its button. */
  const graft = (marker: RowMarker, label: string, icon: string): HTMLButtonElement => {
    const wrap = (source.parentElement as HTMLElement).cloneNode(true) as HTMLElement
    const button = wrap.querySelector<HTMLButtonElement>('button[role="menuitem"]') as HTMLButtonElement
    const spans = wrap.querySelectorAll<HTMLSpanElement>('span')
    ;(spans[0] as HTMLSpanElement).innerHTML = icon
    ;(spans[1] as HTMLSpanElement).textContent = label
    button.setAttribute(MARKER_ATTR, marker)
    viewport.insertBefore(wrap, lastWrap)
    return button
  }
  /** The idempotency guard every row shares. */
  const notGrafted = (marker: RowMarker): boolean =>
    menu.querySelector(`[${MARKER_ATTR}="${marker}"]`) === null

  const launchable = options.launchableApps()
  for (const row of LAUNCH_ROWS) {
    if (!launchable.has(row.app) || !notGrafted(row.marker)) continue
    graft(row.marker, options.t(row.label), row.icon).addEventListener('click', () => {
      const path = options.pathOf(workspaceId)
      /** Both failure shapes (non-2xx answer, rejected request) report identically. */
      const failed = (detail: string): void => {
        console.warn(row.failureLog, detail)
        options.showToast(options.t(row.failure, { detail }))
      }
      // POST first, then settle the menu through the primitive's own Escape path,
      // so close/focus-return behave exactly like a shipped row's selection.
      const request = path === undefined
        ? undefined
        : fetch(OPEN_IN_APP_OPEN_ROUTE, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ app: row.app, path } satisfies OpenInAppOpenPayload),
        })
      closeMenu()
      if (request === undefined) return
      void request.then(
        (response) => { if (!response.ok) failed(`HTTP ${String(response.status)}`) },
        (reason: unknown) => { failed(reason instanceof Error ? reason.message : String(reason)) },
      )
    })
  }

  if (notGrafted(MARKER_COPY)) {
    graft(MARKER_COPY, options.t('menu.copyWorkspacePath'), COPY_GLYPH).addEventListener('click', () => {
      // Resolve before closing, exactly as the launch rows do: the menu must
      // settle like a shipped row's selection even when the Workspace is gone.
      const path = options.pathOf(workspaceId)
      closeMenu()
      if (path === undefined) return
      options.copyPath(path)
    })
  }
}

/**
 * Install the Workspace-menu half: arm the row's ellipsis on pointer or keyboard
 * activation, and on each portal-menu appearance consume the arm and — when the
 * trigger still holds and the keyboard is where that gesture left it — graft the
 * rows. The guards keep a stale arm from a cancelled press out of a Session row's
 * menu. Returns the disposer removing both capture listeners and the observer.
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
