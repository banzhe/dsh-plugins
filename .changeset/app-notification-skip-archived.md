---
'@banzhe/dsh-app-notification': patch
---

Skip archived Sessions in both surfaces. A Session that finishes while archived raises no notification, and archiving a finished Session retracts it from the icon badge instead of leaving it counted. Restoring an archived Session re-counts it without announcing it a second time. This required subscribing to the Workspace Controller's archive set, since archiving moves neither the Session status snapshot nor the Session list.
