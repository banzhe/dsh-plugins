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
Archiving the Visible Session whose sidebar row currently holds the pointer, by matching that row's display title. Duplicate titles are not archived this way.
_Avoid_: menu archive, current-session archive
