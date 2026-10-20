# @banzhe/dsh-plan-toggle

Toggle plan mode from the Composer with `Shift+Tab`.

[中文版](./README.zh-CN.md)

A Web Client [DSH](https://github.com/deepseek-ai/deepseek-harness) Bundle for the **web** profile.

## Features

- `Shift+Tab` in the conversation Composer claims `/plan` the same way the slash menu does. Plan mode changes when that command is sent.
- Off → claims `/plan ` in front of the current draft, so send enters plan and can carry the draft as the plan message.
- On → replaces the draft with `/plan off`, so send leaves plan.
- A second `Shift+Tab` before send drops the claim.
- Key repeat and IME composition are ignored. An open trigger menu, no current Session, or no `plan` projection keeps the shortcut.
- A refused claim leaves the browser's reverse-Tab focus move intact: the gesture is consumed only once the Composer accepted it.
- Listed in the shortcut reference (Settings → 快捷键) under the Composer's group, with a localized label (`切换计划模式` / `Toggle plan mode`).
- Read-only: the keycaps cannot be rebound from Settings.
- The built-in plan chip and `/plan` command are unchanged.

## Install

### From npm

```sh
dsh plugin --profile web add @banzhe/dsh-plan-toggle
```

### From a local checkout

```sh
pnpm install
pnpm --filter @banzhe/dsh-plan-toggle build
dsh plugin --profile web add ./plugins/plan-toggle
```

Adding the Bundle to `dsh.profile.bundles` requires a process restart. Rebuild `lib/` after later source changes and refresh the GUI; do not assume HMR.

Remove with:

```sh
dsh plugin --profile web remove @banzhe/dsh-plan-toggle
```

## Docs

Implementation notes: [`docs/plugins/plan-toggle.md`](https://github.com/banzhe/dsh-plugins/blob/master/docs/plugins/plan-toggle.md).
