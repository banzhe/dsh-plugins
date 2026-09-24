/**
 * Test double for `@deepseek-ai/dsh-client-ui-primitives`, wired in through the
 * `resolve.alias` entry in `vitest.config.ts`.
 *
 * The published entry is the Web shell's static library; importing it eagerly
 * evaluates katex/shiki/micromark/… — a dependency tree this standalone package
 * deliberately does not install. Production never loads this file: the browser
 * half obtains the REAL module from the shell's module-table seed
 * (`@deepseek-ai/dsh-client-ui-primitives` is a baseline platform word).
 *
 * Only the control contract this plugin's call sites depend on is reproduced:
 * a menu-item button forwarding `onSelect`/`disabled` (plus the separator and
 * danger decorations the call site may set), a placeholder copy icon with a
 * stable, assertable marker, the transient `Toast` banner reduced to its text
 * plus the completion trigger that unmounts it, and the `writeClipboard`
 * helper. Styling, the portal, and the fade timing are the real components'
 * business and are deliberately not asserted anywhere in this suite.
 */
import type { ReactNode } from 'react'

/** Props of the real primitive that this plugin's call site uses. */
export interface MenuItemButtonProps {
  children?: ReactNode
  icon?: ReactNode
  disabled?: boolean
  danger?: boolean
  separatorBefore?: boolean
  onSelect: () => void
}

/**
 * Render a plain menuitem button carrying the same action surface as the real primitive.
 * @param props - the call site's props; styling-only members are ignored.
 * @returns the wrapper (separator when asked) and the button element.
 */
export function MenuItemButton(props: MenuItemButtonProps): ReactNode {
  const { children, icon, disabled, danger, separatorBefore, onSelect } = props
  // Styling-only prop: accepted so the call site mirrors production, ignored by the double.
  void danger
  return (
    <div>
      {separatorBefore === true && <div role="separator" />}
      <button type="button" role="menuitem" disabled={disabled} onClick={onSelect}>
        {icon}
        {children}
      </button>
    </div>
  )
}

/** Props of the real copy icon that this plugin's call site uses. */
export interface IconCopyProps {
  size?: number
  className?: string
}

/**
 * Render a placeholder copy icon with an assertable marker.
 * @param props - the call site's props; the double ignores them.
 * @returns an empty svg marker.
 */
export function IconCopyOutlineRegular(props?: IconCopyProps): ReactNode {
  void props
  return <svg data-icon="copy" />
}

/** Props of the real `Toast` that this plugin's call site uses. */
export interface ToastProps {
  text: string
  onDone: () => void
}

/**
 * Render a stand-in for the shipped top-center banner: the resolved text and a
 * button that fires `onDone`, which is the only part of its contract the owner
 * acts on (the real primitive calls it once the fade completes, and the owner
 * unmounts the banner there).
 * @param props - the banner copy and the completion callback.
 * @returns the banner with an assertable completion trigger.
 */
export function Toast({ text, onDone }: ToastProps): ReactNode {
  return (
    <div data-toast role="alert">
      {text}
      <button type="button" data-toast-done onClick={onDone} />
    </div>
  )
}

/**
 * Stand-in for the shipped clipboard helper: it never throws and reports
 * whether the host accepted the write. Specs replace the outcome they need —
 * `vi.spyOn(primitives, 'writeClipboard')` — rather than this double growing
 * its own state; it answers success so an un-stubbed call site reads as a
 * working clipboard.
 * @param text - the exact text the call site asked to place on the clipboard.
 * @returns whether the write succeeded.
 */
export async function writeClipboard(text: string): Promise<boolean> {
  void text
  return true
}
