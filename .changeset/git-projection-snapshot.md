---
"@banzhe/dsh-git": patch
---

Read the model selection from `sessionProjections.snapshot()` instead of the deprecated `stateOf(session, key)`, which now returns `unknown` since DSH removed `SessionProjectionStateMap`.
