/**
 * Test double for `@deepseek-ai/dsh-client-ui-primitives`, wired in through the
 * `resolve.alias` entry in `vitest.config.ts`.
 *
 * The published entry is the Web shell's static library: importing it eagerly
 * evaluates katex, shiki, micromark, mdast, anser and clsx — a dependency tree
 * this standalone package deliberately does not install. Production never loads
 * this file: the browser half obtains the REAL module from the shell's
 * module-table seed.
 *
 * Only the three members the page imports are reproduced, and only their
 * contract: a native checkbox forwarding `checked`/`disabled` and reporting the
 * next state, a native button forwarding `disabled`/`onClick`, and a tag carrying
 * its tone. Styling is the real components' business and is not asserted here.
 */
import { forwardRef, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode } from 'react'

/** Props, mirroring the shipped `Button`. */
export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'ghost' | 'outline' | 'toolbar'
  size?: 'md' | 'sm'
  icon?: ReactNode
}

export function Button({ variant, size, icon, children, ...rest }: ButtonProps): ReactNode {
  void [variant, size, icon]
  return <button type="button" {...rest}>{children}</button>
}

/** Props, mirroring the shipped `Checkbox`: the caller owns the visible label. */
export interface CheckboxProps {
  checked: boolean
  onChange: (checked: boolean) => void
  label: string
  disabled?: boolean | undefined
  title?: string | undefined
  className?: string | undefined
}

export function Checkbox({ checked, onChange, label, disabled, title, className }: CheckboxProps): ReactNode {
  return (
    <label className={className} title={title}>
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled ?? false}
        onChange={event => { onChange(event.target.checked) }}
      />
      <span>{label}</span>
    </label>
  )
}

/** Props, mirroring the shipped `Input`: a native text input forwarding its attributes. */
export const Input = forwardRef<HTMLInputElement, { icon?: ReactNode } & InputHTMLAttributes<HTMLInputElement>>(
  function Input({ icon, className, ...rest }, ref): ReactNode {
    void icon
    return <input ref={ref} className={className} {...rest} />
  },
)

/** Props, mirroring the shipped `Tag`: the tone is the only behaviour it carries. */
export interface TagProps {
  tone?: 'outline' | 'solid' | 'neutral' | 'quiet' | 'success' | 'info' | 'warning' | 'danger'
  className?: string | undefined
  children?: ReactNode
}

export function Tag({ tone, className, children }: TagProps): ReactNode {
  return <span className={className} data-tone={tone ?? 'neutral'}>{children}</span>
}
