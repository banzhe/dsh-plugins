/**
 * Finding the transcript row of a turn, without touching the chat renderer.
 *
 * The only marker this Bundle relies on is ui-chat's own `data-chat-turn`: a
 * row's other keys embed a length prefix plus `turn:step`, so their digits never
 * identify a message and nothing here reads them. A located row is therefore
 * reported as its turn, never as the message itself.
 *
 * Nothing here writes to the conversation's components or its classes: the row
 * gets one attribute this Bundle styles from its own stylesheet, and removing the
 * attribute undoes the whole effect.
 *
 * @module @banzhe/dsh-session-topic-map/src/client/anchor
 */

/** The turn marker ui-chat puts on every rendered conversation row. */
export const TURN_ATTRIBUTE = 'data-chat-turn'

/** The attribute this Bundle adds to the row it focused; the stylesheet keys off it. */
export const FOCUS_ATTRIBUTE = 'data-session-topic-map-focus'

/**
 * Find the rendered rows of one turn.
 * @param root - the document or an element to search within.
 * @param turn - the turn the node stands for.
 * @returns the rendered rows, in document order.
 */
export function findTurnRows(root: ParentNode, turn: number): HTMLElement[] {
  const rows: HTMLElement[] = []
  for (const element of root.querySelectorAll(`[${TURN_ATTRIBUTE}="${turn}"]`)) {
    if (element instanceof HTMLElement) rows.push(element)
  }
  return rows
}

/**
 * Remove this Bundle's outline from a row.
 * @param element - the row that was outlined, or `null`.
 */
export function clearFocus(element: HTMLElement | null): void {
  element?.removeAttribute(FOCUS_ATTRIBUTE)
}

/**
 * Focus one turn: clear the previous outline, outline the turn's last row, and
 * scroll it into view.
 * @param root - the document or an element to search within.
 * @param turn - the turn the node stands for.
 * @param previous - the row this panel outlined before, if any.
 * @returns the outlined row, or `null` when that turn is not rendered.
 */
export function focusTurn(root: ParentNode, turn: number, previous: HTMLElement | null): HTMLElement | null {
  clearFocus(previous)
  const rows = findTurnRows(root, turn)
  const element = rows[rows.length - 1]
  if (element === undefined) return null
  element.setAttribute(FOCUS_ATTRIBUTE, '')
  if (typeof element.scrollIntoView === 'function') element.scrollIntoView({ block: 'center', behavior: 'smooth' })
  return element
}
