# @banzhe/dsh-session-attention

## 0.2.7

### Patch Changes

- 9ae083b: Every browser half is built by one shared recipe and resolves the shell's module table in full: React, Cordis, Zod, the store engine, the slot registry, the UI primitives, and the dockkit are requested from the page instead of being bundled, and each package additionally declares the client packages whose services it injects. Bundles no longer carry a second copy of React or of the store engine, and the title-model settings no longer carry a bundled copy of the store engine.

## 0.2.6

### Patch Changes

- 053bee9: Mark a row listed only because its Session is pinned with the pin glyph in the slot its state dot would fill, so an idle row says why it is there; the row's accessible name says the Session is pinned. The panel title now reads "Running, pinned and unread" / 进行中、置顶与未读 and the running section "Running and pinned" / 进行中与置顶.
- 3140947: Show the pin on every pinned row and let it release the pin. A pinned Session that is running or finished unread used to carry no pin at all, because the flag was set only on the row the pin alone listed. The flag now follows the pin set, so a working row wears the pin at its trailing edge beside the state dot it earns, and an idle container row keeps it in the lead slot. The pin is a button: it calls the Workspace Controller's unpin, is named "Unpin session" / 取消置顶 for screen readers and on hover, and sits beside the row's button rather than inside it — a button nested in a button is invalid HTML a browser splits apart — so releasing a pin never opens the Session and never closes the panel. A row the pin alone listed leaves the panel with it; a running or unread row stays, minus the pin.

## 0.2.5

### Patch Changes

- 7377f61: List pinned Sessions in the attention panel even while they are idle, as container rows that carry no spinner or duration; a pin on its own adds nothing to the badge, the toggle outline, or the Windows taskbar pulse.

## 0.2.4

### Patch Changes

- 0a7f705: Keep an idle Session listed as a container row when its only activity is a nested subagent (grandchild or deeper), with the running descendant nested under the idle intermediates.

## 0.2.3

### Patch Changes

- a9c7973: On Windows, pulse the desktop taskbar with the native indeterminate progress while listed Sessions are running and none are waiting or finished-unread.

## 0.2.2

### Patch Changes

- 1304f3e: Rewrite every plugin README as features plus installation only, add a Chinese `README.zh-CN.md` beside it, and move the implementation notes to `docs/plugins/<name>.md`.
- a7087ba: Skip archived Sessions in the attention panel. An archived Session that the host still reports as running or finished-unread no longer lists in either section, no longer counts toward the badge, and no longer selects the toggle's `waiting` outline; a running subagent under an archived parent no longer re-mounts that parent as a container row. This required subscribing to the Workspace Controller's archive set, since an archive mutation moves neither the Session list nor the status snapshot, and the `workspaces` service is now injected.

## 0.2.1

### Patch Changes

- 4d27559: Use caret ranges for `@deepseek-ai/*` peerDependencies instead of exact DSH versions. Plugin versions no longer follow DSH releases.
