# workbench

`@banzhe/dsh-workbench` — Bundle `plugins/workbench`, loader row `workbench-personal`, replaces the shipped `ui-workspace`.

## Why a fork

The sidebar's Workspace region and the hero picker are one Client plugin upstream, and every part of it is public surface this workspace wants to change freely: the browsing tree, the row seats, the Session menu adapter, the picker flow, the `workspace` copy. Contributing through slots cannot reach any of it — the plugin owns those slots and the `uiWorkspace` service — so the choice is fork or nothing. The Bundle name is `workbench` rather than `workspace` because it now owns more than the Workspace browser, and the name is where future sidebar surfaces land.

## The replacement is one patch

`cordis.patch.yml`:

```yaml
- id: ui-workspace
  disabled: true
- insert:
    - id: workbench-personal
      name: '@banzhe/dsh-workbench'
```

The Bundle layer applies after `@deepseek-ai/dsh-web-app`, which declares `ui-workspace`, so the disable hits an existing row. Both rows declare `sidebar.workspaces` and `conversation.hero.workspace` and both provide the `uiWorkspace` service; the slot registry rejects a second declaration and Cordis rejects a second provider, so leaving the shipped row enabled fails at load rather than rendering twice.

## In work

The first block of the browsing list — under the section toolbar (search, view options, add workspace) and above the workspace rows, scrolling with them — is **In work**: three independent, collapsible groups, **Unread**, **Pinned** and **Running**, plus the amber marker for a turn blocked on the user. A search replaces the whole list body, so the region steps aside with it.

The block carries no title of its own and no total: each fold's header names its group and counts that group, so there is nothing above the quick headers to read. The Running and Unread headers always render, at 0 while those groups are empty; the Pinned fold renders only while something is pinned. There is no empty frame and no "nothing in work" line.

**Where the data comes from.** Three sources other plugins already own, and nothing else:

| Fact | Owner |
|---|---|
| row order, titles, `running`, `blank`, `origin`, `updatedAt` | `ctx.sessions.list` |
| `running`, `completionUnread`, `pendingInteraction` | `ctx.uiSession.sessionStatus` |
| `archivedSessionIds`, `pinnedSessionIds` | `ctx.workspaces.list` |

The store folds those three snapshots into one model and publishes it through the browsing entry's `hooks` compartment, so the component subscribes through the renderer rather than owning a subscription. It writes nothing: there is no unread bookkeeping, no second projection refresh, and no read-receipt request. Opening a row calls the same `openSession` the tree rows call — selecting the Session as the main view is what makes `ui-session` clear its completion flag — and the only Host write is `unpinSession`, the same call the row's pin button issues.

**What lists, and why.** Every row is a top-level Session. A subagent Session takes no row of its own and nests nowhere, at any depth: `origin` on the Session list row is what marks it, the same field the browsing rows filter on. Delegated work therefore reaches the region through its lead — a Session with running subagent descendants below it lists under Running, which is what makes that row spin while a child works. The blank New-Session placeholder and archived Sessions never list. Running outranks a finish reminder: a Session whose work is still in flight lists as running even if a completion flag is set.

**One row per Session, in three groups.** Running holds every Session with live work of its own or below it, pinned or not. Unread holds every Session finished while unread, pinned or not. Pinned holds the pinned Sessions left once neither applies: a quiet pin is a container row with no live work. The state leads and the pin follows it — a pinned Session lists under Running while it works, under Unread when it finishes unread, and returns to Pinned once both are cleared — so the pin never hides a row that needs a look, and no Session appears twice. Inside Running and Unread the pinned rows lead their group and each side stays newest first (equal timestamps keep Host list order); Pinned is newest first throughout. A blocked turn stays in its group and wears `StateDot`'s warning state instead of the group's own dot.

**Collapse.** Each group folds independently through its own header, which shows that group's visible count; the count stays in the header while the group is folded, so a folded group still says how much it holds. Running and Unread keep their headers even with no rows, reporting a count of 0, because those two are what the user scans for activity; the Pinned fold renders only while something is pinned. A group header's visible title and count name that fold, with the fold state on `aria-expanded`.

**Access.** The release control on a pinned row goes through the row actions' `useSessionAccess` gate for `workspace/unpinSession`, so a Session whose access snapshot refuses unpinning renders no button at all — the same rule the row's own pin toggle follows.

**Visibility.** Two placements are deliberate: a search query replaces the whole list body, so the region steps aside with the tree rather than competing with results; and the collapsed rail (`wide === false`) renders the region not at all. Both follow the browsing region's own visibility rule — the list is what the surface exists for — and neither is a gap to be fixed with more UI.

**Taskbar.** The Windows taskbar pulse the retired `@banzhe/dsh-session-attention` Bundle carried lives here now, projected from this same model: the desktop shell's progress indicator runs indeterminate while Sessions run and nothing is waiting on the user or finished-unread, and clears otherwise. Only transitions write, so an unrelated list update issues no platform call, and disposal retracts a live pulse. The channel is probed once at apply time: a browser, or a shell predating `window.setProgressBar`, has no write and the presenter stays inert. The elapsed-time column that panel showed is not carried — it required a per-Session projection read loop, and this Bundle issues no projection refresh.

## Retiring the old panel

The web profile no longer installs `@banzhe/dsh-session-attention`, and the Bundle itself left this repository once this fork carried its model and its taskbar pulse: the plugin directory and its implementation note are gone. Removing the Bundle, rather than disabling its row, is what takes its `shell.overlay` entry and its `cordis.patch.yml` layer with it. Its last source and tests are in git history.

## What the fork must keep identical

These are contracts other packages reach through, not local choices:

| Contract | Consumer |
|---|---|
| slots `sidebar.workspaces`, `conversation.hero.workspace`, the two `*.directoryFlow` holes | `ui-directory-picker-native`, `ui-directory-picker-browse` |
| `sidebar.session.row.leading` / `.trailing` / `.hover` | `ui-schedule` |
| `sidebar.workspaces.session.menu.item` (legacy React rows) | `ui-open-in-app` |
| `contextMenu.content` key `session`, `contextMenu.icon` | `ui-context-menu` |
| `shell.overlay` entries and the `workspace.toast` child | any overlay contributor |
| service `uiWorkspace`, root hooks `useWorkspaces` / `useWorkspaceAccess` | `app-notification` |
| `declare module` merges (`GlobalStandardProps`, `LocaleNamespaceMap.workspace`, `SessionReferenceSourceMap.workspaceOperation`) | type-only imports in the Bundles above |

## Build and runtime notes

- Built with `@banzhe/dsh-devkit`'s `clientBundle`, so the shell's module table is external and everything else is inlined: `@deepseek-ai/dsh-util-values`, `@deepseek-ai/dsh-util-workspace-path`, `@deepseek-ai/dsh-api-workspace-controller/default-workspace` and `clsx` are private copies. All four are stateless; `default-workspace` documents inlining as its intended client path.
- The `dsh.client.inject` list is informational (preflight and HMR), not activation order; each registration still waits on the real slot declaration through `slots.inject`. The In work region's own dependency is the `uiSession` service, declared in the plugin's `inject`.
- The browser half is one `lib/client.js` registered through `window.__ModuleLoader__.load({ id: '@banzhe/dsh-workbench' })`. A named import that keeps only `type` specifiers under `verbatimModuleSyntax` still emits a bare side-effect import, which is how a published dynamic client module can end up nested inside this bundle; keep those imports as `import type`.

## Known limitations and deferred work

- The fork tracks upstream by hand. `packages/client/ui-workspace` is pre-stable, so an upstream change lands here only when someone re-applies it; a DSH upgrade needs the copy diffed against the new official package.
- The upstream suite is not copied. Its component specs run on `@deepseek-ai/dsh-client-test-runtime`, whose 23 peer dependencies this workspace does not install. `tests/` carries the two specs that drive pure modules (`tree.spec.ts`, `path-suffix.spec.ts`) plus the In work model, store and region specs.
- The In work region is rendered only in the wide layout and only while no search query is active (see Visibility above).
- Coverage thresholds in `vitest.config.ts` are a floor, not a target: the package-wide numbers sit just under what the suite reaches today (the copied UI carries no specs), while the In work sources — the half this fork owns end to end — are pinned near their measured coverage so a regression there cannot hide behind the copied code.
- `locale/*.json` is not copied: the browser half ships its dictionaries inline in `src/client/locales.ts`, and no source file imports those JSON files.
- The In work region shows no elapsed time per row (see above). Restoring it needs a projection read loop, which the fork deliberately does not own.
