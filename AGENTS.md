# Agent notes

This repo is a pnpm workspace of independent DSH Bundles. Package names are `@banzhe/dsh-<name>`. Directory names are unscoped: `plugins/<name>/`.

To add a plugin, use the project skill `add-dsh-plugin`.

## Verification

Before reporting a task done, run all three checks against the touched `plugins/<name>/` (each exits 0, no failed tests/lint findings):

1. `pnpm typecheck`
2. `pnpm lint` (repo root: `oxlint plugins devkit`; `pnpm lint:fix` is not a substitute for a clean run)
3. `pnpm exec vitest run` for the plugin's tests

Spawn a subagent to run them end-to-end; pass it the exact commands, working directory, and pass criteria; report its verdict, not just your own claim of success.
