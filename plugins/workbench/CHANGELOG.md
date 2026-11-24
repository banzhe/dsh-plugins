# @banzhe/dsh-workbench

## 0.3.3

### Patch Changes

- 17bf1ed: Nest the new-session workspace picker the way the sidebar's workspace tree nests. Workspaces that sit inside another registered Workspace folder now appear under it, indented one step per level, in the same registry order; a row with descendants carries a disclosure arrow that folds its subtree, and every row keeps its title, its disambiguating path suffix, and the marker on the currently selected Workspace. Clicking a row's title selects that Workspace and closes the picker; clicking the arrow only folds or unfolds. The fold state is the sidebar tree's own `groupExpansion` record, so folding a Workspace in the picker folds the same Workspace in the sidebar and the choice survives reloads.
- 7ec7cfb: Keep a Session in the In work "running" group while the work it delegated is wrapping up. A Session that hands work to subagents ends its own turn as soon as the delegation is accepted, so when the subagents stop, its own run is already over and its finish is unread while the message reporting them is still on its way. That gap no longer moves the row into "unread" and back: a Session whose subagent work just stopped, while it is idle and its finish is unread, stays under "running" until it runs again or its finish is read. Sessions that never delegated work are unaffected, and a finished-unread Session with no running subagent work still files under "unread".
- de845af: The new-session workspace menu now opens on a search field. Typing narrows the list to the Workspaces whose path or display name contains the query, keeps the ancestors that lead to them, and unfolds them for as long as the query lasts; a query that matches nothing keeps the menu open with a no-matches line instead of closing it. The tree scrolls inside a 320px-tall list, so a large registry no longer stretches the menu.

## 0.3.2

### Patch Changes

- 849ca3d: In work: the Running and Unread folds now render even when they hold nothing, reporting a count of 0, while an empty Pinned fold stays hidden. A pinned Session also follows its own state — it lists under Running while it works and under Unread when it finishes unread, returning to Pinned once both are cleared — and pinned rows lead those two groups.
- 69e6fb8: In work: each quick-group row now carries the Session's Workspace name on a second line under its title, so a mixed list of Sessions from several Workspaces stays readable. Rows in the browsing list below keep their single-line layout.

## 0.3.1

### Patch Changes

- 580cd63: The browsing list is now four independently collapsible groups: unread, pinned, running, and the browsing list itself — "All workspaces", or "All sessions" in the one-list view — which stays last and open by default and keeps its watermarks, group expansion and scroll position while folded. A pinned Session lists only under Pinned and keeps its real status dot there, so a group never stands in for the Session's state. Quick-group rows are the browsing list's own rows — the same status dots, one-at-a-time hover cards, row menu, hover actions, pin mark, rename and relative time — while reordering stays in the tree. The hairline between the block and the tree is gone, and the Windows taskbar pulse no longer treats a pinned Session at rest as a new notification.

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
