# dsh-plugins

Personal DeepSeek Harness plugins. Each directory under `plugins/` is one installable [Bundle](./CONTEXT.md).

## Layout

```
plugins/<name>/                         # one Bundle: @banzhe/dsh-<name>
.agents/skills/add-dsh-plugin/          # how to add a plugin
CONTEXT.md                              # glossary
```

`plugins/` is empty until the first plugin lands.

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

## Git hooks

`pnpm install` points `core.hooksPath` at `.githooks/`. On a clone that already has `node_modules`, run it once yourself:

```sh
pnpm hooks:install
```

| Hook | Runs |
| --- | --- |
| `pre-commit` | `pnpm typecheck` |
| `pre-push` | `pnpm lint`, `pnpm typecheck`, `pnpm test` |

`pre-push` is the same gate as CI's `verify` job, which decides whether a push to `master` publishes. Skip a hook with `git commit --no-verify` or `git push --no-verify`.

## Requirements

- Node `^22.19.0 || >=24.0.0`
- pnpm `11.7.0`
- A DSH CLI that supports `dsh plugin`
