# @banzhe/dsh-agent-preset-visibility

Keeps the agent presets you choose out of the preset picker, and gives Settings a page to choose which ones. Hiding is a list filter: a hidden preset still registers, still composes the sessions that already run it, and still serves any delegation that names it.

[中文版](./README.zh-CN.md)

A [DSH](https://github.com/deepseek-ai/deepseek-harness) Bundle for the **web** profile: the filter rides the browser's roster read, so it needs the Web Client and does nothing on a Host-only profile.

## Features

- **Preset visibility** — a page under Settings that lists every declared preset, built-in and custom, with its id and display name, and one checkbox per row. Checked means "shown in the picker"; cleared hides it.
- Hiding reaches all three web roster surfaces at once: the new-session chip, the session header label, and the Settings roster. Each preset picker re-reads the roster the next time it opens.
- Nothing is disabled and nothing is rewritten: a hidden preset keeps its registration, so a Home patch's `agentPreset:` reference still binds it, selection and resolve keep working, and every subagent the preset composes still runs.
- Hiding the current default preset does **not** change what a new session composes — the default is a settings field this Bundle never writes.
- The hidden list is stored in the profile patch, so it survives a restart, and it takes effect on the next roster read without one.
- Ships empty: every preset is shown until you clear a row.

## Install

### From npm

```sh
dsh plugin --profile web add @banzhe/dsh-agent-preset-visibility
```

### From a local checkout

```sh
pnpm install
pnpm --filter @banzhe/dsh-agent-preset-visibility build
dsh plugin --profile web add ./plugins/agent-preset-visibility
```

Restart **dsh web** afterwards: the Host row is loaded once at activation, so a rebuild needs a restart. Do not assume HMR.

Remove with:

```sh
dsh plugin --profile web remove @banzhe/dsh-agent-preset-visibility
```

## Docs

Implementation notes, the design review behind the filter seam, and known limits: [`docs/plugins/agent-preset-visibility.md`](https://github.com/banzhe/dsh-plugins/blob/master/docs/plugins/agent-preset-visibility.md).

## License

MIT
