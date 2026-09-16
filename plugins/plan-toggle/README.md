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
- Matching the shortcut always steals reverse Tab. No current Session, or no
  `plan` projection, skips the claim.
- Off → claims `/plan ` in front of the current draft (send enters plan and
  can carry the draft as the plan message). On → replaces the draft with
  `/plan off` (send leaves plan). A second Shift+Tab before send drops the
  claim.

A refused claim logs `plan toggle rejected:` and does not toast. The built-in
plan chip and `/plan` command are unchanged.
