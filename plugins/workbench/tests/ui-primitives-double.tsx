/**
 * Stand-in for the shell's static `ui-primitives` library. The real module pulls
 * the markdown/code-highlighting tree eagerly, which a standalone Bundle does not
 * install; the browser half resolves the real module from the shell's module
 * table, so only these Node specs need the stand-in. Each export keeps the shape
 * the component reads and nothing else.
 */
import type { ComponentPropsWithoutRef, ReactNode } from 'react'

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

/** The shipped button, reduced to a native button carrying the caller's own props. */
type ButtonProps = ComponentPropsWithoutRef<'button'> & {
  readonly icon?: ReactNode
  readonly variant?: string
  readonly size?: string
  readonly block?: boolean
}

export function Button({ children, icon: leadingIcon, ...rest }: ButtonProps): ReactNode {
  return (
    <button {...rest}>
      {leadingIcon}
      {children}
    </button>
  )
}

/** The shipped modal, reduced to the content it shows while open. */
export function Modal({ open, children }: {
  readonly open?: boolean
  readonly title?: ReactNode
  readonly children?: ReactNode
  readonly onClose?: () => void
}): ReactNode {
  return open ? <>{children}</> : null
}

/** One entry of the shipped menu's `items`/`footer` lists. */
export type MenuEntry = {
  readonly id: string
  readonly label: ReactNode
  readonly icon?: ReactNode
  readonly disabled?: boolean
}

/**
 * The shipped menu, reduced to what a spec reads off it: closed draws nothing,
 * open draws a `role="menu"` holding `items`, then `children`, then `footer`.
 * The entry whose id matches `selectedId` reports `aria-current`, which is how
 * the real primitive marks the current entry.
 */
export function Menu({ open, items, footer, children, onSelect, selectedId }: {
  readonly open: boolean
  readonly anchor?: ReactNode
  readonly anchorRef?: unknown
  readonly portal?: boolean
  readonly side?: 'bottom' | 'top' | 'right'
  readonly selectedId?: string
  readonly items?: readonly MenuEntry[]
  readonly footer?: readonly MenuEntry[]
  readonly children?: ReactNode
  readonly onSelect?: (id: string) => void
  readonly onClose: () => void
}): ReactNode {
  if (!open) return null
  const entry = (item: MenuEntry) => (
    <button
      key={item.id}
      type="button"
      role="menuitem"
      disabled={item.disabled}
      aria-current={selectedId === item.id ? 'page' : undefined}
      onClick={() => { if (!item.disabled) onSelect?.(item.id) }}
    >
      {item.icon}
      {item.label}
    </button>
  )
  return (
    <div role="menu">
      {(items ?? []).map(entry)}
      {children}
      {(footer ?? []).map(entry)}
    </div>
  )
}

/** The shipped menu item, reduced to the button it draws and the call it makes. */
export function MenuItemButton({ children, icon: leadingIcon, current, disabled, onSelect }: {
  readonly children?: ReactNode
  readonly icon?: ReactNode
  readonly current?: boolean
  readonly disabled?: boolean
  readonly onSelect?: () => void
}): ReactNode {
  return (
    <button
      type="button"
      role="menuitem"
      disabled={disabled}
      aria-current={current ? 'page' : undefined}
      onClick={() => { if (!disabled) onSelect?.() }}
    >
      {leadingIcon}
      {children}
    </button>
  )
}

export const IconCheckOutlineRegular = icon('check-outline')
export const IconPlusOutlineRegular = icon('plus')