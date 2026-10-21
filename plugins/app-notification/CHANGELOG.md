# @banzhe/dsh-app-notification

## 0.2.2

### Patch Changes

- ab72854: Skip archived Sessions in both surfaces. A Session that finishes while archived raises no notification, and archiving a finished Session retracts it from the icon badge instead of leaving it counted. Restoring an archived Session re-counts it without announcing it a second time. This required subscribing to the Workspace Controller's archive set, since archiving moves neither the Session status snapshot nor the Session list.
- 1304f3e: Rewrite every plugin README as features plus installation only, add a Chinese `README.zh-CN.md` beside it, and move the implementation notes to `docs/plugins/<name>.md`.

## 0.2.1

### Patch Changes

- 4d27559: Use caret ranges for `@deepseek-ai/*` peerDependencies instead of exact DSH versions. Plugin versions no longer follow DSH releases.
