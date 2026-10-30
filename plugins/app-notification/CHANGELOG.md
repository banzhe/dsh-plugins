# @banzhe/dsh-app-notification

## 0.2.3

### Patch Changes

- 597758d: Defer a Session's completion notification and badge count while any subagent descendant is still running. Delegating ends the Session's turn, so the host marked it finished-unread the moment its first child started, and both surfaces announced work that was still going on. The wait now crosses intermediate children that are themselves idle — a child idle while its own child runs still holds the announcement — and lands once no descendant is running. That is stricter than the sidebar, which counts only direct catalog children.

## 0.2.2

### Patch Changes

- ab72854: Skip archived Sessions in both surfaces. A Session that finishes while archived raises no notification, and archiving a finished Session retracts it from the icon badge instead of leaving it counted. Restoring an archived Session re-counts it without announcing it a second time. This required subscribing to the Workspace Controller's archive set, since archiving moves neither the Session status snapshot nor the Session list.
- 1304f3e: Rewrite every plugin README as features plus installation only, add a Chinese `README.zh-CN.md` beside it, and move the implementation notes to `docs/plugins/<name>.md`.

## 0.2.1

### Patch Changes

- 4d27559: Use caret ranges for `@deepseek-ai/*` peerDependencies instead of exact DSH versions. Plugin versions no longer follow DSH releases.
