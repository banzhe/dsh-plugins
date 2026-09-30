# @banzhe/dsh-agent-preset-per-workspace

**Remembers the agent preset you pick by hand in each workspace, and composes the next session in that workspace with it.** The memory is keyed by workspace id; a preset that is gone falls back to the global default.

A Host-only [DSH](https://github.com/deepseek-ai/deepseek-harness) Bundle for the **web** and **desktop** profiles (they compose the same `dsh-base` + `dsh-web-app` host, so it needs no client half on either).

## Install

```sh
pnpm install
pnpm --filter @banzhe/dsh-agent-preset-per-workspace build
dsh plugin --profile web add ./plugins/agent-preset-per-workspace
```

Then restart `dsh web`. The host half is loaded once at activation, so a rebuild needs a restart — do not assume HMR.

The **`desktop` profile is off limits to the CLI** — `dsh plugin --profile desktop …` refuses with *"profile "desktop" is managed exclusively by the Electron application"*. Add this Bundle there through the application's own plugin manager, or add the dependency and the `dsh.profile.bundles` entry to `$DSH_HOME/profiles/desktop/package.json` by hand and run `pnpm install` in that directory. Both profiles must be told separately; they do not share a bundle list.

## Behaviour

DSH resolves an agent preset in three layers, none of them keyed by workspace: the deployment default, the global user setting (`selectedDefault`), and the per-session choice recorded in that session's own log. This Bundle adds the missing per-workspace layer.

| You do | What happens |
| --- | --- |
| Switch the preset chip on a blank session in workspace `W` | `W` remembers that preset, keyed by `W`'s stable workspace id |
| Create the next session in `W` | It composes the remembered preset before its first turn — chip, toolset, and prompt all agree |
| Open a workspace you never picked a preset in | Nothing changes; the global default applies |
| Set "Set as new task default" in Settings while a blank session in `W` is current | That is a manual pick too, so `W` remembers it (see below) |
| Delete or disable the remembered preset, then create a session in `W` | The session starts on the global default instead; session creation still succeeds |
| Pick a different preset in `W` later | `W` follows the newest pick |

Sessions that already have a composition are never touched: a **resume**, a `/clear`, a compaction, a **fork**, and every **subagent** keep exactly what their log or their parent gave them.

"Set as new task default" is deliberately counted as a per-workspace pick rather than filtered out. It writes the global default *and* switches the current blank session, and that pair is indistinguishable from a chip pick at the host seam. The consistent reading is the point of the plugin: **a workspace's default is the preset you last confirmed by hand inside that workspace.** Picking the global default inside a workspace therefore binds that workspace to it — the workspace then behaves like the global default *as of that moment*, and a later change to the global default made elsewhere will not reach it until you pick there again. There is no separate "unbind"; picking is the only way in and the only way to change it.

## How it works

| Half | File | Runtime |
| --- | --- | --- |
| Host | `lib/index.js` | Node — Cordis loader. Two listeners over one `ctx.storageDomain` domain (`workspace_agent_preset`, one `bindings` table keyed by `WorkspaceId`). **Record**: `agent-preset/selected` is re-emitted by the preset registry for every selection it commits to a session log — and only for those, because a freshly created session is composed in its setup callback, which never appends the event; that makes the event exactly "a person changed this session's preset". The session's `cwd` resolves to a workspace through `ctx.workspaceRegistry.resolveByPath`, and the pick is stored under that workspace's id. **Apply**: `agent/created` is serial and awaited inside agent creation, so `ctx.agentPresets.select` there lands before the session is addressable and before its first turn. A remembered preset that no longer resolves is simply not applied — `select` rejects before it binds anything, so the already-composed global default stands. |

No Client half: the chip and resume both read the `agentPreset` session projection, which an applied selection advances.

### Data

One JSON document at `$DSH_HOME/storages/workspace_agent_preset.json`, in the storage-domain unit shape (the same file layout the workspace registry uses):

```json
{
  "unit": { "name": "workspace_agent_preset", "version": 1 },
  "global": null,
  "tables": {
    "bindings": {
      "<workspaceId>": { "agentPreset": "code", "updatedAt": "2026-09-30T12:00:00.000Z" }
    }
  }
}
```

`updatedAt` is an audit stamp for a person reading the file; nothing branches on it.

Host-side storage only: this Bundle contributes no tools, no prompt text, and no session events of its own, and its stored data never reaches the model. The domain is opened once at activation and the medium is never re-read, so **the file is only authoritative while the host is stopped**: deleting it (or editing it) while `dsh web` or the desktop app runs has no effect, and the next write puts the whole unit back.

## Verify

1. In workspace `W`, switch the preset chip to a non-default preset on a blank session (Developer tools must be on for the chip to render).
2. `$DSH_HOME/storages/workspace_agent_preset.json` now contains `W`'s workspace id → that preset id.
3. Create a new session in `W`: the chip shows the remembered preset, not the global default.
4. Stop the host. Hand-edit the stored `agentPreset` to an id that does not exist, then restart and create a new session in `W`: the session starts normally on the global default, and the host log carries one `agent-preset-per-workspace` warning.

## Known limitations

- **Orphaned bindings.** Removing a workspace and re-adding the same directory creates a fresh workspace id, so the old binding is never read again. It is one small record; nothing prunes it.
- **Sessions outside a registered workspace** have no workspace to key by, so they always use the global default.
- **Reused blank sessions are not re-defaulted.** Reopening a workspace whose existing blank session came from an earlier binding keeps that session as it is; the remembered preset applies to the *next* session created.
- **No UI to clear a binding.** Pick a different preset in that workspace, or delete the storage file while the host is stopped.
- **A binding survives a preset that disappears.** A preset you disabled and re-enable is honoured again without re-picking.

## License

MIT
