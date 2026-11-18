# @banzhe/dsh-picker-browse

The in-app Select Workspace Directory dialog, with a row of drive letters in its header.

[中文版](./README.zh-CN.md)

A Web Client [DSH](https://github.com/deepseek-ai/deepseek-harness) Bundle for the **web** profile. It replaces the shipped `@deepseek-ai/dsh-client-ui-directory-picker-browse` row, so enable one or the other.

## Features

- Fills both directory-flow holes the Workspace UI declares (`sidebar.workspaces.directoryFlow` and `conversation.hero.workspace.directoryFlow`), including when either declaration arrives after this plugin activates.
- The whole shipped dialog: 680×500 Miller columns, the breadcrumb and click-to-edit path zone, prefix filtering from the typed tail, the nested New folder dialog, the show-hidden toggle, and the loading, truncated, and error surfaces.
- **Drive row (this fork’s addition).** On a Host whose paths are Windows paths, the header carries one button per drive letter that Host can list. Every candidate `C:\` through `Z:\` is probed in parallel when the dialog opens; a letter with no readable drive behind it is dropped silently, so no button ever points at a directory the Host cannot open. Pressing a drive navigates to that root — the same landing a typed `F:\` and Enter reach — and the drive holding the current level is marked. The row wraps instead of scrolling, so a Host with many drives never pushes the path bar out of the card.
- A POSIX Host never sees the row: the probe is gated on the separator the Host itself stamps into its home path, so a remote Linux or macOS Host pays nothing for it.
- Dialog copy, including the drive row’s group label and per-button accessible names, ships in the Bundle’s own `directory-browser` locale namespace in all eight shipped languages.

## Install

### From npm

```sh
dsh plugin --profile web add @banzhe/dsh-picker-browse
```

### From a local checkout

```sh
pnpm install
pnpm --filter @banzhe/dsh-picker-browse build
dsh plugin --profile web add ./plugins/picker-browse
```

Either route needs the Host backend row `@deepseek-ai/dsh-host-directory-picker-browse` to stay enabled, and the shipped `@deepseek-ai/dsh-client-ui-directory-picker-browse` row to be off. The Bundle’s own patch does the second part for a profile that mounts this Bundle as a bundle. Requires a `dsh web` restart. Rebuild `lib/` after later source changes and refresh the GUI; do not assume HMR.

Remove with:

```sh
dsh plugin --profile web remove @banzhe/dsh-picker-browse
```

## Docs

Implementation notes, the fork’s adaptations, and known limitations: [`docs/plugins/picker-browse.md`](https://github.com/banzhe/dsh-plugins/blob/master/docs/plugins/picker-browse.md).

## Credits

Forked from `@deepseek-ai/dsh-client-ui-directory-picker-browse` in [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (MIT © DeepSeek). The dialog, its behaviour, its styles, its specs, and its copy are that package’s work; the drive row and the adaptations listed in the implementation notes are this Bundle’s.

## License

MIT
