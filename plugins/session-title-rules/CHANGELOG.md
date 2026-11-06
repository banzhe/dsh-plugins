# @banzhe/dsh-session-title-rules

## 0.2.3

### Patch Changes

- e8c8df0: Declare `session-title` in `LlmRequestPurposeMap`. A title request then names a purpose that `GenerateOptions` accepts on DSH 0.2.2 and later, where `purpose` is limited to the purposes their producers declare. The declaration is type-only: the emitted JavaScript and the request a title call sends are the same on every 0.2.x release, with `purpose: 'session-title'` forwarded unchanged.

## 0.2.2

### Patch Changes

- 1304f3e: Rewrite every plugin README as features plus installation only, add a Chinese `README.zh-CN.md` beside it, and move the implementation notes to `docs/plugins/<name>.md`.

## 0.2.1

### Patch Changes

- 4d27559: Use caret ranges for `@deepseek-ai/*` peerDependencies instead of exact DSH versions. Plugin versions no longer follow DSH releases.
