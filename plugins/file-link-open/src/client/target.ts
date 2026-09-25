/**
 * @banzhe/dsh-file-link-open — The right-click target inside the message flow.
 *
 * The official renderer renders every file mention and markdown file link as a
 * `button` carrying the decoded path in `title`, but it consumes a link's
 * GitHub-style line fragment (`#L24`) inside its own component: the line never
 * reaches an attribute. It is therefore read from the button's React fiber, the
 * same trade `docs/adr/0004-session-id-from-react-fiber.md` records. A React or
 * DSH major that moves these internals degrades to "the editor opens at the top
 * of the file" rather than to a wrong launch, and `tests/link-target.spec.tsx`
 * pins the walk so that failure surfaces as a red test.
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
 * The input area's reference chips share the official fileMention class but mark
 * themselves with `data-ref-chip`, so they are excluded here.
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
 * The line a file-link button opens at, read from its React fiber. Null means
 * the link named none, or the fiber walk found no matching component.
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
 * One right-click target inside the message flow. Null means the target names
 * no message file link, so the native menu stays.
 */
export function classifyContextTarget(target: EventTarget | null): LinkTarget | null {
  if (target === null || typeof (target as Element).closest !== 'function') return null
  const fileButton = (target as Element).closest(FILE_LINK_SELECTOR)
  if (fileButton === null) return null
  const filePath = fileButton.getAttribute('title')
  if (filePath === null || filePath === '') return null
  return { path: filePath, line: lineOfFileLink(fileButton, filePath) }
}
