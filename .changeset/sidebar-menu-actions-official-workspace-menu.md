---
"@banzhe/dsh-sidebar-menu-actions": patch
---

The Workspace "..." menu rows now come from the official context menu registry instead of being grafted into the open popup: Open in VS Code, Open in File Browser, and Copy workspace path register as data actions on the captured Workspace, so the shared menu owns positioning, keyboard movement, focus return, and dismissal, and the plugin no longer attaches document listeners, observes the DOM, or clones rows. Notices go through the shared context-menu toast, and each failing row reports its HTTP status or error message once. The directory is still resolved on selection, so a Workspace that left the registry launches and copies nothing. The plugin now requires DSH 0.2.2-rc.2 and Cordis 4.1.
