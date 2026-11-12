# @banzhe/dsh-file-link-open

Right-click any file link in the DSH Web conversation to open it in your editor or copy its workspace-relative path.

[中文版](./README.zh-CN.md)

A dual-sided [DSH](https://github.com/deepseek-ai/deepseek-harness) Bundle for the **web** profile.

## Features

Right-clicking a file link rendered inside a session message (file mention or markdown file link) opens the official DSH context menu at the cursor, with these rows added to the ones DSH already offers for a file:

- 🚀 **Open in a detected editor/IDE** — VS Code, Cursor, Sublime Text, the JetBrains suite, and others, each with its real app icon. App detection and launch reuse the official `open-in-app` resolver (macOS `.app` bundles, Windows `App Paths` registry / Uninstall records / `%ProgramFiles%` scans, Linux PATH names and desktop entries).
- 📋 **Copy relative path** — one click, purely browser-side, always the bare workspace-relative path.

DSH's own rows for the same file — open in sidebar or float, reveal in the file manager, open in the default application, copy absolute path — are left alone. This plugin adds only what they do not cover, so nothing appears twice.

Relative paths resolve against the **clicked Session's** working directory, taken from the target the menu was opened on, so two panes showing different workspaces each resolve their own.

- A markdown file link that names a line — `[source](src/a.ts#L24)` or the range form `#L24-L30` — opens the editor **at that line**, and the menu shows a `Line 24` heading so the target is visible before anything launches.
- Opening a file **reuses the window that is already open** instead of spawning a new one.
- An editor appears in the menu only when **both** the official probe **and** this plugin's own resolution verified it, so a version skew can never produce a "menu shows it, click 400s" failure.
- A failed open or copy is reported by the official menu's own failure feedback instead of only the console.
- A probe round that failed is retried on the next right-click instead of degrading to the copy row until the page reloads.
- Requires a DSH whose markdown file links bind the official `file` context-menu target — **DSH `0.2.2-rc.2` or newer**. On an older renderer (including the published `0.2.1-alpha.2` packages) the target never reaches a contribution, so the official menu opens without these rows.

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
