# app-notification — implementation notes

Moved out of the plugin's README, which now covers only features and installation.

## Behaviour

- Badge count matches the sidebar's green completion dots: ordinary Sessions
  that are finished and not yet opened. `origin: 'subagent'` rows are excluded.
- Each newly finished ordinary Session raises one notification tagged
  `dsh-session-completed` (a run of completions replaces rather than stacks).
  Click focuses this window, then opens that Session through
  `ctx.uiWorkspace.openSession`. Chromium on Windows does not raise the page
  on its own.
- First observation is state-only: a reload shows the current count and does
  not re-announce Sessions that finished while no page was watching.
- A page with neither badging nor a `Notification` constructor still registers
  dictionaries and the settings row, so the readout can explain the silence.

The plugin never requests permission on activation, never persists a toggle,
and has no service worker or push — closed pages do not announce.

## Surfaces

A General-settings row (`settings.general.item`, id `app-badge`) shows the live
capability state and hosts the only user gesture that may call
`Notification.requestPermission()`.
