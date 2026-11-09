# @banzhe/dsh-file-link-open

## 0.2.3

### Patch Changes

- 97414ec: 重构右键菜单为常驻挂载并由内部 state 驱动，消除每次右键重复调用 contextRoot.render 与 Portal 重建的性能开销。

## 0.2.2

### Patch Changes

- 1304f3e: Rewrite every plugin README as features plus installation only, add a Chinese `README.zh-CN.md` beside it, and move the implementation notes to `docs/plugins/<name>.md`.

## 0.2.1

### Patch Changes

- 4d27559: Use caret ranges for `@deepseek-ai/*` peerDependencies instead of exact DSH versions. Plugin versions no longer follow DSH releases.
