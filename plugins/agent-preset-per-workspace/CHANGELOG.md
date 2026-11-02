# @banzhe/dsh-agent-preset-per-workspace

## 0.2.3

### Patch Changes

- c116f2a: Supply the workspace's remembered preset to `sessionController.create` when `request.agentPreset` is omitted so reusing a blank session (`reuseLive` / `reuseSetup`) does not reset the session and stored workspace binding back to the global default.

## 0.2.2

### Patch Changes

- 1304f3e: Rewrite every plugin README as features plus installation only, add a Chinese `README.zh-CN.md` beside it, and move the implementation notes to `docs/plugins/<name>.md`.

## 0.2.1

### Patch Changes

- 4d27559: Use caret ranges for `@deepseek-ai/*` peerDependencies instead of exact DSH versions. Plugin versions no longer follow DSH releases.
