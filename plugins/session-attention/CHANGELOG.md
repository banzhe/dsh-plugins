# @banzhe/dsh-session-attention

## 0.2.2

### Patch Changes

- 1304f3e: Rewrite every plugin README as features plus installation only, add a Chinese `README.zh-CN.md` beside it, and move the implementation notes to `docs/plugins/<name>.md`.
- a7087ba: Skip archived Sessions in the attention panel. An archived Session that the host still reports as running or finished-unread no longer lists in either section, no longer counts toward the badge, and no longer selects the toggle's `waiting` outline; a running subagent under an archived parent no longer re-mounts that parent as a container row. This required subscribing to the Workspace Controller's archive set, since an archive mutation moves neither the Session list nor the status snapshot, and the `workspaces` service is now injected.

## 0.2.1

### Patch Changes

- 4d27559: Use caret ranges for `@deepseek-ai/*` peerDependencies instead of exact DSH versions. Plugin versions no longer follow DSH releases.
