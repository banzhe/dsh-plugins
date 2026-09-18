/**
 * Sidebar Session-row DOM facts.
 *
 * A rendered row exposes no session id in the DOM, but every row element
 * carries React's fiber handle, and the owning `SessionNodeItem` fiber holds
 * `props.node` — the presentation node whose `id` is the session id. Reading the
 * id there is exact: it needs no title matching, no locale strings, and
 * duplicate titles cannot confuse it.
 *
 * Two React details are load-bearing. The fiber property name carries a
 * per-page random suffix (`__reactFiber$` + randomKey), so only the prefix is
 * stable. `memoizedProps` / `return` are internals: a React or DSH major
 * upgrade can move them, which degrades to "the gesture does nothing" rather
 * than archiving the wrong Session.
 *
 * A portaled hover card is NOT a DOM descendant of its row, but its fiber chain
 * still returns to the same `SessionNodeItem` (measured: 4 hops), so the card
 * resolves to the same id without re-matching a title.
 */
import type { SessionId } from '@deepseek-ai/dsh-session/types'

/** One React fiber, narrowed to the two internal links this plugin walks. */
interface ReactFiberLike {
  memoizedProps?: unknown
  return?: ReactFiberLike | null
}

/**
 * The sidebar row presentation-node fields this plugin reads.
 *
 * `title` and `updatedAt` are read only as shape discriminators — they separate
 * a Session row from the tree's other row kinds — so they are not carried here.
 */
interface SidebarRowNode {
  id: SessionId
  blank: boolean
}

/** A sidebar Session row together with the id its fiber owns. */
export interface SidebarSessionRow {
  row: HTMLElement
  sessionId: SessionId
}

/**
 * How far up the fiber return chain the owning row component may sit. Measured
 * at 3 for a row and 4 for its portaled hover card; the rest is headroom.
 */
const FIBER_HOPS = 25

/** Walk off a text node onto its element parent (`relatedTarget` can be Text). */
function asElement(target: EventTarget | null): Element | null {
  if (target instanceof Element) return target
  if (target instanceof Text) return target.parentElement
  return null
}

/** React's fiber handle on one DOM element, or undefined outside a React tree. */
function fiberOf(element: Element): ReactFiberLike | undefined {
  for (const key of Object.keys(element)) {
    if (!key.startsWith('__reactFiber$')) continue
    const value: unknown = Reflect.get(element, key)
    return typeof value === 'object' && value !== null ? value as ReactFiberLike : undefined
  }
  return undefined
}

/**
 * Admit a raw row-node id as a `SessionId`. The brand is compile-time only
 * (`@deepseek-ai/dsh-brand`'s `brandString` returns its argument unchanged), so
 * this is a pure type-boundary cast and the browser bundle stays free of any
 * runtime import from the Session package. The `unknown` bridge is required
 * because the brand's key is a unique symbol, which blocks a direct assertion.
 */
function asSessionId(value: string): SessionId {
  return value as unknown as SessionId
}

/**
 * Read one candidate `props.node` as a sidebar row node. `title` and
 * `updatedAt` are checked as shape discriminators — a workspace header row
 * carries `group`, a search hit carries `result` and has no `updatedAt` — so
 * neither is mistaken for a Session row.
 */
function rowNodeOf(value: unknown): SidebarRowNode | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const id = Reflect.get(value, 'id')
  if (typeof id !== 'string' || id === '') return undefined
  if (typeof Reflect.get(value, 'title') !== 'string') return undefined
  if (typeof Reflect.get(value, 'updatedAt') !== 'number') return undefined
  return { id: asSessionId(id), blank: Reflect.get(value, 'blank') === true }
}

/**
 * Session id owned by the fiber above one element, or undefined when that fiber
 * chain carries no Session row node.
 *
 * The blank provisional New Session row IS a `SessionNodeItem` with a real id,
 * but DSH gives it no `⋯` menu and it cannot be archived, so it is rejected
 * here to keep every caller free of that special case.
 * @param element - a row element, or an element inside a row's portaled hover card.
 * @returns the session id, or undefined for a non-Session row or a blank row.
 */
export function sessionIdAt(element: Element): SessionId | undefined {
  let fiber = fiberOf(element)
  for (let hop = 0; fiber !== undefined && hop < FIBER_HOPS; hop += 1) {
    const props = fiber.memoizedProps
    if (typeof props === 'object' && props !== null) {
      const node = rowNodeOf(Reflect.get(props, 'node'))
      if (node !== undefined) return node.blank ? undefined : node.id
    }
    fiber = fiber.return ?? undefined
  }
  return undefined
}

/** Session id reached from any event target, including a portaled hover card. */
export function sessionIdFromNode(target: EventTarget | null): SessionId | undefined {
  const el = asElement(target)
  return el === null ? undefined : sessionIdAt(el)
}

/**
 * Closest Session tree row that resolves to an archivable session.
 * Workspace header rows, search hits, and the blank New Session row yield null.
 */
export function sessionRowFrom(target: EventTarget | null): SidebarSessionRow | null {
  const el = asElement(target)
  if (el === null) return null
  const row = el.closest('[role="treeitem"]')
  if (!(row instanceof HTMLElement)) return null
  const sessionId = sessionIdAt(row)
  return sessionId === undefined ? null : { row, sessionId }
}

/**
 * The live Session row element for one session id, or null when that row is not
 * currently rendered. A portaled hover card is not a DOM descendant of its row,
 * so re-binding the row from the id is the only way back to it.
 */
export function sessionRowById(sessionId: SessionId): HTMLElement | null {
  for (const node of document.querySelectorAll('[role="treeitem"]')) {
    if (!(node instanceof HTMLElement)) continue
    if (sessionIdAt(node) === sessionId) return node
  }
  return null
}

/**
 * True when the event target is an editable control other than the composer.
 * Search, rename, and settings inputs keep the letter A.
 */
export function isForeignEditable(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  if (target.closest('[data-composer-input]') !== null) return false
  if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) {
    return true
  }
  if (target.isContentEditable) return true
  return target.closest('[contenteditable="true"]') !== null
}
