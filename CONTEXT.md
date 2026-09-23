# DSH Plugins

Personal catalog of DeepSeek Harness plugins. Each plugin is an independent installable Bundle in this workspace.

## Language

**Plugin**:
A Cordis module that exports `apply(ctx)` (and optionally `name`, `inject`, `Config`).
_Avoid_: extension, addon, package (when you mean the module)

**Bundle**:
An installable npm package whose `package.json` declares `dsh.bundle.patch`. It contributes exactly one Patch layer.
_Avoid_: plugin (when you mean the npm package), package (unqualified)

**Profile**:
A launchable composition at `$DSH_HOME/profiles/<name>`. It lists Bundles in order and may add its own Patch.
_Avoid_: config, installation, environment

**Patch**:
One `cordis.patch.yml` layer: insert, replace, or disable Cordis rows.
_Avoid_: overlay (except a CLI `--patch` file), config file

**Host plugin**:
A Plugin that runs in the DSH process and talks to Host services (`ctx.tools`, `ctx.agents`, …).
_Avoid_: server plugin, backend plugin

**Client plugin**:
A Plugin that runs in the Web Client (`dsh.client`, `exports["./client"]`).
_Avoid_: UI plugin (too broad — a Host plugin can still contribute tools that the UI renders)

**Loader row**:
One entry in a composed Cordis tree, addressed by `id`, whose `name` is a module specifier.
_Avoid_: plugin instance (unless you mean a live Fiber)

**Visible Session**:
A listed Session that is not blank, not subagent-origin, and not in the registry-global archive set. These are the rows whose `⋯` menu can archive.
_Avoid_: open session, current session, hovered session (when you mean the filter)

**Hover archive**:
Archiving the Visible Session whose sidebar row currently holds the pointer. The session id is read from the row's React fiber, so duplicate titles archive correctly.
_Avoid_: menu archive, current-session archive, title-match archive

**Composer**:
The conversation message input (`[data-composer-input]`).
_Avoid_: input box, textarea, chat input

**Plan target**:
The mode the Session is heading toward: `pending ? !active : active`. A pending `/plan` already counts as on; a pending `/plan off` already counts as off.
_Avoid_: plan.active (logged state, which lags a pending switch)

**Plan toggle**:
Claiming `/plan` or `/plan off` on the Composer the same way the slash menu does, based on Plan target. The mode changes when that command is sent, not when the shortcut is pressed. An open trigger menu keeps the shortcut. Matching the shortcut always steals Shift+Tab from focus traversal. Absent Session and absent plan-mode skip the claim.
_Avoid_: enter plan mode (when you mean the two-way switch), plan chip (exit-only control)

**Finished-unread**:
An ordinary listed Session that has stopped running while it was not the main view (`completionUnread === true` on the Session status snapshot). Subagent-origin rows never count. This is the number the sidebar's green completion dots show, and the number this plugin writes to the PWA icon badge.
_Avoid_: unread (unqualified), completed (when you mean the filtered count)

**Title refresh**:
Re-deriving a Session's title on demand from its whole conversation, instead of only at the first prompt.
_Avoid_: retitle (when you mean re-derive), regenerate title (unqualified)
