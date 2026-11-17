# @banzhe/dsh-workbench

The sidebar's Workspace browsing region, the Session hero's Workspace picker, and the In work region that leads the list, delivered as one Bundle that **replaces** the shipped `ui-workspace` row.

[中文版](./README.zh-CN.md)

A Web Client [DSH](https://github.com/deepseek-ai/deepseek-harness) Bundle for the **web** profile.

## What it contributes

- `sidebar.workspaces` — the whole browsing region: the In work region, section header, search, grouped/flat Session rows, the "Show more" watermark, Workspace dialogs, and the Session row's leading/trailing/hover seats.
- `conversation.hero.workspace` — the picker in the blank-Session hero and the New Session view.
- The `uiWorkspace` client service, the `useWorkspaces` / `useWorkspaceAccess` root hooks, the `workspace` locale namespace, and the navigation shortcuts (new session, session search, add workspace, rename, fork, archive).
- **In work** — a block above the list with two independent, collapsible groups: **Running** (every Session with live work, pinned or not) and **Unread** (finished-unread Sessions plus pinned Sessions with no running work). A Session lists once: pinned running work stays in Running, and pinned unread or idle work stays in Unread. Each group header carries its own count, and the region draws no title or total above them: an empty group renders no fold, and with both groups empty the region renders nothing. It persists nothing and refreshes nothing: opening a row goes through the workspace owner's navigation, which is what clears an unread finish, and the only write is releasing a pin. This is where the retired `@banzhe/dsh-session-attention` panel's content now lives.
- Its own `cordis.patch.yml` disables the shipped `ui-workspace` row and inserts this Bundle as `workbench-personal`. Exactly one row may own those slots and the `uiWorkspace` service, so the two are never active together.

Behaviour is a fork of the shipped plugin at DSH `0.2.2-rc.2`; `ui-schedule`, `ui-open-in-app`, the directory pickers, `ui-context-menu` and this workspace's other Bundles keep contributing through the same slot declarations.

## Install

npm:

```sh
dsh plugin --profile web add @banzhe/dsh-workbench
```

Local checkout (the Bundle's `dsh.bundle` patch is what replaces the shipped row):

```sh
pnpm install
pnpm --filter @banzhe/dsh-workbench build
dsh plugin --profile web add link:$(pwd)/plugins/workbench
```

Remove:

```sh
dsh plugin --profile web remove @banzhe/dsh-workbench
```

Rebuild after a source change and restart `dsh web`: the profile's client modules are read from `lib/`, and no client HMR watches this directory.

## Credits

The workspace browsing region and picker are forked from `@deepseek-ai/dsh-client-ui-workspace` in [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) (`packages/client/ui-workspace`), MIT, copyright DeepSeek.

The In work model is adapted from `plugins/session-attention` in this repository (MIT).

## License

MIT
