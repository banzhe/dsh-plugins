# @banzhe/dsh-sidebar-menu-actions

Sidebar row-menu extensions: copy a Workspace path, open a Workspace in VS Code or in the OS file browser.

[中文版](./README.zh-CN.md)

A Web Client [DSH](https://github.com/deepseek-ai/deepseek-harness) Bundle for the **web** profile.

## Features

- Adds **Open in VS Code** (`在 VS Code 中打开`), **Open in File Browser** (`在文件浏览器中打开`), and **Copy workspace path** (`复制工作区路径`) to the Workspace "..." menu through the official context-menu registry — between rename and the danger delete row — so the shared popup owns its positioning, keyboard walk, focus return, and dismissal.
- **Copy workspace path** writes the Workspace's absolute directory to the clipboard and shows a toast.
- **Open in VS Code** POSTs the open-in-app Host route (`{app:'vscode', path:<workspace dir>}`). The row exists only after `GET open-in-app/apps` resolves `vscode` (provided by the `dsh-web-app` bundle); otherwise that one row stays out and one console line says why.
- **Open in File Browser** is **Windows-only**: it POSTs the same route with `{app:'explorer', path:<workspace dir>}`, and the official catalog declares `explorer` on win32 alone, so the row appears only on a Windows Host. It launches through the OS's open verb, which honors whichever file browser you have configured as the default — not a hard-coded `explorer.exe`.
- The directory is read when you pick a row, so a Workspace that has since been removed launches and copies nothing.
- Failures keep their detail: one toast shows the HTTP status or error message, and a refused clipboard write says so.
- Labels and notices follow the app locale (`menu-actions` namespace, zh/en).

## Install

### From npm

```sh
dsh plugin --profile web add @banzhe/dsh-sidebar-menu-actions
```

### From a local checkout

```sh
pnpm install
pnpm --filter @banzhe/dsh-sidebar-menu-actions build
dsh plugin --profile web add ./plugins/sidebar-menu-actions
```

Requires a `dsh web` restart. Rebuild `lib/` after later source changes and refresh the GUI; do not assume HMR.

Remove with:

```sh
dsh plugin --profile web remove @banzhe/dsh-sidebar-menu-actions
```

## Docs

Implementation notes: [`docs/plugins/sidebar-menu-actions.md`](https://github.com/banzhe/dsh-plugins/blob/master/docs/plugins/sidebar-menu-actions.md).
