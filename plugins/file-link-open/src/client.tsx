/**
 * @banzhe/dsh-file-link-open — Client half. A right-click context menu over
 * file links rendered inside session messages: open in a detected editor, open
 * the containing folder in the platform file manager, or copy the path.
 *
 * Pure event delegation on `document`; left-click keeps the official preview
 * behavior untouched. The viewed session's working directory is published by a
 * null cell in the official `conversation.session.header.utilities` slot (the
 * seat the official open-in-app button consumes); relative paths resolve
 * against it.
 *
 * Implementation derived from https://github.com/cholf5/dsh-plugin-file-actions
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: declares the 'conversation.session.header.utilities' SlotMap key.
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
// Type-only: pulls the SlotRegistry service merge (ctx.slots).
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
// Type-only: the Session standard props (sessionId, useSessions) the cell reads.
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import * as React from 'react'
import * as ReactDOMClient from 'react-dom/client'
import { Menu, writeClipboard, type MenuEntry } from '@deepseek-ai/dsh-client-ui-primitives'
import {
  OPEN_IN_APP_APPS_ROUTE, OPEN_IN_APP_ICON_PREFIX_ROUTE, OPEN_IN_APP_OPEN_ROUTE,
  type OpenInAppAppsPayload,
} from '@deepseek-ai/dsh-host-open-in-app/shared'
import { classifyContextTarget, type LinkTarget } from './client/target.ts'
import { EDITOR_IDS, type EditorId } from './editors.ts'
import { INFO_ROUTE, LAUNCH_ROUTE } from './routes.ts'

/** Locale namespace owned by this plugin. */
export const NS = 'fileLinkOpen'

export const zh = {
  copyRelativePath: '复制相对路径',
  copyAbsolutePath: '复制绝对路径',
  atLine: '第 {line} 行',
  'app.vscode': 'VS Code',
  'app.vscodeinsiders': 'VS Code Insiders',
  'app.cursor': 'Cursor',
  'app.windsurf': 'Windsurf',
  'app.zed': 'Zed',
  'app.sublimetext': 'Sublime Text',
  'app.androidstudio': 'Android Studio',
  'app.intellij': 'IntelliJ IDEA',
  'app.pycharm': 'PyCharm',
  'app.webstorm': 'WebStorm',
  'app.phpstorm': 'PhpStorm',
  'app.goland': 'GoLand',
  'app.rider': 'Rider',
  'app.rustrover': 'RustRover',
  'app.finder': '访达',
  'app.explorer': '文件资源管理器',
  'app.filemanager': '文件管理器',
} as const

export const en = {
  copyRelativePath: 'Copy relative path',
  copyAbsolutePath: 'Copy absolute path',
  atLine: 'Line {line}',
  'app.vscode': 'VS Code',
  'app.vscodeinsiders': 'VS Code Insiders',
  'app.cursor': 'Cursor',
  'app.windsurf': 'Windsurf',
  'app.zed': 'Zed',
  'app.sublimetext': 'Sublime Text',
  'app.androidstudio': 'Android Studio',
  'app.intellij': 'IntelliJ IDEA',
  'app.pycharm': 'PyCharm',
  'app.webstorm': 'WebStorm',
  'app.phpstorm': 'PhpStorm',
  'app.goland': 'GoLand',
  'app.rider': 'Rider',
  'app.rustrover': 'RustRover',
  'app.finder': 'Finder',
  'app.explorer': 'File Explorer',
  'app.filemanager': 'Files',
} as const

export type LocaleKey = keyof typeof en

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    fileLinkOpen: LocaleKey
  }
}

/**
 * Unlike editors these ride the official probe alone: their launch is the
 * official POST /open-in-app/open with the file's DIRECTORY, so the official
 * route itself guarantees "menu shows it, click works" and this plugin's own
 * resolution has nothing to confirm.
 */
const FILE_MANAGER_IDS = ['finder', 'explorer', 'filemanager'] as const

/** One file-manager id; `FILE_MANAGER_IDS.includes` does not narrow by itself. */
type FileManagerId = (typeof FILE_MANAGER_IDS)[number]

/** Fetch one JSON body with its status; never rejects. The body stays `unknown`: each caller narrows the shape it expects. */
async function fetchJson(url: string, options?: RequestInit): Promise<{ ok: boolean, status: number, data: unknown }> {
  try {
    const res = await fetch(url, options)
    try {
      return { ok: res.ok, status: res.status, data: await res.json() }
    }
    catch {
      return { ok: false, status: res.status, data: null }
    }
  }
  catch {
    return { ok: false, status: 0, data: null }
  }
}

function postJson(url: string, body: unknown) {
  return fetchJson(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

function isWindowsStyledPath(value: string) {
  return /^[A-Za-z]:[/\\]/.test(value) || value.startsWith('\\\\')
}

/** Browser-safe workspace path resolution, mirroring @deepseek-ai/dsh-util-workspace-path. */
function resolveWorkspacePath(cwd: string | null | undefined, p: string) {
  if (p.startsWith('/') || isWindowsStyledPath(p)) return p
  if (cwd === null || cwd === undefined || cwd === '') return p
  const separator = isWindowsStyledPath(cwd) && cwd.includes('\\') ? '\\' : '/'
  const base = cwd.replace(/[/\\]+$/, '')
  const relative = p.replace(/^[/\\]+/, '')
  return base + separator + relative
}

/**
 * Strip the workspace root off an absolute path, mirroring the official
 * relativizeToCwd plus the separator normalization its own fileAddressFor
 * applies: newer hosts may present paths absolutely, and old sessions may
 * record the root in the other separator spelling, so the prefix check runs on
 * slash-normalized forms while the slice keeps the original spelling of the
 * remainder.
 */
function relativizeToCwd(text: string, cwd: string | null | undefined) {
  if (cwd === null || cwd === undefined || cwd === '') return text
  const root = cwd.replace(/[/\\]+$/, '').replaceAll('\\', '/')
  const normalized = text.replaceAll('\\', '/')
  if (normalized.startsWith(root + '/')) return text.slice(root.length + 1)
  return text
}

/** Directory portion of an absolute POSIX (or Windows-style) path. */
function dirnameOf(p: string) {
  const normalized = p.replaceAll('\\', '/')
  const index = normalized.lastIndexOf('/')
  if (index <= 0) return index === 0 ? '/' : normalized
  if (index === 2 && normalized[1] === ':') return normalized.slice(0, 3)
  return normalized.slice(0, index)
}

interface AppState {
  officialApps: string[] | null
  /** Null/undefined `available` means the host reported nothing, not "nothing available". */
  info: { available?: string[] | null | undefined } | null
}

/** One JSON array of ids, filtering anything else; null when the value is not an array. */
function stringArrayOf(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null
  const out: string[] = []
  for (const item of value as unknown[]) {
    if (typeof item === 'string') out.push(item)
  }
  return out
}

/** The official `/apps` payload's ids, or null when the body is not that shape. */
function appsOf(data: unknown): string[] | null {
  if (typeof data !== 'object' || data === null) return null
  const { apps } = data as Partial<OpenInAppAppsPayload>
  return stringArrayOf(apps)
}

/** This plugin's own `/info` payload, or null when the body is not an object. */
function infoOf(data: unknown): AppState['info'] {
  if (typeof data !== 'object' || data === null) return null
  const available = (data as { available?: unknown }).available
  return { available: available === undefined ? undefined : stringArrayOf(available) }
}

/** One application's real bundle icon with a generic-glyph fallback (official route). */
function AppIcon(props: { id: string, size: number }) {
  const [failed, setFailed] = React.useState(false)
  if (failed) {
    return (
      <svg width={props.size} height={props.size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} aria-hidden>
        <rect x={3} y={3} width={18} height={18} rx={5} />
      </svg>
    )
  }
  return (
    <img
      src={OPEN_IN_APP_ICON_PREFIX_ROUTE + '/' + props.id}
      width={props.size}
      height={props.size}
      alt=""
      aria-hidden
      draggable={false}
      onError={() => { setFailed(true) }}
    />
  )
}

/** Locale-bound translator handed down to the menu. */
type Translator = (key: LocaleKey, params?: Record<string, string>) => string

/**
 * Build the menu entries as the official `Menu` item union, so the compiler
 * checks the shape this plugin hands to `<Menu items>`. A link that named a
 * line gets a non-selectable heading naming it, so the target is visible before
 * anything launches.
 */
function buildItems(state: AppState, t: Translator, line: number | null): MenuEntry[] {
  const items: MenuEntry[] = []
  if (line !== null) items.push({ type: 'label', id: 'flo:line', text: t('atLine', { line: String(line) }) })
  const fileManagers = (state.officialApps ?? [])
    .filter((id): id is FileManagerId => (FILE_MANAGER_IDS as readonly string[]).includes(id))
  // An editor is shown only when BOTH the official probe and this plugin's own
  // resolution verified it: the two resolver copies (the host dsh's and the
  // plugin's pinned one) may differ in version, and this intersection makes the
  // "menu shows it, click 400s" failure impossible. Older hosts without
  // `available` keep the official intersection only.
  let editors: EditorId[] = []
  if (state.info !== null) {
    const matched = (state.officialApps ?? [])
      .filter((id): id is EditorId => (EDITOR_IDS as readonly string[]).includes(id))
    const available = state.info.available
    editors = available === null || available === undefined
      ? matched
      : matched.filter(id => available.includes(id))
  }
  fileManagers.forEach((id) => {
    items.push({ id: 'flo:fm:' + id, icon: <AppIcon id={id} size={16} />, label: t(`app.${id}`) })
  })
  editors.forEach((id) => {
    items.push({ id: 'flo:app:' + id, icon: <AppIcon id={id} size={16} />, label: t(`app.${id}`) })
  })
  if (fileManagers.length > 0 || editors.length > 0) items.push({ type: 'separator', id: 'flo:sep-copies' })
  items.push(
    { id: 'flo:copy-rel', label: t('copyRelativePath') },
    { id: 'flo:copy-abs', label: t('copyAbsolutePath') },
  )
  return items
}

/** One menu selection: dispatch to the route or the clipboard. */
function dispatchSelection(id: string, filePath: string, line: number | null, cwd: string | null, deps: { close(): void }) {
  const absolute = resolveWorkspacePath(cwd, filePath)
  // Every path closes the menu immediately: the detached launches take seconds
  // to settle on the host, and holding the menu open for that round trip reads
  // as "the menu never closes". Failures land in the console instead of an
  // in-menu error row (there is no menu left to host one).
  if (id === 'flo:copy-rel') {
    deps.close()
    void writeClipboard(relativizeToCwd(filePath, cwd))
    return
  }
  if (id === 'flo:copy-abs') {
    deps.close()
    void writeClipboard(absolute)
    return
  }
  if (id.startsWith('flo:fm:')) {
    const manager = id.slice(7)
    deps.close()
    void postJson(OPEN_IN_APP_OPEN_ROUTE, { app: manager, path: dirnameOf(absolute) }).then((result) => {
      if (!result.ok) {
        console.warn('file-link-open: open in %s failed (%s)', manager, result.status, result.data)
      }
    })
    return
  }
  if (id.startsWith('flo:app:')) {
    const app = id.slice(8)
    deps.close()
    // The line rides the launch request only; copying stays a pure path so a
    // pasted path keeps working in a terminal, a script, or another editor.
    void postJson(LAUNCH_ROUTE, {
      app,
      path: absolute,
      ...(line === null ? {} : { line }),
    }).then((result) => {
      if (!result.ok) {
        console.warn('file-link-open: launch %s failed (%s)', app, result.status, result.data)
      }
    })
  }
}

interface ContextState {
  open: boolean
  x: number
  y: number
  path: string | null
  line: number | null
  cwd: string | null
}

export function apply(ctx: ClientContext) {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'file-link-open: dictionaries')
  const t = ctx.locale.bind(NS) as Translator

  /** Shared plugin state; read at render time, refreshed after the initial fetches. */
  const state: AppState = { officialApps: null, info: null }

  /**
   * `cwd` is published by the recorder cell below. The whole object is replaced
   * on every open, and the render closures always read the variable, never a
   * stale copy.
   */
  let contextState: ContextState = { open: false, x: 0, y: 0, path: null, line: null, cwd: null }
  const contextContainer = document.createElement('div')
  contextContainer.setAttribute('data-flo-context', '1')
  // An in-flow body child puts the Menu anchor's ~21px line box under the
  // viewport-height #root shell and scrolls the whole page; fixed + zero size
  // keeps it out of document height while the portaled panel (itself
  // position:fixed) still anchors at the cursor.
  contextContainer.style.position = 'fixed'
  contextContainer.style.top = '0'
  contextContainer.style.left = '0'
  contextContainer.style.width = '0'
  contextContainer.style.height = '0'
  contextContainer.style.overflow = 'hidden'
  document.body.appendChild(contextContainer)
  const contextRoot = ReactDOMClient.createRoot(contextContainer)

  /**
   * The right-click menu over one message file link, anchored at the cursor
   * through Menu's getAnchorRect (portal mode; the viewport clamp keeps the
   * panel on screen).
   */
  function LinkMenu(props: { menu: ContextState, t: Translator }) {
    const menu = props.menu
    const open = menu.open && menu.path !== null
    const items = open
      ? buildItems(state, props.t, menu.line)
      : []
    return (
      <Menu
        open={open}
        autoFocus
        portal
        align="start"
        side="bottom"
        items={items}
        onSelect={(id: string) => {
          if (menu.path === null) return
          dispatchSelection(id, menu.path, menu.line, menu.cwd, {
            close: () => { contextState.open = false; renderContextMenu() },
          })
        }}
        onClose={() => { contextState.open = false; renderContextMenu() }}
        getAnchorRect={() => {
          const rect = { left: menu.x, right: menu.x, top: menu.y, bottom: menu.y }
          return { ...rect, width: 0, height: 0, x: menu.x, y: menu.y, toJSON: () => ({}) }
        }}
        anchor={<span data-flo-context-anchor="1" />}
      />
    )
  }

  /** Publish the current context state into the context-menu root. */
  function renderContextMenu() {
    contextRoot.render(<LinkMenu menu={contextState} t={t} />)
  }

  function openContextMenu(x: number, y: number, link: LinkTarget) {
    contextState = {
      open: true,
      x,
      y,
      path: link.path,
      line: link.line,
      cwd: contextState.cwd,
    }
    renderContextMenu()
  }

  function onContextMenu(event: MouseEvent) {
    const link = classifyContextTarget(event.target)
    if (link === null) return
    event.preventDefault()
    openContextMenu(event.clientX, event.clientY, link)
  }

  document.addEventListener('contextmenu', onContextMenu)

  /**
   * Renders nothing: the cell exists for its standard Session props (sessionId
   * + useSessions — the same seats the official open-in-app button consumes), to
   * publish the viewed session's workspace directory. A subagent aside rendering
   * its own header last would win; aside sessions share the workspace in
   * practice.
   */
  function SessionCwdRecorder(props: { sessionId: string, useSessions: (selector: (sessionState: { byId: Record<string, { cwd?: string }> }) => string | undefined) => string | undefined }) {
    const cwd = props.useSessions((sessionState) => sessionState.byId[props.sessionId]?.cwd)
    React.useEffect(() => {
      contextState.cwd = cwd === undefined || cwd === '' ? null : cwd
      renderContextMenu()
    }, [cwd])
    return null
  }

  // The official session-header utilities seat. ctx.slots.inject runs the
  // callback per declaration lifetime and unwinds the registration when this
  // plugin's fiber unloads — no manual disposer.
  ctx.slots.inject('conversation.session.header.utilities', () =>
    ctx.slots.register({
      name: 'conversation.session.header.utilities',
      id: 'file-link-open',
      order: 100,
      locale: NS,
    }, SessionCwdRecorder))

  void fetchJson(OPEN_IN_APP_APPS_ROUTE).then((result) => {
    const apps = result.ok ? appsOf(result.data) : null
    if (apps === null) return
    state.officialApps = apps
    renderContextMenu()
  })
  void fetchJson(INFO_ROUTE).then((result) => {
    const info = result.ok ? infoOf(result.data) : null
    if (info === null) return
    state.info = info
    renderContextMenu()
  })

  return function dispose() {
    document.removeEventListener('contextmenu', onContextMenu)
    contextRoot.unmount()
    contextContainer.remove()
  }
}

export const inject = ['locale', 'slots']