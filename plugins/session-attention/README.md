# @banzhe/dsh-session-attention

Web Client plugin: one `shell.overlay` entry that lists the Sessions needing
attention, behind a toggle.

- **Toggle** — an always-present button in the frame's bottom-right corner, with
  a badge holding the number of listed Sessions. The badge is always rendered,
  `0` included, so an empty list still shows that the toggle is alive.
  Bottom-right because the overlay layer spans the whole frame and, on Windows,
  its top band is the draggable caption strip: a trigger there would not be
  clickable.
- **Outer outline** — what the list holds, drawn on the toggle's own edge
  (`data-attention`, absent when nothing needs attention), highest priority
  first:
  1. **waiting** — something is blocked on you: a listed Session holds a pending
     interaction (approval, question, plan review). The ring is
     `--dsw-alias-state-warn-primary`, the amber a `warning` `StateDot` paints in
     the sidebar (and the dot that Session's own panel row wears), and it holds
     still.
  2. **running** — a 2px ring of the DS blue sweep
     (`--dsw-gradient-onboarding-blue-stops`, the conic stops `ui-theme` ships
     for the onboarding card border), its angle animated so the gradient travels
     around the edge. The first and last stop are the same color, so the loop has
     no seam.
  3. **unread** — `--dsw-alias-state-success-primary`, the green a `done`
     `StateDot` paints for the sidebar's completion dots. Also still.
  - `waiting` is read off the rows the panel already lists, never a state of its
    own: a pending interaction is a live Host request holding a turn open, so the
    Session is running and has a row in the running section, and an unread
    reminder it never cleared is a row too. The outline therefore can never
    report a state with nothing behind it.
  - Every color is read from `ui-theme` tokens; no state color is hand-picked
    here. Under `prefers-reduced-motion` the sweep drops its animation and the
    ring stays.
  - The toggle draws no grey edge of its own: it declares `border: 0`, which kills
    the UA's `2px outset buttonborder` bevel a bare `button` gets, and rebinds
    `--dsw-elevation-stroke-color` to `transparent`, which drops the 0.5px
    hairline layer of `--dsw-elevation-panel` while keeping its two soft glow
    layers. Either one beside the attention ring reads as a second border. The
    panel keeps its hairline, since nothing else outlines it.
- **Panel** — what the toggle opens (entry id `session-attention.panel`, order
  100). Two sections, newest first:
  - **Running** (`进行中`) — the host reports the Session as running
    (`running` on the Session status snapshot, falling back to the list row's
    own flag). Each running row also shows how long the current run has been
    going, `m:ss` or `h:mm:ss`, right-aligned in the panel's tertiary label
    tone. The count starts at the Session's latest human prompt
    (`sessionListMetadata.lastPromptAt`, the durable fact the list projection
    carries — so it survives a page reload), and a new prompt restarts it. A
    row whose projection has not been read yet shows no number; the plugin
    reads one `refreshProjections` call per **displayed** session version
    (`updatedAt`), not per list publication — the read republishes the list
    before the metadata key exists. A later prompt advances `updatedAt` and is
    read again. A failed read is retried once immediately; a second failure
    waits for a newer `updatedAt`. The number is
    re-rendered by a one-second interval that exists only while the panel is
    open.
    - **Running subagents** — each running row renders its running subagent
      children (`origin: 'subagent'`, same status rule as the parent) as an
      indented block under it, catalog order first and retained rows the
      catalog does not know appended in list order. A settled, finished, or
      finished-unread child never mounts. A running child also shows its own
      duration, counted from the start of its open turn
      (`subagentTiming.active.since` — the child has no human prompt of its
      own, so a child count follows the child's turn, and a new turn
      re-anchors it); the cell appears once the child's projection read has
      landed, one `refreshProjections` read per child version (`updatedAt`),
      claimed from the same versioned store the parent reads use. An idle
      parent with a running child is listed as a **container row** in this
      section anyway: no spinner dot and no duration (it holds no human prompt
      to count from), title in the secondary label tone. Children are not
      badge rows: `total` counts top-level rows only. A catalog-only child
      that is not held by this client reports running late (the row's
      `running` is only backed while the client holds the child); it appears
      when the host publishes its status through the shared list channel.
  - **Unread** (`未读`) — finished while it was not the main view
    (`completionUnread`, the same fact as the sidebar's green dot).
  - **Row indicator** — the shipped `StateDot`, so no color is hand-picked: the
    running spinner for work in flight, the green done dot for an unread
    reminder. A row whose turn is blocked on you wears the amber `warning` dot
    instead — `--dsw-alias-state-warn-primary`, the same color the toggle's
    `waiting` ring is drawn in, and it outranks the green in the unread section
    too. Waiting for an answer is not activity, so no spinner.
- **Click a row** — `ctx.uiWorkspace.openSession(id)` shows that Session as the
  main view and the panel closes behind it. An unread reminder clears on its own
  because becoming the main view is what clears it on the host.
- **Escape** and the panel's close button close it; the open state is in-memory
  (a reload starts closed).

Excluded on purpose: subagent children as panel rows of their own (`origin:
'subagent'` — they are not Host-list members anyway; a **running** one mounts
under its parent's running row instead, and a settled one does not display) and
blank New-Session placeholders. The status
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
- `pendingInteraction` is read from the same status snapshot and only ever
  narrows the outline and repaints a row's indicator: it selects the rows that
  are already listed, so the badge count and the sections are unchanged by it.
- The store compares content, not object identity: a list or status push that
  does not change the panel keeps the previous snapshot, so unrelated Session
  activity costs no render.
- The plugin owns no element of its own beyond the injected stylesheet
  (`<style data-plugin="@banzhe/dsh-session-attention">`), which leaves with the
  fiber. The wrapper stays click-through; only the toggle, the panel, and their
  controls take pointer events. The sheet itself is
  [`src/client/overlay.css`](src/client/overlay.css), imported as
  `overlay.css?inline`: the ModuleLoader fetches exactly one artifact
  (`lib/client.js`), so a plain `.css` import would emit a sibling asset nothing
  requests. `tsdown.config.ts` gets the loader from `@banzhe/dsh-devkit`, which
  hands back the compiled sheet (Vite resolves `?inline` for the specs, so the
  specs assert names and rules that survive minification, not the pre-compile
  text). The devkit also serves `.module.css` sheets with hashed class names, for
  chrome that should not share this sheet's tag.
- The outline is derived during render, never stored: `outlineFor(model)` reads
  the same snapshot the panel lists, so a source push that starts or finishes
  work repaints the ring in the same update that changes the rows.
- The durations are formatted from client wall-clock time, never localized
  through the namespace: `m:ss` / `h:mm:ss` are read the same everywhere, and
  the `row.open` key already carries the row's only locale text.
- Archived Sessions are not filtered out: an archived Session the host still
  reports as running or unread stays listed, and opening it works. Filtering
  would mean reading ui-workspace's internal archive set.
- A parent Session whose only activity is a running subagent is listed as a
  container row in the running section (see above); a running parent is
  normally running itself while it delegates.
- Subagent children show no duration inherited from the parent: a child's
  work started with its own current turn, and the child's open turn start
  (`subagentTiming.active.since`) is what its cell counts from — a per-child
  durable fact the same versioned projection read the parents use.
- A running row's elapsed time is measured from the Session's latest human
  prompt (`lastPromptAt`), not from the row's `updatedAt`: the activity
  timestamp moves on every push, which would be a clock that restarts whenever
  the Session works. The prompt time rides the row and is part of the store's
  content comparison, so a busy Session's pushes cost no render.
- Labels follow the app locale through the `session-attention` namespace
  (zh/en).
- Projection reads go to the rows the panel lists — running rows, their
  running children, and unread rows — never the whole session list. A large
  workspace (hundreds of Sessions) otherwise opens into that many concurrent
  `session/projections` calls on first load, which exhausts the browser's
  connection pool for several seconds (`ERR_INSUFFICIENT_RESOURCES`) and
  blocks unrelated API traffic. An unread row reads once for its anchor cell
  cost only when it is already flagged by the host; a settled-idle Session
  never reads, because the panel renders no anchor for it.
