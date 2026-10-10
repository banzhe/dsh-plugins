# @banzhe/dsh-plan-toggle

Web Client plugin: `Shift+Tab` in the conversation Composer claims `/plan`
the same way the slash menu does. Plan mode changes when that command is
sent. Meant for the `web` Profile.

## Install

This checkout is mounted from the web Profile patch as a `file://` Loader row
(live patch reload). Rebuild `lib/` after source changes and refresh the GUI.
Do not assume HMR.

```sh
pnpm --filter @banzhe/dsh-plan-toggle build
```

To install as a Bundle instead (requires a process restart):

```sh
dsh plugin --profile web add ./plugins/plan-toggle
```

## Gesture

- Focus on the Composer (`[data-composer-input]`).
- `Shift+Tab` with no Ctrl/Alt/Meta. Key repeat and IME composition are ignored.
- An open trigger menu (`[data-trigger-menu]`) keeps the shortcut.
- No current Session, or no `plan` projection, keeps the shortcut.
- Off → claims `/plan ` in front of the current draft (send enters plan and
  can carry the draft as the plan message). On → replaces the draft with
  `/plan off` (send leaves plan). A second Shift+Tab before send drops the
  claim.
- A refused claim leaves the browser's reverse-Tab focus move intact: the
  gesture is consumed only once the Composer accepted it.

The built-in plan chip and `/plan` command are unchanged.

## Why this is a fixed shortcut row

The gesture rides DSH's shortcut service (`@deepseek-ai/dsh-client-shortcuts`)
as a **fixed** row — `registerFixed()` plus `observeFixedInput()` — rather than
a configurable command. That is forced by the service's own validation, not a
style choice:

- `bindingIssue()` rejects every chord whose only modifier is Shift
  (`modifier-required`), so a `web:*` default of `Tab` + `shift` cannot be
  registered through `register()` — it throws while mounting.
- `Tab` is additionally on the service's reserved-code list.
- `registerFixed()` validates physical codes only and never consults those
  reservations, so `Tab` + `shift` is accepted.

Consequences:

- The row **is** listed in the shortcut reference (Settings → 快捷键), in the
  Composer's group, so the gesture is discoverable and localized.
- It is **read-only**: the keycaps cannot be rebound from Settings, and the row
  does not enter the inline recorder.

If a rebindable chord is ever required, the only route is a configurable
command with a chord the service accepts on Web — e.g. `Ctrl+Shift+Tab`
(`Tab` + `shift` + `primary`) — which trades the current default away.

## Localized label

The row's label comes from the plugin's own `locale` namespace
(`src/client/locales.ts`: `切换计划模式` / `Toggle plan mode`) and follows a
locale switch like every other registered command.
