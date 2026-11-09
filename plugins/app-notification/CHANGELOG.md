# @banzhe/dsh-app-notification

## 0.2.4

### Patch Changes

- fbc0f4e: Fold a tick's Session status, Session list, and Workspace archive updates into a single projection. A parent Session's turn end and the subagent row it spawned are published a microtask apart, so the presenter used to apply the state in between: the completion was announced and counted, then retracted one microtask later. The client entry now schedules projections through a microtask batch, and the initial baseline still applies immediately so a page load presents its badge and existing completions without a delayed first frame.

  A Session that delegated now walks a lifecycle instead of a single wait. Dispatching a subagent marks the parent as owing a turn; the settlement of its last descendant only hands the reports back, and the stop after the wake-up turn is the completion. Counting the settlement itself announced a Session before it had answered, while reading completion-unread rows alone missed the wake-up, because starting a turn clears that flag. The observer now folds every listed Session and advances two bookmarks per Session — awaiting a parent completion, and having seen the waking turn run — dropping both for Sessions that are archived or no longer published.

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
