# @banzhe/dsh-sidebar-menu-actions

Sidebar row-menu extensions: open a Workspace in VS Code.

[中文版](./README.zh-CN.md)

A Web Client [DSH](https://github.com/deepseek-ai/deepseek-harness) Bundle for the **web** profile.

## Features

- Grafts **Open in VS Code** (`在 VS Code 中打开`) into the Workspace "..." menu, inserted between rename and the danger delete row.
- Clicking it POSTs the open-in-app Host route (`{app:'vscode', path:<workspace dir>}`) and closes the menu through the Menu primitive's Escape path.
- Armed only after `GET open-in-app/apps` resolves `vscode` (provided by the `dsh-web-app` bundle); otherwise the menu renders exactly as shipped and one console line says why.
- A stale arm from a cancelled press never reaches a Session row's menu.
- Launch failures show a toast with the HTTP status or error message, after the menu has closed.
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
