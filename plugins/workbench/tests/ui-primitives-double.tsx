/**
 * Stand-in for the shell's static `ui-primitives` library. The real module pulls
 * the markdown/code-highlighting tree eagerly, which a standalone Bundle does not
 * install; the browser half resolves the real module from the shell's module
 * table, so only these Node specs need the stand-in. Each export keeps the shape
 * the component reads and nothing else.
 */
import type { ReactNode } from 'react'

/** The shipped state indicator, reduced to the state it is asked to draw. */
export function StateDot({ state, size }: {
  readonly state: 'done' | 'warning' | 'ongoing' | 'error' | 'idle'
  readonly size?: number
}): ReactNode {
  return <span data-testid="state-dot" data-state={state} data-size={size ?? undefined} />
}

/** The shipped tooltip, reduced to the children it wraps. */
export function Tooltip({ children }: { readonly children?: ReactNode }): ReactNode {
  return <>{children}</>
}

/**
 * The shipped hover card, reduced to its anchor: these specs read the row a card
 * belongs to, and drawing its body would put text into the row a test cannot tell
 * apart from the row's own.
 */
export function HoverCard({ anchor }: { readonly anchor?: ReactNode; readonly content?: ReactNode }): ReactNode {
  return <>{anchor}</>
}

/**
 * The shipped hover-card group, reduced to the children it lays out. It is a
 * layout-only wrapper; the card bodies themselves stay the browser's concern.
 */
export function HoverCardGroup({ children }: {
  readonly children?: ReactNode
  readonly className?: string
}): ReactNode {
  return <>{children}</>
}

/** The shipped relative time formatter, reduced to a label the locale seat renders. */
export function relativeTime(): { readonly unit: string; readonly n: number } {
  return { unit: 'now', n: 0 }
}

/** The shipped drag-preview hook, inert: these specs never drag a row. */
export function useRowDragPreview(): Record<string, undefined> {
  return {}
}

type IconProps = { readonly size?: number }

function icon(name: string) {
  return function Icon({ size }: IconProps): ReactNode {
    return <span data-testid={name} data-size={size ?? undefined} />
  }
}

export const IconChevronDownOutlineRegular = icon('chevron-down')
export const IconChevronRightOutlineRegular = icon('chevron-right')
export const IconTriangleRightFillRegular = icon('triangle-right-filled')
export const IconPinOutlineRegular = icon('pin')
export const IconPinFillRegular = icon('pin-filled')
export const IconArchiveOutlineRegular = icon('archive')
export const IconUnarchiveOutlineRegular = icon('unarchive')
export const IconFolderCloseRegular = icon('folder-closed')
export const IconFolderOpenRegular = icon('folder-open')
export const IconNewChatOutlineRegular = icon('new-chat')
