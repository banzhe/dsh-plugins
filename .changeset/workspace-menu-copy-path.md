---
'@banzhe/dsh-sidebar-menu-actions': minor
---

Add a **Copy workspace path** row to the Workspace "..." menu: it writes the Workspace's absolute directory to the clipboard and confirms with a toast. The VS Code row is now grafted only when the Host resolved VS Code, instead of gating the whole menu install.
