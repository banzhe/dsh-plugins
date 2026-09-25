# @banzhe/dsh-file-link-open

**Right-click any file link in the DSH Web conversation to open it in your editor or file manager, or copy its path.**

A dual-sided [DSH](https://github.com/deepseek-ai/deepseek-harness) Bundle for the **web** profile. Right-clicking a file link rendered inside a session message (file mention or markdown file link) opens a menu at the cursor:

- 🚀 **Open in a detected editor/IDE** — VS Code, Cursor, Sublime Text, the JetBrains suite, etc., each with its real app icon. App detection and launch reuse the official `open-in-app` resolver (macOS `.app` bundles, Windows `App Paths` registry / Uninstall records / `%ProgramFiles%` scans, Linux PATH names and desktop entries).
- 📂 **Open the containing folder in the platform file manager** — Finder (macOS) / File Explorer (Windows) / the desktop file manager (Linux), launched through the official `POST /open-in-app/open` route with the file's directory — the exact call the session-header split button makes.
- 📋 **Copy relative path / copy absolute path** — one click, purely browser-side, always the bare path.

Relative paths resolve against the currently viewed session's working directory. The official left-click preview behavior is untouched.

### Line support

A markdown file link may name a line — `[source](src/a.ts#L24)`, or the range form `#L24-L30`. Those links open the editor **at that line**, and the menu shows a `Line 24` heading so the target is visible before anything launches.

| App | Launched as |
| --- | --- |
| VS Code, VS Code Insiders, Cursor | `--goto <file>:24` |
| Zed, Sublime Text | `<file>:24` |
| IntelliJ, PyCharm, WebStorm, PhpStorm, GoLand, Rider, RustRover | `--line 24 <file>` |
| Android Studio, Windsurf, and any app with no known line flag | opens at the top of the file |
| macOS bundle launches (`open -a …`) | opens at the top of the file |

Copying always yields the bare path, never `#L24`, so a pasted path still works in a terminal, a script, or another editor.

The official renderer consumes the line inside its own component and never writes it to an attribute, so the line is recovered from the link button's React fiber (bounded to 6 hops, matched by the button's own `title`). Since DSH `0.1.7-rc.2` the path is read from that same fiber prop as well: the built `MarkdownFileLink` writes `title={src === undefined ? file.path : undefined}`, so a glyph-rendered link whose path classifies as an image carries **no** `title` once the inline preview resolves. A title-less button resolves its path from the component named `MarkdownFileLink` — never from whichever ancestor happens to hold a `file` prop, which would launch a card's path instead. This is the trade recorded in [`docs/adr/0004`](../../docs/adr/0004-session-id-from-react-fiber.md) and now [`docs/adr/0005`](../../docs/adr/0005-file-link-line-from-react-fiber.md): a React or DSH change that moves it degrades to "opens at the top of the file" rather than to a wrong launch.

### Window reuse

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

## How it works

| Half | File | Runtime |
| --- | --- | --- |
| Host | `lib/index.js` | Node — Cordis loader. Registers `GET /api/file-link-open/info` (capability + local resolution report) and `POST /api/file-link-open/launch`, both behind the official `connection` trust fence with bounded JSON bodies, absolute-path/existence validation, and an optional validated `line`. A request naming a `line` rewrites the resolved launcher's argv into that editor's line-selection spelling, and every request appends that editor's own window-reuse switch; launchers this plugin must not extend (macOS `open -a`, file managers) launch unchanged. |
| Client | `lib/client.js` | Browser — dsh client module system. Document-level `contextmenu` delegation matching the official file-link buttons (`button[class*="fileMention"]:not([data-ref-chip])`); the viewed session's `cwd` is published by a null cell in the official `conversation.session.header.utilities` slot. The link's path and line both come from the button's React fiber (`title` first, then the `MarkdownFileLink` component). An editor appears only when **both** the official probe **and** this plugin's own resolution verified it, so a version skew can never produce a "menu shows it, click 400s" failure. |

## Install

```sh
dsh plugin --profile web add ./plugins/file-link-open
```

Then restart `dsh web` and hard-refresh the browser page.

The **host** half is loaded once at activation, so a rebuild needs a `dsh web` restart. The **client** half is served from disk, so a page refresh picks it up while the HMR watcher is running.

Verify (optional): after minting a session cookie from the startup URL,

```sh
curl -s -b /tmp/dsh-cookies.txt http://127.0.0.1:3080/api/file-link-open/info   # JSON = registered; 404 "not found" = not registered
```

## Development

```sh
pnpm test             # unit specs: line-argv table, fiber walk, wire and official contracts
pnpm test --coverage  # the same specs, with per-file 100% thresholds on the two pure modules
pnpm typecheck
pnpm build
```

## Known limitations

- The right-click menu depends on the official file-link DOM shape (the `fileMention` hash class). A right-click on a link with no `title` resolves its path from the component named `MarkdownFileLink` in the React fiber; a dsh upgrade that renames or re-shapes that component makes those links (and any `[title]`-less link) silently fall back to the native context menu.
- The link's **line** additionally depends on the official component keeping `file` on its props; a React or dsh change that moves it degrades to opening at the top of the file, never to a wrong launch. `tests/official-renderer-contract.spec.ts` asserts this against the installed renderer.
- On macOS every editor resolves to `open -a <bundle>`, which takes no line option, so links there always open at the top. Editing the official catalog to carry a per-platform line form is the follow-up.
- Android Studio (`studio64.exe`) has no documented line flag and opens at the top.
- A line past the end of the file is not checked (that would need a file read); the editor clamps it.
- File links outside the conversation flow resolve relative paths against the currently viewed session's `cwd`.
- Touch devices have no right-click; no long-press fallback is provided in this reduced implementation.

## Credits

This implementation is derived from [cholf5/dsh-plugin-file-actions](https://github.com/cholf5/dsh-plugin-file-actions) (MIT © cholf5), reduced to the file-link right-click open actions.

## License

MIT