---
"@banzhe/dsh-file-link-open": patch
---

File paths now contribute their entries to the official file context menu instead of adding a second, duplicate set beside it: one group with copy path, copy relative path, and the applications that can open the file. Entries act on the workspace of the Session the click came from rather than the directory of the process serving the menu, and an application probe that fails leaves the entry in place, so the next click retries it.
