# @banzhe/dsh-workbench

The sidebar's Workspace browsing region, the Session hero's Workspace picker, and the foldable browsing groups that lead the list, delivered as one Bundle that **replaces** the shipped `ui-workspace` row.

[中文版](./README.zh-CN.md)

A Web Client [DSH](https://github.com/deepseek-ai/deepseek-harness) Bundle for the **web** profile.

## What it contributes

- `sidebar.workspaces` — the whole browsing region: the unread/pinned/running folds, section header, search, the grouped/flat Session tree as the fourth fold, the "Show more" watermark, Workspace dialogs, and the Session row's leading/trailing/hover seats.
- `conversation.hero.workspace` — the picker in the blank-Session hero and the New Session view.
- The `uiWorkspace` client service, the `useWorkspaces` / `useWorkspaceAccess` root hooks, the `workspace` locale namespace, and the navigation shortcuts (new session, session search, add workspace, rename, fork, archive).
- **Browsing folds** — the list is four independent, collapsible groups: **Unread** (finished-unread Sessions with no pin), **Pinned** (every pinned Session, whatever its work state), **Running** (unpinned Sessions running themselves or over running subagent work), and the browsing list itself — **All workspaces**, or **All sessions** in the one-list view — always last, open by default, and folded without losing its "Show more" state, group expansion or scroll position. A pinned Session lists only under Pinned, and its dot still reports its real state, running, finished-unread or waiting on the user, so a group never stands in for the state. Subagent Sessions take no row of their own, at any depth: delegated work reaches the region through the lead Session that spawned it, which carries the running dot. A quick group's rows are the browsing list's own rows — the same status dots, one-at-a-time hover cards, row menu, hover actions, pin mark, rename and relative time, with reordering left to the tree. Each quick group's header carries its count, and the region draws no title or total above the folds: an empty quick group renders no fold, while the browsing list's fold always renders. It persists nothing and refreshes nothing: opening a row goes through the workspace owner's navigation, which is what clears an unread finish, and the rows' actions are the same slot entries the tree uses. In the desktop shell the same model drives the Windows taskbar pulse: indeterminate while Sessions run and nothing is waiting on the user or finished-unread, cleared otherwise, and a pinned Session at rest is not a notification; a browser is inert. This is where the retired `@banzhe/dsh-session-attention` panel's content now lives.
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

The In work model is adapted from the `session-attention` Bundle this repository carried until it was retired (MIT); its last source is in git history.

## License

MIT
