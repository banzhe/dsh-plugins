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

type IconProps = { readonly size?: number }

function icon(name: string) {
  return function Icon({ size }: IconProps): ReactNode {
    return <span data-testid={name} data-size={size ?? undefined} />
  }
}

export const IconChevronDownOutlineRegular = icon('chevron-down')
export const IconChevronRightOutlineRegular = icon('chevron-right')
export const IconPinOutlineRegular = icon('pin')
export const IconPinFillRegular = icon('pin-filled')
