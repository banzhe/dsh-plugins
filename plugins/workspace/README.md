# @banzhe/dsh-workspace

The sidebar's Workspace browsing region and the Session hero's Workspace picker, delivered as one Bundle that **replaces** the shipped `ui-workspace` row.

[中文版](./README.zh-CN.md)

A Web Client [DSH](https://github.com/deepseek-ai/deepseek-harness) Bundle for the **web** profile.

## What it contributes

- `sidebar.workspaces` — the whole browsing region: section header, search, grouped/flat Session rows, the "Show more" watermark, Workspace dialogs, and the Session row's leading/trailing/hover seats.
- `conversation.hero.workspace` — the picker in the blank-Session hero and the New Session view.
- The `uiWorkspace` client service, the `useWorkspaces` / `useWorkspaceAccess` root hooks, the `workspace` locale namespace, and the navigation shortcuts (new session, session search, add workspace, rename, fork, archive).
- Its own `cordis.patch.yml` disables the shipped `ui-workspace` row and inserts this Bundle as `workspace-personal`. Exactly one row may own those slots and the `uiWorkspace` service, so the two are never active together.

Behaviour is a fork of the shipped plugin at DSH `0.2.2-rc.2`; `ui-schedule`, `ui-open-in-app`, the directory pickers, `ui-context-menu` and this workspace's other Bundles keep contributing through the same slot declarations.

## Install

npm:

```sh
dsh plugin --profile web add @banzhe/dsh-workspace
```

Local checkout (the Bundle's `dsh.bundle` patch is what replaces the shipped row):

```sh
pnpm install
pnpm --filter @banzhe/dsh-workspace build
dsh plugin --profile web add link:$(pwd)/plugins/workspace
```

Remove:

```sh
dsh plugin --profile web remove @banzhe/dsh-workspace
```

Rebuild after a source change and restart `dsh web`: the profile's client modules are read from `lib/`, and no client HMR watches this directory.

## Credits

Forked from `@deepseek-ai/dsh-client-ui-workspace` in [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) (`packages/client/ui-workspace`), MIT, copyright DeepSeek.

## License

MIT
