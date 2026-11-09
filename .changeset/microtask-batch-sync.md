---
"@banzhe/dsh-app-notification": patch
---

Fold a tick's Session status, Session list, and Workspace archive updates into a single projection. A parent Session's turn end and the subagent row it spawned are published a microtask apart, so the presenter used to apply the state in between: the completion was announced and counted, then retracted one microtask later. The client entry now schedules projections through a microtask batch, and the initial baseline still applies immediately so a page load presents its badge and existing completions without a delayed first frame.

A Session that delegated now walks a lifecycle instead of a single wait. Dispatching a subagent marks the parent as owing a turn; the settlement of its last descendant only hands the reports back, and the stop after the wake-up turn is the completion. Counting the settlement itself announced a Session before it had answered, while reading completion-unread rows alone missed the wake-up, because starting a turn clears that flag. The observer now folds every listed Session and advances two bookmarks per Session — awaiting a parent completion, and having seen the waking turn run — dropping both for Sessions that are archived or no longer published.
