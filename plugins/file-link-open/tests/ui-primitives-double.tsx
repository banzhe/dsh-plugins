/**
 * Test double for `@deepseek-ai/dsh-client-ui-primitives`, wired in through the
 * `resolve.alias` entry in `vitest.config.ts`.
 *
 * The published entry is the Web shell's static library: importing it eagerly
 * evaluates katex, shiki, micromark, ansi-to-html and friends — a dependency
 * tree this standalone package deliberately does not install. Production never
 * loads this file; the browser half obtains the REAL module from the shell's
 * module-table seed, which is why `tsdown.config.ts` keeps it external.
 *
 * Only the two members the plugin's entry imports are reproduced, and only
 * their contract: `writeClipboard` records what it was asked to copy and
 * answers through `clipboard.accepts`, and `IconRightUpOutlineRegular` marks
 * itself so a spec can tell the icon fallback from a loaded image.
 */
import type { ReactNode } from 'react'

/** Every text handed to `writeClipboard`, in order; cleared by each spec. */
export const clipboardWrites: string[] = []

/** Whether the next `writeClipboard` call is accepted; the specs flip it to model a refusal. */
export const clipboard = { accepts: true }

export async function writeClipboard(text: string): Promise<boolean> {
  clipboardWrites.push(text)
  return clipboard.accepts
}

/**
 * The shipped native-open glyph, reduced to a marker element.
 * @param props.size - icon edge in pixels (unused by the marker).
 * @returns the marker span.
 */
export function IconRightUpOutlineRegular({ size }: { size?: number }): ReactNode {
  return <span data-test-icon-fallback={String(size ?? 'default')} />
}
