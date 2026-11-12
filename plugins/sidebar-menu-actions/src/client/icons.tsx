/**
 * The three leading glyphs of the Workspace menu rows, and the keyed
 * `contextMenu.icon` entries the shared menu resolves them through.
 *
 * A row names its glyph by key; the popup renders that key through the Slot it
 * hosts, so the glyph arrives from this plugin's own registration instead of
 * from the row data (menu rows carry no JSX). The 16px grid and 1.5px stroke
 * envelope are the shared menu's own icon metrics.
 */
import type { ReactNode } from 'react'

/** Keyed icon names the three rows name in their `icon.key`. */
export const ICON_KEYS = {
  vscode: 'sidebar-menu-actions.vscode',
  explorer: 'sidebar-menu-actions.explorer',
  copyPath: 'sidebar-menu-actions.copy-path',
} as const

/** Wrap one glyph's children in the shared envelope. */
function glyph(children: ReactNode): ReactNode {
  return (
    <svg
      viewBox="0 0 16 16"
      width="16"
      height="16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      {children}
    </svg>
  )
}

/** Angle-bracket glyph for the VS Code row. */
export function VscodeGlyph(): ReactNode {
  return glyph(<path d="M6 4.5 3 8l3 3.5M10 4.5 13 8l-3 3.5" />)
}

/** Folder glyph for the file-browser row. */
export function FileBrowserGlyph(): ReactNode {
  return glyph(<path d="M2.5 5.5a1.5 1.5 0 0 1 1.5-1.5h2l1.5 1.5h5a1.5 1.5 0 0 1 1.5 1.5v4.5a1.5 1.5 0 0 1-1.5 1.5H4a1.5 1.5 0 0 1-1.5-1.5z" />)
}

/** Two-sheet glyph for the copy row. */
export function CopyPathGlyph(): ReactNode {
  return glyph(
    <>
      <rect x="5.5" y="5.5" width="8" height="8" rx="2" />
      <path d="M10.5 4.5V4a1.5 1.5 0 0 0-1.5-1.5H4A1.5 1.5 0 0 0 2.5 4v5A1.5 1.5 0 0 0 4 10.5h.5" />
    </>,
  )
}

/** The keyed registrations, in the order the rows appear. */
export const ICON_ENTRIES: readonly (readonly [string, () => ReactNode])[] = [
  [ICON_KEYS.vscode, VscodeGlyph],
  [ICON_KEYS.explorer, FileBrowserGlyph],
  [ICON_KEYS.copyPath, CopyPathGlyph],
]
