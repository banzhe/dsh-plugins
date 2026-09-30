# @banzhe/dsh-session-attention

Web Client plugin: one `shell.overlay` entry that lists the Sessions needing
attention, behind a toggle.

- **Toggle** — an always-present button in the frame's bottom-right corner, with
  a badge holding the number of listed Sessions. The badge is always rendered,
  `0` included, so an empty list still shows that the toggle is alive.
  Bottom-right because the overlay layer spans the whole frame and, on Windows,
  its top band is the draggable caption strip: a trigger there would not be
  clickable.
- **Panel** — what the toggle opens (entry id `session-attention.panel`, order
  100). Two sections, newest first:
  - **Running** (`进行中`) — the host reports the Session as running
    (`running` on the Session status snapshot, falling back to the list row's
    own flag).
  - **Unread** (`未读`) — finished while it was not the main view
    (`completionUnread`, the same fact as the sidebar's green dot).
- **Click a row** — `ctx.uiWorkspace.openSession(id)` shows that Session as the
  main view and the panel closes behind it. An unread reminder clears on its own
  because becoming the main view is what clears it on the host.
- **Escape** and the panel's close button close it; the open state is in-memory
  (a reload starts closed).

Excluded on purpose: subagent children (`origin: 'subagent'` — they are not
Host-list members anyway) and blank New-Session placeholders. The status
snapshot decides running versus finished-unread, and the row's own `running` is
only the fallback for a Session whose baseline never arrived; a status entry
carrying both is listed as running, because "still working" is the more
actionable fact.

Meant for the `web` (and `desktop`) Profile.

## Install

```sh
pnpm --filter @banzhe/dsh-session-attention build
dsh plugin --profile web add ./plugins/session-attention
```

A new Bundle only reaches the client module graph at boot: restart DeepSeek
Harness, then refresh the page. Rebuild `lib/` after later source changes. Do
not assume HMR.

The **`desktop` profile is off limits to the CLI** — `dsh plugin --profile
desktop …` refuses with *"profile "desktop" is managed exclusively by the
Electron application"*. Add this Bundle there through the application's own
plugin manager, or add the dependency and the `dsh.profile.bundles` entry to
`$DSH_HOME/profiles/desktop/package.json` by hand and run `pnpm install` in
that directory. The two profiles do not share a bundle list.

Remove with:

```sh
dsh plugin --profile web remove @banzhe/dsh-session-attention
```

## Behaviour notes

- The list is derived from `ctx.sessions.list` (`ids` order for stable ties,
  `displayTitle` for labels) plus `ctx.uiSession.sessionStatus`. Sections are
  ordered by `updatedAt`, newest first.
- The store compares content, not object identity: a list or status push that
  does not change the panel keeps the previous snapshot, so unrelated Session
  activity costs no render.
- The plugin owns no element of its own beyond the injected stylesheet
  (`<style data-plugin="@banzhe/dsh-session-attention">`), which leaves with the
  fiber. The wrapper stays click-through; only the toggle, the panel, and their
  controls take pointer events.
- Archived Sessions are not filtered out: an archived Session the host still
  reports as running or unread stays listed, and opening it works. Filtering
  would mean reading ui-workspace's internal archive set.
- A parent Session whose only activity is a running subagent is not listed as
  running (the row's own flag is what counts); the parent is normally running
  itself while it delegates.
- Labels follow the app locale through the `session-attention` namespace
  (zh/en).
