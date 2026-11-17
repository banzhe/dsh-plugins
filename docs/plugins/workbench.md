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

The first block of the browsing list — under the section toolbar (search, view options, add workspace) and above the workspace rows, scrolling with them — is **In work**: two independent, collapsible groups, **Running** and **Unread**, plus the amber marker for a turn blocked on the user. A search replaces the whole list body, so the region steps aside with it.

The block carries no title of its own and no total: each fold's header names its group and counts that group, so there is nothing above the two headers to read. While both groups are empty the region renders nothing at all rather than an empty frame or a "nothing in work" line.

**Where the data comes from.** Three sources other plugins already own, and nothing else:

| Fact | Owner |
|---|---|
| row order, titles, `running`, `blank`, `origin`, `updatedAt` | `ctx.sessions.list` |
| `running`, `completionUnread`, `pendingInteraction` | `ctx.uiSession.sessionStatus` |
| `archivedSessionIds`, `pinnedSessionIds` | `ctx.workspaces.list` |

The store folds those three snapshots into one model and publishes it through the browsing entry's `hooks` compartment, so the component subscribes through the renderer rather than owning a subscription. It writes nothing: there is no unread bookkeeping, no second projection refresh, and no read-receipt request. Opening a row calls the same `openSession` the tree rows call — selecting the Session as the main view is what makes `ui-session` clear its completion flag — and the only Host write is `unpinSession`, the same call the row's pin button issues.

**What lists, and why.** Subagent rows never list on their own: a running child mounts under its parent, one level per delegation hop, in `subagentCatalog` order. The blank New-Session placeholder and archived Sessions never list; the archive set gates descendants too, so a running child under an archived Session cannot re-mount the row the user just filed away. Running outranks a finish reminder: a Session whose work is still in flight lists as running even if a completion flag is set.

**One row per Session, in two groups.** Running holds every Session with live work, pinned or not, in the existing stable newest-first order (equal timestamps keep Host list order); a pinned running Session is not fronted over a newer unpinned run. Unread holds non-running Sessions with a completion flag plus pinned Sessions with no running work, even when the flag is clear; pinned rows lead that group, then each side stays newest first. A pinned running Session lists only under Running and a pinned unread one only under Unread, so no Session appears twice. A quiet pin is a container row with no live work. A blocked turn stays in its group and wears `StateDot`'s warning state instead of the group's own dot.

**Collapse.** Each group folds independently through its own header, which shows that group's visible count; the count stays in the header while the group is folded, so a folded group still says how much it holds. A group with no rows renders no fold, and with neither group rendering the region takes no space at all. A group header's visible title and count name that fold, with the fold state on `aria-expanded`.

**Access.** The release control on a pinned row goes through the row actions' `useSessionAccess` gate for `workspace/unpinSession`, so a Session whose access snapshot refuses unpinning renders no button at all — the same rule the row's own pin toggle follows.

**Visibility.** Two placements are deliberate: a search query replaces the whole list body, so the region steps aside with the tree rather than competing with results; and the collapsed rail (`wide === false`) renders the region not at all. Both follow the browsing region's own visibility rule — the list is what the surface exists for — and neither is a gap to be fixed with more UI.

**Not migrated.** The Windows taskbar pulse from `@banzhe/dsh-session-attention` is not part of this region: it projected the same model through an Electron channel, and the web profile has no taskbar to drive. The elapsed-time column that panel showed is gone too — it required a per-Session projection read loop, and this Bundle issues no projection refresh.

## Retiring the old panel

`plugins/session-attention` stays in the repository as the rollback path: its source and tests still build and pass. The web profile no longer installs it — neither as a dependency nor in `dsh.profile.bundles` — so its `shell.overlay` entry and its `cordis.patch.yml` layer are both gone from the running tree. Removing the Bundle (rather than disabling its row) is what takes the overlay with it.

## What the fork must keep identical

These are contracts other packages reach through, not local choices:

| Contract | Consumer |
|---|---|
| slots `sidebar.workspaces`, `conversation.hero.workspace`, the two `*.directoryFlow` holes | `ui-directory-picker-native`, `ui-directory-picker-browse` |
| `sidebar.session.row.leading` / `.trailing` / `.hover` | `ui-schedule` |
| `sidebar.workspaces.session.menu.item` (legacy React rows) | `ui-open-in-app` |
| `contextMenu.content` key `session`, `contextMenu.icon` | `ui-context-menu` |
| `shell.overlay` entries and the `workspace.toast` child | any overlay contributor |
| service `uiWorkspace`, root hooks `useWorkspaces` / `useWorkspaceAccess` | `session-attention`, `app-notification` |
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
- `plugins/session-attention` keeps the taskbar pulse and the elapsed-time column that this Bundle does not carry; if the old Bundle is reinstalled alongside this one, both would render their own in-work surfaces.
