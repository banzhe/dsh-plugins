# file-link-open — implementation notes

Moved out of the plugin's README, which now covers only features and installation.

## Menu rows

The official renderer binds a file link to the `file` context-menu target, and the shared menu resolves every contribution registered for it. Two contributions answer for one file:

| Contribution | Order | Rows |
| --- | --- | --- |
| `open-in-app.file` (official) | 100 | open in sidebar / open in float, reveal in the file manager, open in the default application, copy path |
| `file-link-open` (this plugin) | 200 | `Line N` heading, one row per detected editor, copy relative path |

The official rows stay the only source for "reveal in file manager" and "copy path": an earlier revision of this plugin contributed its own `fm:*` and `copy-abs` rows on the same target, and a user right-clicking a file link saw both copies. Those rows, their code (`FILE_MANAGER_IDS`, `dirnameOf`, `FileMenuDeps.reveal`) and their locale keys are gone.

## Session workspace root

A destination such as `src/a.ts` resolves against the workspace root of the Session the menu was opened in — not of "the Session on screen". The target carries `sessionId` (the official `ContextMenuTargetMap['file']` field), and the client reads `ctx.sessions.list.getSnapshot().byId[sessionId]?.cwd` at resolve time, which is exactly how the official `directory` contribution resolves its own path.

An earlier revision published that directory through a null cell in the official `conversation.session.header.utilities` slot, which made the last-rendered header win: a subagent aside or a second pane could overwrite the value for the pane the user was actually looking at. The cell, its slot registration, and the module-level variable behind it were removed.

## Line support

A markdown file link may name a line — `[source](src/a.ts#L24)`, or the range form `#L24-L30`. Those links open the editor **at that line**, and the menu shows a `Line 24` heading so the target is visible before anything launches.

| App | Launched as |
| --- | --- |
| VS Code, VS Code Insiders, Cursor | `--goto <file>:24` |
| Zed, Sublime Text | `<file>:24` |
| IntelliJ, PyCharm, WebStorm, PhpStorm, GoLand, Rider, RustRover | `--line 24 <file>` |
| Android Studio, Windsurf, and any app with no known line flag | opens at the top of the file |
| macOS bundle launches (`open -a …`) | opens at the top of the file |

Copying always yields the bare path, never `#L24`, so a pasted path still works in a terminal, a script, or another editor.

The official renderer hands a file link's path and line to the context menu as the `file` target (`{ sessionId, path, line? }`), so this plugin reads both from the target it is asked to resolve and never inspects the DOM. A link that carries no line opens at the top of the file.

## Window reuse

Opening a file **reuses the window that is already open** instead of spawning a new one. This is not line-specific: the official catalog launches VS Code and its forks with no window flag, and their CLI default is a new window, so every open took a fresh window before.

| App | Switch appended |
| --- | --- |
| VS Code, VS Code Insiders, Cursor | `--reuse-window` |
| Zed | `--existing` (Zed's own `-r/--reuse` *replaces* the workspace, so it is not used) |
| IntelliJ, PyCharm, WebStorm, PhpStorm, GoLand, Rider, RustRover | none needed — the launcher hands the file to the running IDE |
| Sublime Text | none needed — `subl` adds to the last active window |
| Android Studio, Windsurf | no documented switch, so they keep opening a window |
| macOS bundle launches (`open -a …`) | none needed — macOS routes the document to the running app |

A file link therefore lands in the editor you already have open, and a `#L24` link lands there at line 24.

## Path helpers

`src/client/actions.ts` carries two browser-safe helpers copied from `@deepseek-ai/dsh-util-workspace-path` (0.2.2-rc.2), renamed so no reader mistakes them for the official exports:

- `resolveAgainstCwd` mirrors the official `resolveWorkspacePath`, including its choice of the root's own separator and its dropping of leading `./` segments.
- `relativeToCwd` mirrors the official `relativizeToCwd` **but is deliberately more tolerant**: it compares the two strings with the same separator normalization `fileAddressFor` applies, so a Session whose root is recorded as `/work/demo` still relativizes a Windows-spelled `/work\demo\src\a.ts`. Case and drive letters are *not* folded. `tests/actions.spec.ts` pins both directions: the tolerant cases are asserted to disagree with a reproduction of the official body, so the difference stays deliberate rather than accidental drift.

## Failed probe rounds are retried

The two probes (official `GET open-in-app/apps` and this plugin's `GET /api/file-link-open/info`) are read once per plugin life while they answer, and concurrent openings share one round. A round in which either route failed — or an opening dismissed while its round was still running — clears the memo, so the next right-click asks again instead of offering only the copy row until the page reloads.

## How it works

| Half | File | Runtime |
| --- | --- | --- |
| Host | `lib/index.js` | Node — Cordis loader. Registers `GET /api/file-link-open/info` (this plugin's own local resolution report) and `POST /api/file-link-open/launch`, both behind the official `connection` trust fence with bounded JSON bodies, absolute-path/existence validation, and an optional validated `line`. Both route paths live in `src/routes.ts` in the two forms the official `.../shared` module uses: the absolute pathname the Host registers beside the document-relative one the browser addresses. A request naming a `line` rewrites the resolved launcher's argv into that editor's line-selection spelling, and every request appends that editor's own window-reuse switch; launchers this plugin must not extend (macOS `open -a`, file managers) launch unchanged. |
| Client | `lib/client.js` | Browser — dsh client module system. One contribution to the official file context menu (`ctx.contextMenus.register({ id, target: 'file', order: 200, resolve })`): the rows are built from the clicked target plus two probes — the official `GET open-in-app/apps` list and this plugin's own `GET /api/file-link-open/info` — and an editor appears only where **both** verify it. Row icons come from a keyed `contextMenu.icon` entry; the clicked Session's `cwd` comes from `ctx.sessions` (`inject: ['locale', 'slots', 'contextMenus', 'sessions']`). A failed open or copy rejects, so the shared menu reports it in its own failure feedback. The editor whitelist and the official route constants are imported, never copied, and each `app.<id>` label is pinned to the id by a template-literal key — an id added without a label is a compile error. |

## Verify

After minting a session cookie from the startup URL,

```sh
curl -s -b /tmp/dsh-cookies.txt http://127.0.0.1:3080/api/file-link-open/info   # JSON = registered; 404 "not found" = not registered
```

## Development

```sh
pnpm test             # unit specs: row set, launch argv, wire and official contracts
pnpm test --coverage  # the same specs, with per-file 100% thresholds on the two pure modules
pnpm typecheck
pnpm build
```

## Known limitations

- The rows need a DSH whose markdown file links bind the official `file` context-menu target (**`0.2.2-rc.2` or newer**). On an older renderer the target never reaches a contribution, so the official menu opens without them.
- The menu resolves a contribution inside the official timeout (1 s by default). The contribution waits up to 300 ms for its two probes inside that window and then returns the rows those probes support, so a slow Host costs first-row latency, never a stuck menu.
- On macOS every editor resolves to `open -a <bundle>`, which takes no line option, so links there always open at the top. Editing the official catalog to carry a per-platform line form is the follow-up.
- Android Studio (`studio64.exe`) has no documented line flag and opens at the top.
- A line past the end of the file is not checked (that would need a file read); the editor clamps it.
- File links outside the conversation flow resolve relative paths against no root, so the absolute path is the authored one.
- Touch devices have no right-click; no long-press fallback is provided in this reduced implementation.
