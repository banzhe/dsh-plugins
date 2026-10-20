# @banzhe/dsh-file-link-open

Right-click any file link in the DSH Web conversation to open it in your editor or file manager, or copy its path.

[中文版](./README.zh-CN.md)

A dual-sided [DSH](https://github.com/deepseek-ai/deepseek-harness) Bundle for the **web** profile.

## Features

Right-clicking a file link rendered inside a session message (file mention or markdown file link) opens a menu at the cursor:

- 🚀 **Open in a detected editor/IDE** — VS Code, Cursor, Sublime Text, the JetBrains suite, and others, each with its real app icon. App detection and launch reuse the official `open-in-app` resolver (macOS `.app` bundles, Windows `App Paths` registry / Uninstall records / `%ProgramFiles%` scans, Linux PATH names and desktop entries).
- 📂 **Open the containing folder in the platform file manager** — Finder (macOS) / File Explorer (Windows) / the desktop file manager (Linux), through the official `POST /open-in-app/open` route.
- 📋 **Copy relative path / copy absolute path** — one click, purely browser-side, always the bare path.

Relative paths resolve against the currently viewed session's working directory. The official left-click preview behavior is untouched.

- A markdown file link that names a line — `[source](src/a.ts#L24)` or the range form `#L24-L30` — opens the editor **at that line**, and the menu shows a `Line 24` heading so the target is visible before anything launches.
- Opening a file **reuses the window that is already open** instead of spawning a new one.
- An editor appears in the menu only when **both** the official probe **and** this plugin's own resolution verified it, so a version skew can never produce a "menu shows it, click 400s" failure.

## Install

### From npm

```sh
dsh plugin --profile web add @banzhe/dsh-file-link-open
```

### From a local checkout

```sh
pnpm install
pnpm --filter @banzhe/dsh-file-link-open build
dsh plugin --profile web add ./plugins/file-link-open
```

Then restart `dsh web` and hard-refresh the browser page. The **host** half is loaded once at activation, so a rebuild needs a `dsh web` restart. The **client** half is served from disk, so a page refresh picks it up while the HMR watcher is running.

Remove with:

```sh
dsh plugin --profile web remove @banzhe/dsh-file-link-open
```

## Docs

Implementation notes: [`docs/plugins/file-link-open.md`](https://github.com/banzhe/dsh-plugins/blob/master/docs/plugins/file-link-open.md).

## Credits

This implementation is derived from [cholf5/dsh-plugin-file-actions](https://github.com/cholf5/dsh-plugin-file-actions) (MIT © cholf5), reduced to the file-link right-click open actions.

## License

MIT
