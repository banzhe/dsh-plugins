# workspace

`@banzhe/dsh-workspace` — Bundle `plugins/workspace`, loader row `workspace-personal`, replaces the shipped `ui-workspace`.

## Why a fork

The sidebar's Workspace region and the hero picker are one Client plugin upstream, and every part of it is public surface this workspace wants to change freely: the browsing tree, the row seats, the Session menu adapter, the picker flow, the `workspace` copy. Contributing through slots cannot reach any of it — the plugin owns those slots and the `uiWorkspace` service — so the choice is fork or nothing.

## The replacement is one patch

`cordis.patch.yml`:

```yaml
- id: ui-workspace
  disabled: true
- insert:
    - id: workspace-personal
      name: '@banzhe/dsh-workspace'
```

The Bundle layer applies after `@deepseek-ai/dsh-web-app`, which declares `ui-workspace`, so the disable hits an existing row. Both rows declare `sidebar.workspaces` and `conversation.hero.workspace` and both provide the `uiWorkspace` service; the slot registry rejects a second declaration and Cordis rejects a second provider, so leaving the shipped row enabled fails at load rather than rendering twice.

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
- The `dsh.client.inject` list is informational (preflight and HMR), not activation order; each registration still waits on the real slot declaration through `slots.inject`.
- The browser half is one `lib/client.js` registered through `window.__ModuleLoader__.load({ id: '@banzhe/dsh-workspace' })`. A named import that keeps only `type` specifiers under `verbatimModuleSyntax` still emits a bare side-effect import, which is how a published dynamic client module can end up nested inside this bundle; keep those imports as `import type`.

## Known limitations and deferred work

- The fork tracks upstream by hand. `packages/client/ui-workspace` is pre-stable, so an upstream change lands here only when someone re-applies it; a DSH upgrade needs the copy diffed against the new official package.
- The upstream suite is not copied. Its component specs run on `@deepseek-ai/dsh-client-test-runtime`, whose 23 peer dependencies this workspace does not install. `tests/` carries the two specs that drive pure modules (`tree.spec.ts`, `path-suffix.spec.ts`).
- `locale/*.json` is not copied: the browser half ships its dictionaries inline in `src/client/locales.ts`, and no source file imports those JSON files.
