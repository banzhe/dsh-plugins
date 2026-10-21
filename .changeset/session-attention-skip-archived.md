---
'@banzhe/dsh-session-attention': patch
---

Skip archived Sessions in the attention panel. An archived Session that the host still reports as running or finished-unread no longer lists in either section, no longer counts toward the badge, and no longer selects the toggle's `waiting` outline; a running subagent under an archived parent no longer re-mounts that parent as a container row. This required subscribing to the Workspace Controller's archive set, since an archive mutation moves neither the Session list nor the status snapshot, and the `workspaces` service is now injected.
