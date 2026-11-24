---
'@banzhe/dsh-workbench': patch
---

Keep a Session in the In work "running" group while the work it delegated is wrapping up. A Session that hands work to subagents ends its own turn as soon as the delegation is accepted, so when the subagents stop, its own run is already over and its finish is unread while the message reporting them is still on its way. That gap no longer moves the row into "unread" and back: a Session whose subagent work just stopped, while it is idle and its finish is unread, stays under "running" until it runs again or its finish is read. Sessions that never delegated work are unaffected, and a finished-unread Session with no running subagent work still files under "unread".
