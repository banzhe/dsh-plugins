---
'@banzhe/dsh-workbench': patch
---

The new-session workspace menu now opens on a search field. Typing narrows the list to the Workspaces whose path or display name contains the query, keeps the ancestors that lead to them, and unfolds them for as long as the query lasts; a query that matches nothing keeps the menu open with a no-matches line instead of closing it. The tree scrolls inside a 320px-tall list, so a large registry no longer stretches the menu.
