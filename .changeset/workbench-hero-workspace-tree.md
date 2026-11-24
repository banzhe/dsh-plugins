---
'@banzhe/dsh-workbench': patch
---

Nest the new-session workspace picker the way the sidebar's workspace tree nests. Workspaces that sit inside another registered Workspace folder now appear under it, indented one step per level, in the same registry order; a row with descendants carries a disclosure arrow that folds its subtree, and every row keeps its title, its disambiguating path suffix, and the marker on the currently selected Workspace. Clicking a row's title selects that Workspace and closes the picker; clicking the arrow only folds or unfolds. The fold state is the sidebar tree's own `groupExpansion` record, so folding a Workspace in the picker folds the same Workspace in the sidebar and the choice survives reloads.
