# Title-match hover archive

> Superseded by [0004](0004-session-id-from-react-fiber.md): rows DO expose a session id, on the row element's React fiber.
>
> Retired: the whole `hover-archive` plugin was removed once DSH improved the archive interaction and the hover gesture was no longer worth carrying. Kept as history only — 0002 explains the original title-match design, 0004 explains the fiber-based design that replaced it. Neither describes shipped code.

Sidebar Session rows expose no session id. Clicking the row `⋯` menu would archive the right row, including duplicate titles, but flashes a portaled menu. Matching the ellipsis aria-label against visible (unarchived, non-blank, non-subagent) display titles lets the plugin call `workspaces.archiveSession` directly. Duplicate titles skip rather than guessing or falling back to the menu. The aria-label and hover-card copy strings are copied from DSH locale templates; rewording them there silently disables the gesture.
