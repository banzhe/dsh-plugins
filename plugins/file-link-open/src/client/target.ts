/**
 * @banzhe/dsh-file-link-open — The right-click target inside the message flow.
 *
 * The official renderer renders every file mention and markdown file link as a
 * `button`, but it consumes a link's GitHub-style line fragment (`#L24`) inside
 * its own component: the line never reaches an attribute. It is therefore read
 * from the button's React fiber, the same trade
 * `docs/adr/0004-session-id-from-react-fiber.md` records. A React or DSH major
 * that moves these internals degrades to "the editor opens at the top of the
 * file" rather than to a wrong launch, and `tests/link-target.spec.tsx` pins the
 * walk so that failure surfaces as a red test.
 *
 * The path comes from the fiber too, not from `title`. DSH 0.1.7-rc.2 made
 * `title` conditional: a glyph-rendered link whose path classifies as an image
 * writes no `title` at all when the inline preview resolves, because the preview
 * already owns the hover affordance. Reading the path from the same fiber prop
 * the line comes from covers both shapes with one rule, and the `file.path`
 * equality check still rejects an unrelated ancestor's `file` prop.
 *
 * The walk is exact rather than heuristic: the fiber it accepts must carry a
 * `file` object whose `path` is a non-empty string.
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
 *
 * `title` is deliberately NOT required: DSH 0.1.7-rc.2 made it conditional. A
 * file link whose path classifies as an image, rendered with glyphs, carries no
 * `title` because the inline preview already owns the hover affordance — the
 * built component writes `title={src === undefined ? file.path : undefined}`.
 * Requiring `[title]` would silently drop those links back to the native menu.
 */
const FILE_LINK_SELECTOR = 'button[class*="fileMention"]:not([data-ref-chip])'

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
 * The name of the component one fiber renders, reading through a `memo`/`forwardRef`
 * wrapper. Undefined for a host element or an anonymous component.
 */
function fiberComponentName(fiber: Record<string, unknown>): string | undefined {
  const type = fiber.type
  if (typeof type === 'function') return (type as { name?: string }).name
  if (typeof type === 'object' && type !== null) {
    const inner = (type as { type?: unknown }).type
    if (typeof inner === 'function') return (inner as { name?: string }).name
  }
  return undefined
}

/**
 * Whether one fiber is the official `MarkdownFileLink` component itself.
 *
 * This is the discriminator the title-less fallback needs. A nearest-`file`-prop
 * rule would be wrong: components that merely hold a `file` prop sit above the
 * message body — `PresentedFileCard` in ui-deliverables carries
 * `{path, description, seq, index}` — and borrowing one would launch the CARD's
 * path. The shipped component keeps its name in the built artifact (`function
 * MarkdownFileLink(`), which `tests/official-renderer-contract.spec.ts` already
 * pins, so the name is a contract rather than an accident.
 */
function isMarkdownFileLink(fiber: Record<string, unknown>): boolean {
  return fiberComponentName(fiber) === 'MarkdownFileLink'
}

/**
 * The line a file-link button opens at, read from its React fiber. Null means
 * the link named none, or the fiber walk found no matching component.
 */
export function lineOfFileLink(button: Element, path: string): number | null {
  let fiber = fiberHandleOf(button) as Record<string, unknown> | null | undefined
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
 * The path of a file-link button, read from `title` when it has one and from the
 * owning `MarkdownFileLink` fiber otherwise.
 *
 * The fallback exists for the image links DSH 0.1.7-rc.2 renders without a
 * `title`. It accepts a `file` prop only from the component named
 * `MarkdownFileLink`, never from whichever ancestor happens to carry one: a
 * nearest-prop rule would launch the enclosing card's path instead of the
 * link's. The walk stays bounded by the same hop limit as the line walk.
 */
export function pathOfFileLink(button: Element): string | null {
  const title = button.getAttribute('title')
  if (title !== null && title !== '') return title
  let fiber = fiberHandleOf(button) as Record<string, unknown> | null | undefined
  for (let hops = 0; fiber !== undefined && fiber !== null && hops < MAX_LINE_HOPS; hops += 1) {
    if (isMarkdownFileLink(fiber)) {
      const file = filePropOf(fiber)
      if (file !== undefined && file.path !== '') return file.path
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
  const filePath = pathOfFileLink(fileButton)
  if (filePath === null) return null
  return { path: filePath, line: lineOfFileLink(fileButton, filePath) }
}
