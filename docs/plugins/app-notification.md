# app-notification — implementation notes

Moved out of the plugin's README, which now covers only features and installation.

## Behaviour

- Badge count follows the sidebar's green completion dots — ordinary Sessions
  that are finished and not yet opened — and is never higher than that count:
  this plugin is stricter while a descendant is still running (see Delegation
  gating). `origin: 'subagent'` rows are excluded.
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
- A Session still waiting on a running subagent descendant is skipped by both
  surfaces too, and announces once the last descendant settles (see Delegation
  gating).
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

## Delegation gating

A Session that delegates to an asynchronous subagent ends its turn and goes idle
while the child works, so the host marks it `completionUnread` the moment the
delegating turn closes. `CompletionObserver.observe` therefore skips a finished
row that still has **any running descendant** subagent, in both the badge count
and the announcements.

The gate is stricter than the sidebar's, deliberately. `ui-workspace`'s
`runningSubagentCount` counts only the direct children the parent's
`subagentCatalog` names, and `sessionStatuses` ranks a non-zero count above
`completed`; this plugin also descends through a child that is itself idle but
has a running child of its own (P idle, C idle, G running). There the sidebar
paints P's completion dot while this plugin still withholds the announcement:
the wave is not over, and P's turn ended only to wait for it. The divergence is
one-directional — the badge never counts a Session the sidebar would show as
completed; it can only stay lower for as long as the deeper work runs.

The two per-level facts come from the two snapshots the presenter already
subscribes to:

- a node's children are the union of two sources, because either can lag: its
  own `subagentCatalog` projection
  (`ctx.sessions.list` → `projectionsBySession[node].values.subagentCatalog`) and
  the `byId` rows that are `origin: 'subagent'` with `parentId` equal to that
  node. A child whose catalog projection has not arrived yet is still a child —
  a retained row is what carries it — and the union keeps one delegation from
  being walked twice. The `byId` half is grouped into one parent → children index
  per snapshot, so a finished Session's walk never rescans the whole list;
- a child's running state is `ctx.uiSession.sessionStatus`'s `running` for that
  child id, because the host publishes `api-session/status` per Agent. A child is
  usually not a Host-list member, so its list row's own `running` is only a
  display fallback, read when the status snapshot has no answer for it yet.

The walk carries a `visited` set seeded with the Session itself: `parentId` is
host data, and a forged cycle must not keep the walk alive. Depth is bounded by
the delegation depth the runtime enforces, so the explicit frontier is a few
levels deep at most.

The skip happens while the finished set is built, *before* the previous
observation set is recorded — deliberately, and unlike the archive filter. A
waiting Session is therefore absent from that set, so the first observation in
which it is finished-unread **and** has no running descendant reports it as newly
completed: the announcement is deferred until the whole delegation wave goes
quiet rather than dropped. Filtering the notification list instead would record
the Session as already told while the badge counted it, losing the real
completion and announcing nothing.

## Surfaces

A General-settings row (`settings.general.item`, id `app-badge`) shows the live
capability state and hosts the only user gesture that may call
`Notification.requestPermission()`.
