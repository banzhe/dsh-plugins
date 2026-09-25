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
 * This reproduces only the control contract the plugin's call sites depend on;
 * styling, the portal, and the fade timing are the real components' business
 * and are deliberately not asserted anywhere in this suite.
 */
import type { ReactNode } from 'react'

export interface MenuItemButtonProps {
  children?: ReactNode
  icon?: ReactNode
  disabled?: boolean
  danger?: boolean
  separatorBefore?: boolean
  onSelect: () => void
}

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

export interface IconCopyProps {
  size?: number
  className?: string
}

export function IconCopyOutlineRegular(props?: IconCopyProps): ReactNode {
  void props
  return <svg data-icon="copy" />
}

export interface ToastProps {
  text: string
  onDone: () => void
}

/**
 * The real primitive fires `onDone` once the fade completes, and the owner
 * unmounts the banner there; this double exposes that callback as a button so a
 * spec can drive the completion.
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
 * The real helper never throws and reports whether the host accepted the write.
 * It answers success so an un-stubbed call site reads as a working clipboard;
 * specs replace the outcome they need with `vi.spyOn`.
 */
export async function writeClipboard(text: string): Promise<boolean> {
  void text
  return true
}
