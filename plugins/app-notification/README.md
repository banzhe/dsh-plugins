# @banzhe/dsh-app-notification

Web Client plugin: project the finished-unread Session count onto the installed
PWA's icon badge, and raise one system notification per Session that finishes
while the page is open. Meant for the `web` Profile.

A General-settings row (`settings.general.item`, id `app-badge`) shows the live
capability state and hosts the only user gesture that may call
`Notification.requestPermission()`.

## Install

From this repo root, after `lib/` exists:

```sh
dsh plugin --profile web add ./plugins/app-notification
```

Rebuild `lib/` after source changes and refresh the GUI. Do not assume HMR.
Adding the Bundle to `dsh.profile.bundles` requires a process restart.

Remove with:

```sh
dsh plugin --profile web remove @banzhe/dsh-app-notification
```

## Behaviour

- Badge count matches the sidebar's green completion dots: ordinary Sessions
  that are finished and not yet opened. `origin: 'subagent'` rows are excluded.
- Each newly finished ordinary Session raises one notification tagged
  `dsh-session-completed` (a run of completions replaces rather than stacks).
  Click opens that Session through `ctx.uiWorkspace.openSession`.
- First observation is state-only: a reload shows the current count and does
  not re-announce Sessions that finished while no page was watching.
- A page with neither badging nor a `Notification` constructor still registers
  dictionaries and the settings row, so the readout can explain the silence.

The plugin never requests permission on activation, never persists a toggle,
and has no service worker or push — closed pages do not announce.
