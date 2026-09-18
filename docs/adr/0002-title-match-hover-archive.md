# Title-match hover archive

> Superseded by [0004](0004-session-id-from-react-fiber.md): rows DO expose a session id, on the row element's React fiber.

Sidebar Session rows expose no session id. Clicking the row `⋯` menu would archive the right row, including duplicate titles, but flashes a portaled menu. Matching the ellipsis aria-label against visible (unarchived, non-blank, non-subagent) display titles lets the plugin call `workspaces.archiveSession` directly. Duplicate titles skip rather than guessing or falling back to the menu. The aria-label and hover-card copy strings are copied from DSH locale templates; rewording them there silently disables the gesture.
