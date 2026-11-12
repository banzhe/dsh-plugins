/**
 * @banzhe/dsh-file-link-open — Client half. Contributes the "open in…" rows for
 * a file into the official `file` context menu: open the file in a detected
 * editor, at the named line, reusing the editor's window, or copy its
 * workspace-relative path.
 *
 * The menu itself belongs to `@deepseek-ai/dsh-client-ui-context-menu`: this
 * plugin registers a contribution against the `file` target and builds rows,
 * so it inherits the official popup's positioning, keyboard walk, and the
 * shared failure feedback. The target arrives with the destination already
 * parsed (`sessionId`, `path`, `line`) because the official renderer binds it
 * that way, and the Session's workspace root is read from `ctx.sessions` at
 * resolve time — two panes of one window may show two Sessions.
 *
 * The official `open-in-app.file` contribution (order 100) owns "reveal in file
 * manager" and "copy path" for this same target; this plugin deliberately
 * contributes neither.
 *
 * Implementation derived from https://github.com/cholf5/dsh-plugin-file-actions
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: pulls the SlotRegistry service merge (ctx.slots).
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
// Type-only: the 'contextMenu.icon' SlotMap key and a component's props share.
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { useState, type ReactNode } from 'react'
import { IconRightUpOutlineRegular, writeClipboard } from '@deepseek-ai/dsh-client-ui-primitives'
import {
  OPEN_IN_APP_APPS_ROUTE, OPEN_IN_APP_ICON_PREFIX_ROUTE,
  type OpenInAppAppsPayload,
} from '@deepseek-ai/dsh-host-open-in-app/shared'
import {
  APP_ICON_KEY, buildFileActions,
  type AppProbes, type ContextMenuIcon, type FileMenuAction, type FileTarget,
} from './client/actions.ts'
import { en, NS, zh, type LocaleKey, type Translator } from './client/locales.ts'
import { INFO_ROUTE, LAUNCH_ROUTE } from './routes.ts'

export type { FileTarget }

/**
 * The `contextMenus` service, restated for this package's own type check.
 *
 * `@deepseek-ai/dsh-client-ui-context-menu` owns this service; the workspace
 * catalog carries no entry for that package, so this Bundle restates the one
 * member it uses instead of depending on it. These declarations merge with the
 * owner's if the dependency is ever added. What is mirrored, from
 * `@deepseek-ai/dsh-client-ui-context-menu` `src/client/types.ts` as shipped in
 * DSH `0.2.2-rc.2`: `MenuAction` carries `id`, `label`, `icon`,
 * `disabled`, `separatorBefore`, `failureLabel` and `run`; `MenuContribution`
 * carries `id`, `target`, `order` and `resolve(target, signal)`. The owner
 * package is not a workspace dependency, so no type-only `satisfies` can pin
 * that mirror at compile time; `tests/context-menu.spec.tsx` pins the parts
 * that would duplicate the official rows.
 */
export interface FileContextMenus {
  register(contribution: {
    readonly id: string
    readonly target: 'file'
    readonly order: number
    resolve: (target: FileTarget, signal: AbortSignal) => readonly FileMenuAction[] | Promise<readonly FileMenuAction[]>
  }): () => void
}

/**
 * The `sessions` service, restated for this package's own type check.
 *
 * `@deepseek-ai/dsh-api-session-controller` owns this service and is not a
 * workspace dependency of this Bundle; the one member used here is the Host
 * catalog snapshot, whose `byId[sessionId].cwd` is the Session's workspace
 * root. Mirrored from that package's `src/client/contract/sessions.ts`
 * (`list: ObservableSnapshot<SessionListState>`) as shipped in DSH `0.2.2-rc.2`.
 */
export interface SessionsService {
  readonly list: {
    getSnapshot(): { readonly byId: Readonly<Record<string, { readonly cwd?: string } | undefined>> }
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** The official menu registry this plugin contributes rows to. */
    contextMenus: FileContextMenus
    /** The client Session catalog; read for the clicked Session's workspace root. */
    sessions: SessionsService
  }
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    'file-link-open': LocaleKey
  }

  interface SlotMap {
    /** Keyed glyph or image selected by a menu row's icon key (owner: ui-context-menu). */
    'contextMenu.icon': { kind: 'keyed'; scope: 'root'; inline: true; owner: { icon: ContextMenuIcon } }
  }
}

/** How long a file menu waits for the first probe answer before opening with the rows it already has. */
const FIRST_ANSWER_WAIT_MS = 300

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

function stringArrayOf(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null
  const out: string[] = []
  for (const item of value as unknown[]) {
    if (typeof item === 'string') out.push(item)
  }
  return out
}

/** The official `/apps` payload's ids. */
function appsOf(data: unknown): string[] | null {
  if (typeof data !== 'object' || data === null) return null
  const { apps } = data as Partial<OpenInAppAppsPayload>
  return stringArrayOf(apps)
}

/** This plugin's own `/info` payload. */
function infoOf(data: unknown): AppProbes['info'] {
  if (typeof data !== 'object' || data === null) return null
  const available = (data as { available?: unknown }).available
  return { available: available === undefined ? undefined : stringArrayOf(available) }
}

/**
 * Settle when `pending` settles, after `ms`, or on abort — whichever comes
 * first, with its timer never outliving the wait. The official file menu holds
 * a first answer for the same reason: the shared popup opens once its
 * contributions have prepared, so an unanswered probe must not hold it open.
 */
function settleWithin(pending: Promise<void>, ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((settle) => {
    const done = (): void => { clearTimeout(timer); signal.removeEventListener('abort', done); settle() }
    const timer = setTimeout(done, ms)
    signal.addEventListener('abort', done, { once: true })
    void pending.then(done)
  })
}

/**
 * One application's icon for a menu row, falling back to the shipped
 * native-open glyph so a missing or broken image never leaves a blank cell.
 * @param props.icon - keyed icon metadata the row carried (its `src` names the image).
 * @returns the application image, or the fallback glyph.
 */
function AppMenuIcon({ icon }: Pick<PropsRuntime<'contextMenu.icon'>, 'icon'>): ReactNode {
  const [failed, setFailed] = useState(false)
  if (icon.src === undefined || failed) return <IconRightUpOutlineRegular size={16} />
  return (
    <img
      src={icon.src}
      width={16}
      height={16}
      alt=""
      aria-hidden
      draggable={false}
      onError={() => { setFailed(true) }}
    />
  )
}

export function apply(ctx: ClientContext) {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'file-link-open: dictionaries')
  const t = ctx.locale.bind(NS) as Translator

  const probes: { officialApps: readonly string[] | null, info: AppProbes['info'] } = {
    officialApps: null,
    info: null,
  }
  /**
   * One probe round, both routes at once; concurrent openings share it. A round
   * that could not answer either route clears the memo, so the next right-click
   * asks again instead of offering the copy row alone for the rest of the
   * page's life. A dismissed opening clears it too, because the answer it was
   * waiting for is no longer being shown to anyone.
   */
  let probing: Promise<void> | undefined
  const probeOnce = async (): Promise<void> => {
    const [apps, info] = await Promise.all([
      fetchJson(OPEN_IN_APP_APPS_ROUTE, { headers: { accept: 'application/json' } }),
      fetchJson(INFO_ROUTE, { headers: { accept: 'application/json' } }),
    ])
    probes.officialApps = apps.ok ? appsOf(apps.data) : null
    probes.info = info.ok ? infoOf(info.data) : null
    if (!apps.ok || !info.ok) probing = undefined
  }
  const probe = (): Promise<void> => (probing ??= probeOnce())
  // Warm both probes at activation, so the first right-click answers from the
  // memoized read instead of waiting on them.
  void probe()

  /** The clicked Session's workspace root, read at resolve time rather than published by a header cell. */
  const cwdOf = (sessionId: string): string | undefined => ctx.sessions.list.getSnapshot().byId[sessionId]?.cwd

  const launch = async (appId: string, absolutePath: string, line: number | null): Promise<void> => {
    // The line rides the launch request only; copying stays a pure path so a
    // pasted path keeps working in a terminal, a script, or another editor.
    const result = await postJson(LAUNCH_ROUTE, {
      app: appId,
      path: absolutePath,
      ...(line === null ? {} : { line }),
    })
    if (result.ok) return
    console.warn('file-link-open: launch %s failed (%s)', appId, result.status, result.data)
    throw new Error(`file-link-open: launch ${appId} failed with HTTP ${String(result.status)}`)
  }

  const copy = async (text: string): Promise<void> => {
    if (await writeClipboard(text)) return
    // The helper never throws, so a refused write is the only failure there is.
    throw new Error('file-link-open: the clipboard refused the write')
  }

  ctx.slots.inject('contextMenu.icon', () => ctx.slots.register({
    name: 'contextMenu.icon',
    key: APP_ICON_KEY,
  }, AppMenuIcon))

  ctx.effect(() => ctx.contextMenus.register({
    id: 'file-link-open',
    target: 'file',
    order: 200,
    resolve: async (target, signal) => {
      // A cold probe is not allowed to hold the shared popup open; after the
      // warm-up above this settles in a microtask.
      await settleWithin(probe(), FIRST_ANSWER_WAIT_MS, signal)
      if (signal.aborted) probing = undefined
      signal.throwIfAborted()
      return buildFileActions(probes, target, {
        t,
        cwdOf,
        icon: (appId: string): ContextMenuIcon => ({ key: APP_ICON_KEY, src: `${OPEN_IN_APP_ICON_PREFIX_ROUTE}/${appId}` }),
        launch,
        copy,
      })
    },
  }), 'file-link-open: file context menu')
}

export const inject = ['locale', 'slots', 'contextMenus', 'sessions']
