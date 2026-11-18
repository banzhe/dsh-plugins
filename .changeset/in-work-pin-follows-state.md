---
'@banzhe/dsh-workbench': patch
---

In work: the Running and Unread folds now render even when they hold nothing, reporting a count of 0, while an empty Pinned fold stays hidden. A pinned Session also follows its own state — it lists under Running while it works and under Unread when it finishes unread, returning to Pinned once both are cleared — and pinned rows lead those two groups.
