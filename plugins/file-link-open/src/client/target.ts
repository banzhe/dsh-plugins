/**
 * @banzhe/dsh-file-link-open — The right-click target inside the message flow.
 *
 * The official markdown renders every file mention and every markdown file link
 * as a `button` carrying the decoded path in `title`. A markdown file link may
 * also name a GitHub-style line fragment (`src/a.ts#L24`, `#L24-L30`), but the
 * official renderer consumes that line inside its own component: it passes
 * `{ line }` to the `openFile` delegate and never writes it to an attribute.
 *
 * The line is therefore read from the button's React fiber, which is the same
 * trade `docs/adr/0004-session-id-from-react-fiber.md` records: React internals
 * (`__reactFiber$` plus a per-page random suffix, `memoizedProps`, `return`)
 * instead of a DOM contract. A React or DSH major that moves them degrades to
 * "the editor opens at the top of the file" rather than to a wrong launch, and
 * `tests/link-target.spec.tsx` pins the walk so that failure surfaces as a red
 * test.
 *
 * The walk is exact rather than heuristic: the fiber it accepts must carry a
 * `file` object whose `path` equals the button's own `title`, so an unrelated
 * ancestor that happens to have a prop named `file` is rejected.
 */

/** How many `return` hops from the button to accept a `file` prop. */
const MAX_LINE_HOPS = 6

/** One file link under the cursor: the button's path plus its optional line. */
export interface LinkTarget {
  /** Decoded path exactly as the official renderer put it in `title`. */
  readonly path: string
  /** 1-based line the destination named, or null when it named none. */
  readonly line: number | null
}

/**
 * The message file links: the official markdown renders every file mention and
 * every markdown file link as a button carrying the path in its `title`
 * (shared hashed fileMention class; the input area's reference chips share the
 * class but mark themselves with `data-ref-chip`, so they are excluded).
 */
const FILE_LINK_SELECTOR = 'button[class*="fileMention"][title]:not([data-ref-chip])'

/** React's fiber handle on a host element, under either of its two key spellings. */
function fiberHandleOf(element: Element): unknown {
  const key = Object.getOwnPropertyNames(element)
    .find(name => name.startsWith('__reactFiber$') || name.startsWith('__reactInternalInstance$'))
  return key === undefined ? undefined : (element as unknown as Record<string, unknown>)[key]
}

/** The `file` prop one fiber carries, when it is a link destination object. */
function filePropOf(fiber: Record<string, unknown>): { path: string, line?: unknown } | undefined {
  const props = fiber.memoizedProps
  if (typeof props !== 'object' || props === null) return undefined
  const file = (props as Record<string, unknown>).file
  if (typeof file !== 'object' || file === null) return undefined
  const { path } = file as Record<string, unknown>
  return typeof path === 'string' ? { path, line: (file as Record<string, unknown>).line } : undefined
}

/**
 * The line a file-link button opens at, read from its React fiber.
 * @param button - The `title`-carrying file-link button.
 * @param path - The button's own `title`, which the accepted fiber must match.
 * @returns The 1-based line, or null when the link named none or the fiber walk
 *   found no matching component (a React/DSH change, or a mention-shaped file
 *   button that never had one).
 */
export function lineOfFileLink(button: Element, path: string): number | null {
  let fiber = fiberHandleOf(button) as Record<string, unknown> | undefined
  for (let hops = 0; fiber !== undefined && fiber !== null && hops < MAX_LINE_HOPS; hops += 1) {
    const file = filePropOf(fiber)
    // The nearest matching fiber wins. Requiring the path to equal the button's
    // own `title` is what keeps an unrelated ancestor's `file` prop out.
    if (file !== undefined && file.path === path) {
      const { line } = file
      return typeof line === 'number' && Number.isSafeInteger(line) && line >= 1 ? line : null
    }
    const parent = fiber.return
    fiber = typeof parent === 'object' && parent !== null ? parent as Record<string, unknown> : undefined
  }
  return null
}

/**
 * One right-click target inside the message flow: a file link keeps this
 * menu; anything else is out of scope and the native menu stays.
 * @param target - The event target.
 * @returns The link's path and optional line, or null when the target names no
 *   message file link.
 */
export function classifyContextTarget(target: EventTarget | null): LinkTarget | null {
  if (target === null || typeof (target as Element).closest !== 'function') return null
  const fileButton = (target as Element).closest(FILE_LINK_SELECTOR)
  if (fileButton === null) return null
  const filePath = fileButton.getAttribute('title')
  if (filePath === null || filePath === '') return null
  return { path: filePath, line: lineOfFileLink(fileButton, filePath) }
}
