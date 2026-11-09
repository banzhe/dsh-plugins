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
 * their contract: `Menu` renders its anchor always and its rows only while
 * `open`, reporting the anchor rect it was given and routing row activation /
 * close back to the owner; `writeClipboard` records what it was asked to copy.
 * Styling, keyboard walking and portaling are the real component's business and
 * are deliberately not reproduced.
 */
import type { ReactNode } from 'react'

export interface DoubleMenuRow {
  readonly id: string
  readonly label?: ReactNode
  readonly icon?: ReactNode
  readonly disabled?: boolean
  readonly danger?: boolean
}

export interface DoubleMenuSeparator {
  readonly type: 'separator'
  readonly id: string
}

export interface DoubleMenuLabel {
  readonly type: 'label'
  readonly id: string
  readonly text: string
}

export type DoubleMenuEntry = DoubleMenuRow | DoubleMenuSeparator | DoubleMenuLabel

function isSeparator(entry: DoubleMenuEntry): entry is DoubleMenuSeparator {
  return (entry as DoubleMenuSeparator).type === 'separator'
}

function isLabel(entry: DoubleMenuEntry): entry is DoubleMenuLabel {
  return (entry as DoubleMenuLabel).type === 'label'
}

/** Every text handed to `writeClipboard`, in order; cleared by each spec. */
export const clipboardWrites: string[] = []

export async function writeClipboard(text: string): Promise<boolean> {
  clipboardWrites.push(text)
  return true
}

export function Menu(props: {
  open: boolean
  anchor: ReactNode
  items?: readonly DoubleMenuEntry[]
  onSelect?: (id: string) => void
  onClose: () => void
  getAnchorRect?: () => { x: number, y: number } | null
}): ReactNode {
  // The real Menu only asks for the rect while open; a closed menu must not
  // depend on the owner having a cursor to report.
  const rect = props.open ? props.getAnchorRect?.() ?? null : null
  return (
    <span data-test-menu-state={props.open ? 'open' : 'closed'}>
      {props.anchor}
      {props.open
        ? (
            <div
              role="menu"
              data-test-menu="1"
              data-test-menu-x={rect?.x}
              data-test-menu-y={rect?.y}
            >
              <button type="button" data-test-menu-close="1" onClick={() => { props.onClose() }}>close</button>
              {(props.items ?? []).map((entry) => {
                if (isSeparator(entry)) return <hr key={entry.id} data-test-menu-separator="1" />
                if (isLabel(entry)) return <div key={entry.id} data-test-menu-label={entry.id}>{entry.text}</div>
                return (
                  <button
                    key={entry.id}
                    type="button"
                    data-test-menu-item={entry.id}
                    onClick={() => { props.onSelect?.(entry.id) }}
                  >
                    {entry.label}
                  </button>
                )
              })}
            </div>
          )
        : null}
    </span>
  )
}
