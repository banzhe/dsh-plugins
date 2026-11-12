# sidebar-menu-actions — implementation notes

Moved out of the plugin's README, which now covers only features and installation.

## Contribution contract

The rows are data contributions to the official Workspace context menu, not DOM
grafts. The menu belongs to `@deepseek-ai/dsh-client-ui-context-menu`, which the
Web application bundle mounts; this plugin injects the `contextMenus` service and
registers one contribution against the `workspace` target family that
`ui-workspace` declares and its row "..." trigger captures.

| Fact | Value |
|---|---|
| Contribution id | `sidebar-menu-actions.workspace` (unique within the `workspace` family) |
| Target | `workspace` — the captured row's `workspaceId`, `path`, and `displayTitle` |
| Order | `110`: after the shipped rename row (100), before the official `open-in-app.workspace` reveal row (200) and the shipped danger delete row (300) — the position the rows had as grafts |
| Row ids | `vscode`, `explorer`, `copy-path`, in that order |
| Row icons | keyed `contextMenu.icon` registrations `sidebar-menu-actions.vscode`, `sidebar-menu-actions.explorer`, `sidebar-menu-actions.copy-path` |
| Trigger | the row's own "..." button (the official `contextMenu.button` factory, or the row's right-click / Shift+F10); the ungrouped bucket has no Workspace id and therefore no menu |

The plugin owns no element, stylesheet, document listener, observer, or timer.
Every registration is released through `ctx.effect` or `ctx.slots.inject`, so
disabling the Bundle withdraws the rows, their glyphs, and their dictionaries
with the rest of its fiber.

## Availability gate

The two launch rows need the Host: **Open in VS Code** and **Open in File
Browser** are built only for a catalog id the Host resolved. One warm
`GET open-in-app/apps` per page feeds them (`probe.ts`):

- The read starts at activation. A menu resolution waits at most 300 ms for it;
  a round still in flight after that keeps running and answers the next opening,
  so a probe that settles late still adds the rows to a later menu. Only an
  answered read costs no request: while one is in flight every menu shares it.
- A dismissed menu stops waiting and reports its own abort reason; it never
  cancels the shared read, and it does not ask again — a resolution that is
  already aborted returns before any request or wait.
- A round that cannot answer (non-2xx, a body without `apps`, or a rejected
  fetch) clears the memo, so the next opening asks again instead of losing the
  rows for the rest of the page's life.
- One `console.warn` per unanswered catalog id says which row is missing; a
  catalog that could not be read logs one line with the HTTP status or message.
- **The file-browser row is Windows-only with no platform sniff.** The official
  open-in-app catalog declares `explorer` on `win32` alone, so a Windows Host
  reports it and any other Host reports `vscode` only. Its launcher is the
  catalog's own entry — the OS's open verb for a directory — which honors
  whichever file browser the user configured as the default, rather than naming
  `explorer.exe`.
- **Copy workspace path** needs nothing from the Host and is always built.

## Behaviour notes

- The Workspace directory is resolved when a row RUNS, not when the menu opened:
  the contribution reads the `ctx.workspaces` snapshot by the captured id. A
  Workspace that left the registry launches and copies nothing; the shared menu
  closes on selection either way, exactly like a shipped row.
- A launch POSTs open-in-app's `{app, path}`. Both failure shapes — a non-2xx
  answer and a rejected request — are caught inside the row, so the row never
  rejects into the menu's own failure notice: one `console.warn` and one
  `toast.vscodeFailed` / `toast.fileBrowserFailed` notice carry the HTTP status
  or error message.
- A copy is browser-local and reports itself: `toast.pathCopied` on success, and
  `toast.copyFailed` after a refused clipboard write.
- Notices are the shared context-menu toast (`ctx.contextMenus.notify`), so the
  plugin renders no banner of its own and two rows can never raise two toasts for
  one selection.
- Labels and notices follow the app locale through the `menu-actions` namespace
  (zh/en).

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
