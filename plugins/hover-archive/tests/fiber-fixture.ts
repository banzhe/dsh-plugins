// @vitest-environment jsdom
/**
 * A real React fiber chain hung on real DOM elements.
 *
 * The plugin reads React internals (`__reactFiber$` + random suffix,
 * `memoizedProps`, `return`), so the fixture reproduces that shape rather than
 * stubbing the plugin's own lookup functions. That is the whole point: the specs
 * verify the CHAIN the plugin depends on, so if the walk stops matching, the
 * suite fails instead of the gesture silently dying in the browser.
 *
 * Faithfulness detail that matters: real React gives EVERY DOM element its own
 * fiber, and a descendant's `return` chain climbs through the component tree. A
 * fixture that only tagged the row element would pass while the browser failed
 * on a deep child, so descendants get fibers too.
 *
 * The measured live values are encoded here: a row reaches its owning
 * `SessionNodeItem` at 3 hops, a portaled hover card at 4.
 */

/** One fiber node in a fixture chain. */
export interface FixtureFiber {
  memoizedProps?: unknown
  return?: FixtureFiber | null
}

/** React's element→fiber key, with a per-page random suffix. */
const FIBER_KEY = `__reactFiber$${Math.random().toString(36).slice(2)}`

/** Attach one fiber to an element under React's private key. */
function setFiber(element: Element, fiber: FixtureFiber): void {
  Reflect.set(element, FIBER_KEY, fiber)
}

/** A `SessionNode`-shaped props payload, as `SessionNodeItem` receives it. */
export function sessionNodeProps(options: {
  id: string
  title?: string
  blank?: boolean
  updatedAt?: unknown
}): { node: Record<string, unknown> } {
  return {
    node: {
      id: options.id,
      title: options.title ?? 'A session',
      blank: options.blank ?? false,
      updatedAt: options.updatedAt ?? 1_700_000_000_000,
    },
  }
}

/** The props a workspace header row carries: `group`, never `node`. */
export function workspaceRowProps(): { group: Record<string, unknown> } {
  return { group: { key: 'ws-1', label: 'Workspace', sessionCount: 0, expanded: true } }
}

/** The props a search-result row carries: `result`, and no `updatedAt`. */
export function searchRowProps(): { result: Record<string, unknown> } {
  return { result: { id: 'session-search', title: 'A hit', workspace: 'ws', running: false, completed: false } }
}

/**
 * Attach a chain to one leaf element, with each ancestor's props supplied in
 * order (hop 0 = the element's own fiber).
 * @param element - element carrying hop 0.
 * @param propsPerHop - props for each fiber, nearest first.
 * @returns the outermost fiber.
 */
export function attachFiberChain(element: Element, propsPerHop: readonly unknown[]): FixtureFiber {
  const fibers: FixtureFiber[] = propsPerHop.map(props => ({ memoizedProps: props, return: null }))
  for (let i = fibers.length - 1; i > 0; i -= 1) fibers[i - 1]!.return = fibers[i]!
  setFiber(element, fibers[0]!)
  return fibers[0]!
}

/**
 * Build one `[role="treeitem"]` Session row: `SessionNodeItem` under a
 * `HoverCard` wrapper, with every descendant element fibered like real React.
 * @param options - the row's session facts.
 * @returns the row element.
 */
export function sessionRow(options: {
  id: string
  title?: string
  blank?: boolean
}): HTMLElement {
  const row = document.createElement('div')
  row.setAttribute('role', 'treeitem')
  const title = document.createElement('span')
  title.textContent = options.title ?? 'A session'
  row.append(title)

  // Ancestors above the row host: SessionNodeItem ← HoverCard ← wrapper.
  const nodeFiber: FixtureFiber = { memoizedProps: sessionNodeProps(options), return: null }
  const cardFiber: FixtureFiber = { memoizedProps: { copyText: 'A session' }, return: nodeFiber }
  const wrapperFiber: FixtureFiber = { memoizedProps: { className: 'row' }, return: cardFiber }
  const rowFiber: FixtureFiber = { memoizedProps: {}, return: wrapperFiber }

  setFiber(row, rowFiber)
  // Real React fibers every descendant; each child's chain climbs to the row's.
  for (const child of row.querySelectorAll('*')) setFiber(child, { memoizedProps: {}, return: rowFiber })
  return row
}

/**
 * Build a row whose fiber chain carries arbitrary props at the owning hop, for
 * the "is this really a Session row?" shape checks.
 * @param props - the props the owning component receives.
 * @returns the row element.
 */
export function shapedRow(props: unknown): HTMLElement {
  const row = document.createElement('div')
  row.setAttribute('role', 'treeitem')
  attachFiberChain(row, [{}, props])
  return row
}

/**
 * Build a portaled hover card: a body-level element whose fiber chain returns to
 * the same `SessionNodeItem`. The measured live chain is
 * `[div, null, span, SC, SessionNodeItem]` — the owner sits 4 hops up, one
 * deeper than a row, because the card renders through its own wrapper and the
 * `HoverCard` component. The fixture reproduces that depth so the specs exercise
 * the real distance instead of a convenient one.
 * @param id - the session the card describes.
 * @returns the card element.
 */
export function hoverCard(id: string): HTMLElement {
  const card = document.createElement('div')
  card.setAttribute('role', 'button')
  attachFiberChain(card, [
    {}, // the card host div
    null, // a fiber with no props, as the measured chain has at hop 1
    { className: 'cardRoot' },
    { className: 'hoverCardWrapper' },
    sessionNodeProps({ id }),
  ])
  return card
}

/** An element with a fiber whose chain is cyclic, to prove the hop budget holds. */
export function cyclicFiberRow(): HTMLElement {
  const row = document.createElement('div')
  row.setAttribute('role', 'treeitem')
  const fiber: FixtureFiber = { memoizedProps: {} }
  fiber.return = fiber
  setFiber(row, fiber)
  return row
}

/** An element carrying a non-object fiber handle, as a corrupted tree would. */
export function corruptFiberRow(): HTMLElement {
  const row = document.createElement('div')
  row.setAttribute('role', 'treeitem')
  Reflect.set(row, '__reactFiber$corrupt', 'not-a-fiber')
  return row
}

/**
 * An element whose fiber key is preceded by an unrelated own key, proving the
 * lookup scans rather than assuming React's key is first.
 * @param id - the session the row belongs to.
 * @returns the row element.
 */
export function rowWithLeadingKey(id: string): HTMLElement {
  const row = document.createElement('div')
  row.setAttribute('role', 'treeitem')
  Reflect.set(row, 'zz-unrelated', 1)
  setFiber(row, { memoizedProps: {}, return: { memoizedProps: sessionNodeProps({ id }), return: null } })
  return row
}
