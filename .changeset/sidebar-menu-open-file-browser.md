---
'@banzhe/dsh-sidebar-menu-actions': minor
---

Add an **Open in File Browser** row to the Workspace "..." menu, on Windows only. It launches the Workspace directory through the open-in-app Host's `explorer` catalog id, whose official `shell-open` launcher goes through the OS's open verb — so it uses the file browser you have configured as the default rather than naming `explorer.exe`. The official catalog declares `explorer` on `win32` alone, so the row needs no platform check of its own: the existing `GET open-in-app/apps` probe reports it only on a Windows Host, and a macOS or Linux Host keeps just the VS Code and copy rows.
