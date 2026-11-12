# @banzhe/dsh-sidebar-menu-actions

## 0.4.2

### Patch Changes

- 9ae083b: Every browser half is built by one shared recipe and resolves the shell's module table in full: React, Cordis, Zod, the store engine, the slot registry, the UI primitives, and the dockkit are requested from the page instead of being bundled, and each package additionally declares the client packages whose services it injects. Bundles no longer carry a second copy of React or of the store engine, and the title-model settings no longer carry a bundled copy of the store engine.
- 32d9198: The Workspace "..." menu rows now come from the official context menu registry instead of being grafted into the open popup: Open in VS Code, Open in File Browser, and Copy workspace path register as data actions on the captured Workspace, so the shared menu owns positioning, keyboard movement, focus return, and dismissal, and the plugin no longer attaches document listeners, observes the DOM, or clones rows. Notices go through the shared context-menu toast, and each failing row reports its HTTP status or error message once. The directory is still resolved on selection, so a Workspace that left the registry launches and copies nothing. The plugin now requires DSH 0.2.2-rc.2 and Cordis 4.1.

## 0.4.1

### Patch Changes

- 4f3eda5: Locate a menu row’s icon and label containers by their semantic classes instead of fixed span indexes, so grafted rows keep their own labels after the Web menu moved icons into the keyed `contextMenu.icon` slot. The fixture now builds the real three-span row and every injected row asserts the text of its label span.

## 0.4.0

### Minor Changes

- de84d6b: Add an **Open in File Browser** row to the Workspace "..." menu, on Windows only. It launches the Workspace directory through the open-in-app Host's `explorer` catalog id, whose official `shell-open` launcher goes through the OS's open verb — so it uses the file browser you have configured as the default rather than naming `explorer.exe`. The official catalog declares `explorer` on `win32` alone, so the row needs no platform check of its own: the existing `GET open-in-app/apps` probe reports it only on a Windows Host, and a macOS or Linux Host keeps just the VS Code and copy rows.

## 0.3.0

### Minor Changes

- f0994ae: Add a **Copy workspace path** row to the Workspace "..." menu: it writes the Workspace's absolute directory to the clipboard and confirms with a toast. The VS Code row is now grafted only when the Host resolved VS Code, instead of gating the whole menu install.

### Patch Changes

- 1304f3e: Rewrite every plugin README as features plus installation only, add a Chinese `README.zh-CN.md` beside it, and move the implementation notes to `docs/plugins/<name>.md`.
- 76c6a88: Remove the "Copy session ID" row from the Session "..." menu. DSH now ships this action natively, so the plugin no longer adds a duplicate.

## 0.2.1

### Patch Changes

- 4d27559: Use caret ranges for `@deepseek-ai/*` peerDependencies instead of exact DSH versions. Plugin versions no longer follow DSH releases.
