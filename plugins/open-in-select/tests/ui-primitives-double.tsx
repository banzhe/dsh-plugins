/**
 * Stand-in for the shell's static `ui-primitives` table: the four pieces the
 * header control composes, reduced to the props it actually sets so a spec can
 * read the render without the real library's katex/shiki dependency tree.
 *
 * The menu renders its anchor beside the portal it would open, so the control
 * stays queryable while the list is shown.
 */
import * as React from 'react'

/** Props the control sets on a shipped button. */
export interface ButtonProps {
  size?: string
  icon?: React.ReactNode
  disabled?: boolean
  'aria-label'?: string
  'aria-haspopup'?: 'menu' | 'dialog' | boolean
  'aria-expanded'?: boolean
  'aria-disabled'?: boolean
  onClick?: () => void
}

/** One row of the list. */
export interface MenuItemData {
  id: string
  icon?: React.ReactNode
  label: string
}

/** Props the control sets on the shipped menu. */
export interface MenuProps {
  open: boolean
  items: readonly MenuItemData[]
  selectedId?: string
  anchor?: React.ReactNode
  onSelect?: (id: string) => void
  onClose?: () => void
  portal?: boolean
  dense?: boolean
  align?: string
  autoFocus?: boolean
}

/** The shipped split-button halves. */
export function Button(props: ButtonProps): React.ReactElement {
  return (
    <button
      type="button"
      disabled={props.disabled === true}
      data-disabled={props.disabled === true ? 'true' : 'false'}
      aria-label={props['aria-label']}
      aria-haspopup={props['aria-haspopup']}
      aria-expanded={props['aria-expanded']}
      aria-disabled={props['aria-disabled']}
      onClick={props.disabled === true ? undefined : props.onClick}
    >{props.icon}</button>
  )
}

/** The shipped application list. */
export function Menu(props: MenuProps): React.ReactElement {
  return (
    <div>
      {props.anchor}
      {props.open && (
        <div role="menu" data-selected={props.selectedId}>
          {props.items.map(item => (
            <button
              key={item.id}
              type="button"
              role="menuitem"
              data-app={item.id}
              onClick={() => { props.onSelect?.(item.id) }}
            >{item.icon}{item.label}</button>
          ))}
        </div>
      )}
    </div>
  )
}

/** The shipped tooltip, reduced to the label it would show. */
export function Tooltip(props: {
  children: React.ReactNode
  label: string
  portal?: boolean
  side?: string
  delayMs?: number
}): React.ReactElement {
  return <span data-tooltip={props.label}>{props.children}</span>
}

/** The generic open glyph. */
export function IconRightUpOutlineRegular(_props: { size?: number }): React.ReactElement {
  return <span data-test-icon="open" />
}

/** The list chevron. */
export function IconChevronDownOutlineRegular(_props: { size?: number }): React.ReactElement {
  return <span data-test-icon="chevron" />
}
