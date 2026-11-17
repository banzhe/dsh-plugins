---
'@banzhe/dsh-workbench': minor
---

Add the In work region above the browsing list: two independent, collapsible groups folded from the Session list, the Session status map and the Workspace snapshot. **Running** holds every Session with live work, pinned or not; **Unread** holds finished-unread Sessions plus pinned Sessions with no running work, with pinned rows leading. Each Session lists once and each fold carries its own visible count. The block has no title and no total above the two folds: a group with no rows renders no fold, and with both groups empty the region renders nothing. The amber marker for a turn blocked on the user is kept.

The region replaces the panel shipped by `@banzhe/dsh-session-attention`, which the web profile no longer installs.
