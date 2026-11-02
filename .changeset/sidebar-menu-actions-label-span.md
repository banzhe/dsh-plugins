---
"@banzhe/dsh-sidebar-menu-actions": patch
---

Locate a menu row’s icon and label containers by their semantic classes instead of fixed span indexes, so grafted rows keep their own labels after the Web menu moved icons into the keyed `contextMenu.icon` slot. The fixture now builds the real three-span row and every injected row asserts the text of its label span.
