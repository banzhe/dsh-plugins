# @banzhe/dsh-sidebar-menu-actions

## 0.3.0

### Minor Changes

- f0994ae: Add a **Copy workspace path** row to the Workspace "..." menu: it writes the Workspace's absolute directory to the clipboard and confirms with a toast. The VS Code row is now grafted only when the Host resolved VS Code, instead of gating the whole menu install.

### Patch Changes

- 1304f3e: Rewrite every plugin README as features plus installation only, add a Chinese `README.zh-CN.md` beside it, and move the implementation notes to `docs/plugins/<name>.md`.
- 76c6a88: Remove the "Copy session ID" row from the Session "..." menu. DSH now ships this action natively, so the plugin no longer adds a duplicate.

## 0.2.1

### Patch Changes

- 4d27559: Use caret ranges for `@deepseek-ai/*` peerDependencies instead of exact DSH versions. Plugin versions no longer follow DSH releases.
