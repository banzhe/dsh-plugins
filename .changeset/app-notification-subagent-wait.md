---
"@banzhe/dsh-app-notification": patch
---

Defer a Session's completion notification and badge count while any subagent descendant is still running. Delegating ends the Session's turn, so the host marked it finished-unread the moment its first child started, and both surfaces announced work that was still going on. The wait now crosses intermediate children that are themselves idle — a child idle while its own child runs still holds the announcement — and lands once no descendant is running. That is stricter than the sidebar, which counts only direct catalog children.
