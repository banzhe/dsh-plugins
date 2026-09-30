/**
 * Test double for `@deepseek-ai/dsh-client-ui-primitives`, wired in through the
 * `resolve.alias` entry in `vitest.config.ts`.
 *
 * The published entry is the Web shell's static library: importing it eagerly
 * evaluates katex, shiki, micromark, mdast, anser and clsx — a dependency tree
 * this standalone package deliberately does not install. Production never loads
 * this file: the browser half obtains the REAL module from the shell's
 * module-table seed, which is exactly why the package needs no
 * `dsh.client.external`.
 *
 * Only the three members this plugin's entry imports are reproduced, and only
 * their contract: `StateDot` carries the state it was given on a
 * `data-test-state-dot` attribute, and the icons are inert current-color marks.
 * Styling is the real components' business and is deliberately not asserted here.
 */
import type { ReactNode, SVGProps } from 'react'

/** Same union the shipped indicator declares. */
export type StateDotState = 'done' | 'warning' | 'ongoing' | 'error' | 'idle'

export function StateDot({ state, size }: {
  state: StateDotState
  size?: number | undefined
  className?: string | undefined
  appearance?: 'dot' | 'step'
}): ReactNode {
  return <span data-test-state-dot={state} data-size={size} />
}

/** Icon props, mirroring the shipped `IconProps`. */
export type IconProps = { size?: number } & SVGProps<SVGSVGElement>

export function IconChecklistOutlineRegular(props: IconProps): ReactNode {
  return <svg data-test-icon="checklist" {...props} />
}

export function IconCloseOutlineRegular(props: IconProps): ReactNode {
  return <svg data-test-icon="close" {...props} />
}
