/**
 * Test double for `@deepseek-ai/dsh-client-ui-primitives`, wired in through the
 * `resolve.alias` entry in `vitest.config.ts`.
 *
 * The published entry is the Web shell's static library: importing it eagerly
 * evaluates katex, shiki, micromark, mdast, anser and clsx — a dependency tree
 * this standalone package deliberately does not install. Production never loads
 * this file: the browser half obtains the REAL module from the shell's
 * module-table seed (`@deepseek-ai/dsh-client-ui-primitives` is a baseline
 * platform word), which is exactly why the package needs no `dsh.client.external`.
 *
 * Only the control contract this plugin's row depends on is reproduced: a native
 * button forwarding `disabled`, `onClick` and `children`. Styling is the real
 * component's business and is deliberately not asserted here.
 */
import type { ButtonHTMLAttributes, ReactNode } from 'react'

/** Props of the real primitive that this plugin's call site uses. */
export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'ghost' | 'outline' | 'toolbar'
  size?: 'md' | 'sm'
  icon?: ReactNode
}

/**
 * Render a plain button carrying the same action surface as the real primitive.
 * @param props - the call site's props; styling-only members are ignored.
 * @returns the button element.
 */
export function Button({ variant, size, icon, children, ...rest }: ButtonProps): ReactNode {
  // Styling-only props: accepted so the call site mirrors production, ignored by the double.
  void [variant, size, icon]
  return (
    <button type="button" {...rest}>
      {children}
    </button>
  )
}
