# @banzhe/dsh-hover-archive

Web Client plugin: hovering a sidebar Session row and pressing `A` archives that Session. Meant for the `web` Profile.

## Install

```sh
dsh plugin --profile web add ./plugins/hover-archive
```

Rebuild `lib/` after source changes and refresh the GUI. Do not assume HMR. Adding the Bundle to `dsh.profile.bundles` requires a process restart.

## Gesture

- Pointer on a non-blank Session row (the row that owns the `⋯` menu) or that row's hover card.
- Unchorded physical `A` (`Shift+A` is ignored; Caps Lock `A` archives). Key repeat and IME composition are ignored.
- Steals `A` from the conversation composer (`data-composer-input`). Search, rename, and settings inputs keep the letter.

The row has no session id. The plugin reads the `⋯` aria-label title and archives only when exactly one visible Session (not blank, not subagent, not already archived) has that display title. Duplicate titles skip; `A` then types into the composer if it is focused.

Failures log `session archive rejected:` and do not toast. The built-in `⋯` Archive session menu is unchanged.
