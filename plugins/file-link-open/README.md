# @banzhe/dsh-file-link-open

**Right-click any file link in the DSH Web conversation to open it in your editor or file manager, or copy its path.**

A dual-sided [DSH](https://github.com/deepseek-ai/deepseek-harness) Bundle for the **web** profile. Right-clicking a file link rendered inside a session message (file mention or markdown file link) opens a menu at the cursor:

- 🚀 **Open in a detected editor/IDE** — VS Code, Cursor, Sublime Text, the JetBrains suite, etc., each with its real app icon. App detection and launch reuse the official `open-in-app` resolver (macOS `.app` bundles, Windows `App Paths` registry / Uninstall records / `%ProgramFiles%` scans, Linux PATH names and desktop entries).
- 📂 **Open the containing folder in the platform file manager** — Finder (macOS) / File Explorer (Windows) / the desktop file manager (Linux), launched through the official `POST /open-in-app/open` route with the file's directory — the exact call the session-header split button makes.
- 📋 **Copy relative path / copy absolute path** — one click, purely browser-side.

Relative paths resolve against the currently viewed session's working directory. The official left-click preview behavior is untouched.

## How it works

| Half | File | Runtime |
| --- | --- | --- |
| Host | `lib/index.js` | Node — Cordis loader. Registers `GET /api/file-link-open/info` (capability + local resolution report) and `POST /api/file-link-open/launch`, both behind the official `connection` trust fence with bounded JSON bodies and absolute-path/existence validation. |
| Client | `lib/client.js` | Browser — dsh client module system. Document-level `contextmenu` delegation matching the official file-link buttons (`button[class*="fileMention"][title]:not([data-ref-chip])`); the viewed session's `cwd` is published by a null cell in the official `conversation.session.header.utilities` slot. An editor appears only when **both** the official probe **and** this plugin's own resolution verified it, so a version skew can never produce a "menu shows it, click 400s" failure. |

## Install

```sh
dsh plugin --profile web add ./plugins/file-link-open
```

Then restart `dsh web` and hard-refresh the browser page.

Verify (optional): after minting a session cookie from the startup URL,

```sh
curl -s -b /tmp/dsh-cookies.txt http://127.0.0.1:3080/api/file-link-open/info   # JSON = registered; 404 "not found" = not registered
```

## Known limitations

- The right-click menu depends on the official file-link DOM shape (`fileMention` hash class with the path in `title`); a dsh upgrade that changes it makes the menu silently fall back to the native context menu.
- File links outside the conversation flow resolve relative paths against the currently viewed session's `cwd`.
- Touch devices have no right-click; no long-press fallback is provided in this reduced implementation.

## Credits

This implementation is derived from [cholf5/dsh-plugin-file-actions](https://github.com/cholf5/dsh-plugin-file-actions) (MIT © cholf5), reduced to the file-link right-click open actions.

## License

MIT