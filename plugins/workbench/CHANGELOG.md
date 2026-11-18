# @banzhe/dsh-workbench

## 0.3.0

### Minor Changes

- 47d7c40: Drive the Windows taskbar pulse from the In work model: the desktop shell's progress indicator runs indeterminate while Sessions are running and nothing is waiting on the user or finished-unread, and clears otherwise. A browser, or a shell whose whitelist predates the progress channel, is unaffected.

### Patch Changes

- 670a762: Render the In work region's headers and rows with the browsing rows' own boxes. A Session listed there now measures, paints, aligns and hovers exactly like the same Session in the list below: same leading cell, same width, and the same hover fill; pinned rows carry the list's resting mark and release their pin from the row's hover action strip.
- e1372c0: Keep subagent Sessions out of the In work region. Both groups list top-level Sessions only: a lead Session stays under **Running** while subagents below it work, and no subagent row, nested list or per-hop row appears at any delegation depth.

## 0.2.0

### Minor Changes

- fb71794: Add the workbench Bundle: a fork of the shipped `ui-workspace` client plugin whose patch disables that row and inserts `workbench-personal`.
- 8b11f32: Add the In work region above the browsing list: two independent, collapsible groups folded from the Session list, the Session status map and the Workspace snapshot. **Running** holds every Session with live work, pinned or not; **Unread** holds finished-unread Sessions plus pinned Sessions with no running work, with pinned rows leading. Each Session lists once and each fold carries its own visible count. The block has no title and no total above the two folds: a group with no rows renders no fold, and with both groups empty the region renders nothing. The amber marker for a turn blocked on the user is kept.

  The region replaces the panel shipped by `@banzhe/dsh-session-attention`, which the web profile no longer installs.
