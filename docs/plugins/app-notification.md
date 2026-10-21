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
- Archived Sessions are skipped by both surfaces: the archive set is
  registry-global (`ctx.workspaces.list` → `archivedSessionIds`), and a Session
  the user filed away is not work waiting for a look. A row that finishes while
  archived is never announced, and archiving a finished row retracts it from the
  badge. Restoring one re-counts it without a second announcement, because
  archiving does not clear the host's completion reminder.
- First observation is state-only: a reload shows the current count and does
  not re-announce Sessions that finished while no page was watching.
- A page with neither badging nor a `Notification` constructor still registers
  dictionaries and the settings row, so the readout can explain the silence.

The plugin never requests permission on activation, never persists a toggle,
and has no service worker or push — closed pages do not announce.

## Archive gating

The archive set is subscribed, not merely read. Archiving a finished Session
moves neither the Session status snapshot nor the Session list, so without that
third subscription the badge would keep counting a row the user just filed away.
`CompletionObserver.observe` takes the archive set as its third input and
filters *after* recording the previous-observation set: an archived Session is
still distinguished from a newly finished one, which is what keeps a restore from
re-announcing.

## Surfaces

A General-settings row (`settings.general.item`, id `app-badge`) shows the live
capability state and hosts the only user gesture that may call
`Notification.requestPermission()`.
