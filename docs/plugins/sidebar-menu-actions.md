# sidebar-menu-actions — implementation notes

Moved out of the plugin's README, which now covers only features and installation.

## DOM contract (Workspace menu graft)

DSH upgrades may move these; the tests build fixtures from the same
description. All selectors are read on the live document:

| Fact | Selector / rule |
|---|---|
| Real Workspace header row | `[data-row-key^="workspace:"]`, non-empty suffix after `workspace:` (ungrouped bucket has an empty suffix and no menu) |
| The "..." trigger | the row's **first** `button` (the second is New session) |
| Arming gestures | capture `pointerdown`, or `keydown` of `Enter`/`Space`, with the target inside that first button |
| Open menu portal | a `div[role="menu"]` added as a direct child of `document.body` |
| Menu rows | one wrapper div per `button[role="menuitem"]` inside the `div[role="presentation"]` viewport; rename first, danger delete last; each button has an icon span then a label span |
| Injected rows | clones of the rename wrapper; icon span content replaced, label set from the dictionary, marker `data-menu-actions="vscode"` / `="copy-path"` (per-row idempotency guard), inserted **before** the delete wrapper in that order |
| Menu close | `document.dispatchEvent(new KeyboardEvent('keydown', {key:'Escape'}))` — the primitive listens for it while open |
| Injection guards | arm consumed on the first portal-menu appearance; injected only when the armed trigger is still connected and `document.activeElement` is the trigger, `document.body`, or inside that menu |

A stale arm from a cancelled press therefore never reaches a Session row's
menu (Session rows key `data-row-key="session:..."`, which never matches).

## Why DOM surgery

The shipped menu is hard-coded — ui-workspace's `ProjectRowItem` renders
`[{rename},{delete}]` as data rows with **no slot** to register into — so the
plugin grafts rows into the open portal menu by DOM instead.

## Behaviour notes

- The **Copy workspace path** row is browser-local (one `writeClipboard` call)
  and is always grafted.
- The **Open in VS Code** row needs the Host. One `GET open-in-app/apps` per
  page sets the flag its graft reads; a fetch error, a non-2xx answer, or a
  missing `vscode` id all leave that one row out (plus one `console.warn`). The
  copy row is unaffected, and a probe that settles after a menu was already
  opened still adds the row to the next one.
- Workspace path resolution reads `ctx.workspaces.list` at click time; a row
  whose Workspace vanished dispatches Escape and sends/writes nothing.
- Launch failures (non-2xx or rejected fetch) show `toast.vscodeFailed` with
  the HTTP status or error message, after the menu has closed; a refused
  clipboard write shows `toast.copyFailed` the same way.
- Notices are the shipped `Toast` primitive rendered by the plugin's
  `shell.overlay` entry: one at a time, each replacing the last, and a repeat
  of the same text restarts the banner rather than extending it. The plugin
  owns no element, stylesheet, or timer of its own.
- Labels and notices follow the app locale through the `menu-actions`
  namespace (zh/en).

## Live patch (dev loop)

The same checkout can be mounted from the web Profile patch as a `file://`
Loader row instead of an installed Bundle: no `dsh plugin add` and no Host
restart, just rebuild `lib/` and refresh the GUI. Add to the Profile's
`cordis.patch.yml`:

```yaml
- insert:
    - id: sidebar-menu-actions
      name: "file:///D:/personal/dsh-plugins/plugins/sidebar-menu-actions/lib/index.js"
```
