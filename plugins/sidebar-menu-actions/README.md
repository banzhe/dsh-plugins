# @banzhe/dsh-sidebar-menu-actions

Sidebar row-menu extensions: copy a Workspace path, open a Workspace in VS Code or in the OS file browser.

[中文版](./README.zh-CN.md)

A Web Client [DSH](https://github.com/deepseek-ai/deepseek-harness) Bundle for the **web** profile.

## Features

- Grafts **Open in VS Code** (`在 VS Code 中打开`), **Open in File Browser** (`在文件浏览器中打开`), and **Copy workspace path** (`复制工作区路径`) into the Workspace "..." menu, inserted between rename and the danger delete row.
- **Copy workspace path** writes the Workspace's absolute directory to the clipboard and shows a toast.
- **Open in VS Code** POSTs the open-in-app Host route (`{app:'vscode', path:<workspace dir>}`). It is added only after `GET open-in-app/apps` resolves `vscode` (provided by the `dsh-web-app` bundle); otherwise that one row stays out and one console line says why.
- **Open in File Browser** is **Windows-only**: it POSTs the same route with `{app:'explorer', path:<workspace dir>}`, and the official catalog declares `explorer` on win32 alone, so the row appears only on a Windows Host. It launches through the OS's open verb, which honors whichever file browser you have configured as the default — not a hard-coded `explorer.exe`.
- Every row closes the menu through the Menu primitive's Escape path, so focus return matches a shipped row.
- A stale arm from a cancelled press never reaches a Session row's menu.
- Failures show a toast with the HTTP status or error message, after the menu has closed.
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
