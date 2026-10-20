# @banzhe/dsh-agent-preset-per-workspace

Remembers the agent preset you pick by hand in each workspace, and composes the next session in that workspace with it. The memory is keyed by workspace id; a preset that is gone falls back to the global default.

[中文版](./README.zh-CN.md)

A Host-only [DSH](https://github.com/deepseek-ai/deepseek-harness) Bundle for the **web** and **desktop** profiles (they compose the same `dsh-base` + `dsh-web-app` host, so it needs no client half on either).

## Features

- Pick a preset on a blank session in a workspace, and that workspace remembers it.
- The next session created in that workspace composes the remembered preset before its first turn — chip, toolset, and prompt all agree.
- A workspace you never picked a preset in is unchanged: the global default applies.
- Delete or disable the remembered preset, and the next session starts on the global default anyway; session creation still succeeds.
- Pick a different preset later and the workspace follows the newest pick.
- Sessions that already have a composition are never touched: a **resume**, a `/clear`, a compaction, a **fork**, and every **subagent** keep exactly what their log or their parent gave them.
- "Set as new task default" in Settings counts as a manual pick too, so the current workspace binds to it.
- No UI, no tools, no prompt text: the stored data never reaches the model.

## Install

### From npm

```sh
dsh plugin --profile web add @banzhe/dsh-agent-preset-per-workspace
```

### From a local checkout

```sh
pnpm install
pnpm --filter @banzhe/dsh-agent-preset-per-workspace build
dsh plugin --profile web add ./plugins/agent-preset-per-workspace
```

Restart `dsh web` — the host half is loaded once at activation, so a rebuild needs a restart. Do not assume HMR.

The **`desktop` profile is off limits to the CLI**: `dsh plugin --profile desktop …` refuses with *"profile "desktop" is managed exclusively by the Electron application"*. Add this Bundle there through the application's own plugin manager, or add the dependency and the `dsh.profile.bundles` entry to `$DSH_HOME/profiles/desktop/package.json` by hand and run `pnpm install` in that directory. Both profiles must be told separately; they do not share a bundle list.

Remove with:

```sh
dsh plugin --profile web remove @banzhe/dsh-agent-preset-per-workspace
```

## Docs

Implementation notes: [`docs/plugins/agent-preset-per-workspace.md`](https://github.com/banzhe/dsh-plugins/blob/master/docs/plugins/agent-preset-per-workspace.md).

## License

MIT
