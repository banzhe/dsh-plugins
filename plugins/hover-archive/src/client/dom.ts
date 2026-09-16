/**
 * Sidebar Session-row and hover-card DOM facts. Session rows expose no
 * session id; the ellipsis aria-label is the only stable title on the row.
 *
 * Locale strings are copied from DSH:
 * - ellipsis: `actions.session.aria` in ui-workspace locales
 *   (`会话“{name}”的操作` / `Session actions for {name}`)
 * - hover card: HoverCard `aria-label` is `${copyLabel}: ${copyText}`
 *   (`复制` / `Copy` plus the row title)
 * - composer: `[data-composer-input]` on ComposerContentEditable
 * Rewording those strings in DSH silently disables this gesture.
 */

const SESSION_MENU_ZH = /^会话[“"](.+)[”"]的操作$/
const SESSION_MENU_EN = /^Session actions for (.+)$/
const CARD_ZH = /^复制: (.+)$/
const CARD_EN = /^Copy: (.+)$/
const SESSION_MENU_BUTTON = 'button[aria-label]'

/** Walk off a text node onto its element parent (`relatedTarget` can be Text). */
function asElement(target: EventTarget | null): Element | null {
  if (target instanceof Element) return target
  if (target instanceof Text) return target.parentElement
  return null
}

/** Title encoded in a Session-row ellipsis aria-label, when it matches. */
function titleFromSessionMenuAria(label: string | null): string | undefined {
  if (label === null) return undefined
  return SESSION_MENU_ZH.exec(label)?.[1] ?? SESSION_MENU_EN.exec(label)?.[1]
}

/** Display title of a Session row, taken from its ellipsis aria-label. */
export function titleFromSessionRow(row: HTMLElement): string | undefined {
  for (const button of row.querySelectorAll(SESSION_MENU_BUTTON)) {
    if (!(button instanceof HTMLButtonElement)) continue
    const title = titleFromSessionMenuAria(button.getAttribute('aria-label'))
    if (title !== undefined) return title
  }
  return undefined
}

/**
 * Closest Session tree row that owns a Session actions menu, plus the title
 * already parsed from that menu. Workspace rows, blank New Session rows, and
 * search hits have none.
 */
export function sessionRowFrom(target: EventTarget | null): { row: HTMLElement; title: string } | null {
  const el = asElement(target)
  if (el === null) return null
  const row = el.closest('[role="treeitem"]')
  if (!(row instanceof HTMLElement)) return null
  const title = titleFromSessionRow(row)
  return title === undefined ? null : { row, title }
}

/**
 * The unique Session row whose ellipsis title matches, or null when none or
 * more than one row shares that title. Used to re-bind a portaled hover card
 * after the pointer crosses the gap off the row.
 */
export function sessionRowByTitle(title: string): HTMLElement | null {
  let found: HTMLElement | null = null
  for (const node of document.querySelectorAll('[role="treeitem"]')) {
    if (!(node instanceof HTMLElement)) continue
    if (titleFromSessionRow(node) !== title) continue
    if (found !== null) return null
    found = node
  }
  return found
}

/**
 * Title copied onto a portaled hover card (`Copy:` / `复制:`).
 * Workspace cards use a path; callers must compare against the hovered row.
 */
export function hoverCardTitle(target: EventTarget | null): string | undefined {
  const el = asElement(target)
  if (el === null) return undefined
  const card = el.closest('[role="button"][aria-label]')
  if (card === null) return undefined
  const label = card.getAttribute('aria-label')
  if (label === null) return undefined
  return CARD_ZH.exec(label)?.[1] ?? CARD_EN.exec(label)?.[1]
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
