# @banzhe/dsh-git

## 0.2.3

### Patch Changes

- a8cf17d: Read the model selection from `sessionProjections.snapshot()` instead of the deprecated `stateOf(session, key)`, which now returns `unknown` since DSH removed `SessionProjectionStateMap`.

## 0.2.2

### Patch Changes

- 1304f3e: Rewrite every plugin README as features plus installation only, add a Chinese `README.zh-CN.md` beside it, and move the implementation notes to `docs/plugins/<name>.md`.

## 0.2.1

### Patch Changes

- 4d27559: Use caret ranges for `@deepseek-ai/*` peerDependencies instead of exact DSH versions. Plugin versions no longer follow DSH releases.
