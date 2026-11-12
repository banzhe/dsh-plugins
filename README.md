# dsh-plugins

Personal DeepSeek Harness plugins. Each directory under `plugins/` is one installable [Bundle](./CONTEXT.md).

[中文版](./README.zh-CN.md)

## Layout

```
plugins/<name>/                         # one Bundle: @banzhe/dsh-<name>
.agents/skills/add-dsh-plugin/          # how to add a plugin
docs/plugins/<name>.md                  # per-plugin implementation notes
CONTEXT.md                              # glossary
```

## Plugins

| Plugin | What it contributes |
| --- | --- |
| `agent-preset-per-workspace` | Remembers the agent preset picked by hand in each workspace and composes that workspace's next session with it |
| `app-notification` | Projects the finished-unread Session count onto the installed PWA's icon badge and raises one system notification per completion |
| `file-link-open` | Right-click a file link in a session message to open it in an editor/IDE, open its containing folder, or copy its path |
| `git` | Right-sidebar Git panel: the session workspace's changed files, committed with the message you type |
| `plan-toggle` | Toggles plan mode from the Composer with `Shift+Tab` |
| `session-attention` | `shell.overlay` panel listing running and finished-unread Sessions, with click-to-jump |
| `session-title-rules` | Rules-based Session title provider (`emoji 主题`) replacing the built-in first-prompt provider |
| `sidebar-menu-actions` | Workspace row-menu extension: inserts **Open in VS Code**, **Open in File Browser** (Windows), and **Copy workspace path** into the Workspace "..." menu |
| `web-icons` | Serves the Web launcher icon set (favicon, PWA manifest icons, apple-touch-icon) from a Bundle-owned snapshot |

## Add a plugin

Follow the project skill [add-dsh-plugin](./.agents/skills/add-dsh-plugin/SKILL.md). Then:

```sh
pnpm install
pnpm --filter @banzhe/dsh-<name> build
```

## Install into the web Profile

From this repo root, after `lib/` exists:

```sh
dsh plugin --profile web add ./plugins/<name>
```

That `link:`s the checkout into `$DSH_HOME/profiles/web` and appends `@banzhe/dsh-<name>` to `dsh.profile.bundles`. Rebuild after source changes; do not assume HMR.

Remove with:

```sh
dsh plugin --profile web remove @banzhe/dsh-<name>
```

## Lint

[oxlint](https://oxc.rs) with `oxlint-tsgolint` (type-aware), configured once in `.oxlintrc.json` at the root and run over every Bundle plus `devkit`:

```sh
pnpm lint
pnpm lint:fix
```

The correctness and type-aware rule block is the one upstream DeepSeek Harness lints itself with, so a Bundle reads like the packages it plugs into. Upstream's `@stylistic` and `sonarjs` blocks are deliberately absent: formatting belongs to a formatter, not the linter. Both tools are pinned exactly in the `pnpm-workspace.yaml` catalog.

## Tests and coverage

`pnpm test` runs each package's suite on its own, which is what to use while developing. The gates — CI's `verify` job, the release job that decides whether a push publishes, and `pre-push` — run `pnpm test:coverage` instead:

```sh
pnpm test            # vitest run, no thresholds
pnpm test:coverage   # vitest run --coverage, thresholds enforced, --no-bail across packages
```

Every package that has tests states its own thresholds in its `vitest.config.ts`, and the coverage `include` is the shipped source, not the files the specs happen to touch — a suite that reaches half a package reports half a package. Where the suite does reach all shipped code the gate is per-file 100%; where part of the shipped code cannot be driven from a unit test (the browser entry of a plugin whose specs mount only its controller, a helper program that only runs inside a container, a package whose client half has no specs yet) the thresholds are the measured baseline rounded down, so they ratchet and the gap stays visible in the report. Nothing is excluded to make a number go up: a coverage report that hides untested logic is worth less than the number it prints.

## Git hooks

`pnpm install` points `core.hooksPath` at `.githooks/`. On a clone that already has `node_modules`, run it once yourself:

```sh
pnpm hooks:install
```

| Hook | Runs |
| --- | --- |
| `pre-commit` | `pnpm typecheck` |
| `pre-push` | `pnpm lint`, `pnpm typecheck`, `pnpm test:coverage` |

`pre-push` is the same gate as CI's `verify` job, which decides whether a push to `master` publishes. Skip a hook with `git commit --no-verify` or `git push --no-verify`.

## Requirements

- Node `^22.19.0 || >=24.0.0`
- pnpm `11.7.0`
- A DSH CLI that supports `dsh plugin`
