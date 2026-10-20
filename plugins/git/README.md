# @banzhe/dsh-git

A Git panel in the right sidebar: the session workspace's changed files as a folder tree, committed with the message you type.

[中文版](./README.zh-CN.md)

A dual-sided [DSH](https://github.com/deepseek-ai/deepseek-harness) Bundle for the **web** profile.

## Features

- A page tab (`kind: git`) in the right sidebar, with a guide entry.
- Lists the current session workspace's changed files as a folder tree, with per-file status.
- Commits the workspace with the message typed into the field.
- Drafts that message from the change context with the session's own model.
- Serves only a workspace the profile has registered: the requested `cwd` must be absolute and must resolve through the workspace registry. A missing path and an unregistered directory are the same `404`.
- Does not open a file's diff.

## Install

### From npm

```sh
dsh plugin --profile web add @banzhe/dsh-git
```

### From a local checkout

```sh
pnpm install
pnpm --filter @banzhe/dsh-git build
dsh plugin --profile web add ./plugins/git
```

Then restart `dsh web`. The Client half hot-reloads when a watcher rewrites `lib/client.js`; host changes still need a restart. Rebuild `lib/` after source changes.

Remove with:

```sh
dsh plugin --profile web remove @banzhe/dsh-git
```

## Docs

Implementation notes: [`docs/plugins/git.md`](https://github.com/banzhe/dsh-plugins/blob/master/docs/plugins/git.md).
