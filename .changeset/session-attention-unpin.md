---
"@banzhe/dsh-session-attention": patch
---

Show the pin on every pinned row and let it release the pin. A pinned Session that is running or finished unread used to carry no pin at all, because the flag was set only on the row the pin alone listed. The flag now follows the pin set, so a working row wears the pin at its trailing edge beside the state dot it earns, and an idle container row keeps it in the lead slot. The pin is a button: it calls the Workspace Controller's unpin, is named "Unpin session" / 取消置顶 for screen readers and on hover, and sits beside the row's button rather than inside it — a button nested in a button is invalid HTML a browser splits apart — so releasing a pin never opens the Session and never closes the panel. A row the pin alone listed leaves the panel with it; a running or unread row stays, minus the pin.
