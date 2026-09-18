/**
 * Hover-archive plugin, browser half: A over a hovered sidebar Session row
 * archives that Session through the Workspace Controller.
 *
 * The session id comes from the row element's React fiber, so the same id is
 * reached from the row and from its portaled hover card. Nothing here reads a
 * title, a locale string, or the Session list's display order.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { ISessions } from '@deepseek-ai/dsh-api-session-controller/client'
import type { IWorkspaces } from '@deepseek-ai/dsh-api-workspace-controller/client'
import {
  isForeignEditable, sessionIdFromNode, sessionRowById, sessionRowFrom,
  type SidebarSessionRow,
} from './dom.ts'
import { isArchivableSession } from './match.ts'

/** Wait on the Session list and Workspace archive command. */
export const inject = ['sessions', 'workspaces']

/** The row currently under the pointer, and the Session it belongs to. */
type HoveredSession = SidebarSessionRow

/** True when this keydown is the unchorded physical A key, first press only. */
function isArchiveKey(event: KeyboardEvent): boolean {
  if (event.repeat || event.isComposing) return false
  if (event.ctrlKey || event.altKey || event.metaKey || event.shiftKey) return false
  return event.code === 'KeyA'
}

/**
 * True when `node` is still on the hovered row or that row's portaled hover
 * card. Both resolve to the same session id, so the card needs no title
 * round-trip and a duplicate title cannot steal the binding.
 *
 * Cheap-first on purpose: `contains` answers the dominant case (the pointer
 * moving within the row it is already on) with no fiber walk at all, and only a
 * target that left the row pays for a resolution.
 */
function staysOnHoverTarget(node: EventTarget | null, hovered: HoveredSession): boolean {
  if (node instanceof Node && hovered.row.contains(node)) return true
  return sessionIdFromNode(node) === hovered.sessionId
}

/**
 * Bind document listeners that archive the hovered Session on A.
 * @param ctx - client root context, with sessions and workspaces already injected.
 */
export function apply(ctx: Context): void {
  const sessions = ctx.get('sessions') as ISessions
  const workspaces = ctx.get('workspaces') as IWorkspaces

  ctx.effect(() => {
    let hovered: HoveredSession | null = null

    const onPointerOver = (event: PointerEvent): void => {
      if (hovered !== null && hovered.row.isConnected && staysOnHoverTarget(event.target, hovered)) return
      const hit = sessionRowFrom(event.target)
      if (hit !== null) {
        hovered = hit
        return
      }
      const cardSessionId = sessionIdFromNode(event.target)
      if (cardSessionId !== undefined) {
        const cardRow = sessionRowById(cardSessionId)
        hovered = cardRow === null ? null : { row: cardRow, sessionId: cardSessionId }
        return
      }
      hovered = null
    }

    const onPointerOut = (event: PointerEvent): void => {
      if (hovered === null) return
      if (staysOnHoverTarget(event.relatedTarget, hovered)) return
      hovered = null
    }

    const onKeyDown = (event: KeyboardEvent): void => {
      if (!isArchiveKey(event)) return
      if (isForeignEditable(event.target)) return
      if (hovered === null || !hovered.row.isConnected) {
        hovered = null
        return
      }
      if (!isArchivableSession(
        hovered.sessionId,
        sessions.list.getSnapshot(),
        workspaces.list.getSnapshot().archivedSessionIds,
      )) return
      // Capture + stopImmediate: steal A from the composer keymap before Lexical sees it.
      event.preventDefault()
      event.stopImmediatePropagation()
      void workspaces.archiveSession(hovered.sessionId).catch((reason: unknown) => {
        console.warn('session archive rejected:', reason)
      })
    }

    const pointerOpts = { capture: true, passive: true } as const
    document.addEventListener('pointerover', onPointerOver, pointerOpts)
    document.addEventListener('pointerout', onPointerOut, pointerOpts)
    document.addEventListener('keydown', onKeyDown, true)
    return () => {
      document.removeEventListener('pointerover', onPointerOver, pointerOpts)
      document.removeEventListener('pointerout', onPointerOut, pointerOpts)
      document.removeEventListener('keydown', onKeyDown, true)
      hovered = null
    }
  }, 'hover-archive: document listeners')
}
