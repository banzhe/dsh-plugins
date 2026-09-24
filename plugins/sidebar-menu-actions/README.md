# @banzhe/dsh-sidebar-menu-actions

Web Client plugin: two sidebar row-menu contributions.

- **Session "..." menu** — a `sidebar.workspaces.session.menu.item` slot entry
  (id `sidebar-menu-actions.copy-session-id`, order 500, after the shipped
  pin/rename/fork/archive) that copies the row's Session ID to the clipboard
  and closes the menu. Success and failure each raise one notice through the
  shipped `Toast` banner (top-center, `role="alert"`), mounted by this plugin's
  `shell.overlay` entry `sidebar-menu-actions.notice`. Registered
  unconditionally.
- **Workspace "..." menu** — this menu ships with **no slot** (ui-workspace
  hard-codes rename/delete), so the plugin grafts one row into the open portal
  menu by DOM: **Open in VS Code** (`在 VS Code 中打开`), inserted between
  rename and the danger delete row. Clicking it POSTs the open-in-app Host
  route (`{app:'vscode', path:<workspace dir>}`) and closes the menu through
  the Menu primitive's Escape path. Armed only after `GET open-in-app/apps`
  resolves `vscode` (provided by the `dsh-web-app` bundle); otherwise the menu
  renders exactly as shipped and one console line says why.

Meant for the `web` Profile.

## Install

```sh
pnpm --filter @banzhe/dsh-sidebar-menu-actions build
dsh plugin --profile web add ./plugins/sidebar-menu-actions   # requires a dsh web restart
```

Rebuild `lib/` after source changes and refresh the GUI. Do not assume HMR.

Remove with:

```sh
dsh plugin --profile web remove @banzhe/dsh-sidebar-menu-actions
```

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
| Injected row | clone of the rename wrapper; icon span content replaced, label set from the dictionary, marker `data-menu-actions="vscode"` (idempotency guard), inserted **before** the delete wrapper |
| Menu close | `document.dispatchEvent(new KeyboardEvent('keydown', {key:'Escape'}))` — the primitive listens for it while open |
| Injection guards | arm consumed on the first portal-menu appearance; injected only when the armed trigger is still connected and `document.activeElement` is the trigger, `document.body`, or inside that menu |

A stale arm from a cancelled press therefore never reaches a Session row's
menu (Session rows key `data-row-key="session:..."`, which never matches).

## Behaviour notes

- One `GET open-in-app/apps` per page decides the Workspace half; a fetch
  error, a non-2xx answer, or a missing `vscode` id all disable it silently
  (plus one `console.warn`).
- Workspace path resolution reads `ctx.workspaces.list` at click time; a row
  whose Workspace vanished dispatches Escape and sends nothing.
- Launch failures (non-2xx or rejected fetch) show
  `toast.vscodeFailed` with the HTTP status or error message, after the menu
  has closed.
- The clipboard write goes through ui-primitives' `writeClipboard` (async
  Clipboard API, `execCommand('copy')` fallback); it never throws, so a refused
  write is the only failure and shows `toast.copyFailed` plus the log line
  `sidebar-menu-actions: copy session id failed: the clipboard refused the write`.
- Notices are the shipped `Toast` primitive rendered by the plugin's
  `shell.overlay` entry: one at a time, each replacing the last, and a repeat
  of the same text restarts the banner rather than extending it. The plugin
  owns no element, stylesheet, or timer of its own.
- Labels and notices follow the app locale through the `menu-actions`
  namespace (zh/en).
