# Agent notes

This repo is a pnpm workspace of independent DSH Bundles. Package names are `@banzhe/dsh-<name>`. Directory names are unscoped: `plugins/<name>/`.

To add a plugin, use the project skill `add-dsh-plugin`.

## Versioning and releases

- Plugin versions are independent of DSH. Releases go through changesets: every user-visible change adds a changeset (`pnpm changeset`); do not edit `version` or `CHANGELOG.md` by hand.
- `peerDependencies` on `@deepseek-ai/*` use caret ranges (for example `^0.2.1-alpha.2`). Never write exact versions or `catalog:` there.
- Change a `peerDependencies` range only when the new DSH version is incompatible with the plugin **and** you have adapted the plugin to it in the same change. Do not bump peer ranges just because DSH released a new version.

## Verification

Before reporting a task done, run all three checks against the touched `plugins/<name>/` (each exits 0, no failed tests/lint findings):

1. `pnpm typecheck`
2. `pnpm lint` (repo root: `oxlint plugins devkit`; `pnpm lint:fix` is not a substitute for a clean run)
3. If `plugins/<name>/package.json` has a `test` script, run `pnpm -C plugins/<name> test`; skip this check for plugins without one (vitest is not installed at the repo root, so `pnpm exec vitest run` there fails)

Spawn a subagent to run them end-to-end; pass it the exact commands, working directory, and pass criteria; report its verdict, not just your own claim of success.
