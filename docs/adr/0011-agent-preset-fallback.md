# Rescue stranded presets at the registry seam, not at creation

`packages/api/session-controller/src/agent.ts` composes every adopted or newly created session through `composeAgent(presetId)`, which first resolves and then mounts: `presets.resolve(presetId)` at `agent.ts:365`, then `presets.mount` → `AgentPresetRegistry.retain` at `agent-preset-registry/src/index.ts:632`. Both reject with `agent-preset/not-found` (and `retain` additionally with `agent-preset/invalid`, straight off `definitions` without a resolve pass) when the identity is gone, and both rejections propagate out of `createOrAdopt` (`agent.ts:414-445`) as a failed `session/create`. The web client's `reuseOrCreateBlank` (`dsh-client-ui-workspace/src/client.ts:1424`) does not treat that rejection as "fall through and create a fresh session" — the only fallback it owns is `session/writer-held` (`:1434`) — so the user sees `createFailed` and the blank session stays stranded forever.

## Why the seam is the registry, not the caller

Patching the client is impossible from a Bundle (the fallback must work for every client, including ones already open), and patching the session-controller is the same problem one layer up. The registry is the single place every reader passes through — but two constraints shape the mechanism:

- `agentPresets` admits exactly one provider (`packages/preset/agent-preset-registry/src/index.ts:451` — `super(ctx, "agentPresets")` on the `TypertRemoteService` base). A companion plugin cannot `provide` a replacement; the base service and the rescue would fight over the name and one of them loses at load.
- The registry's own composition path dispatches dynamically: `mount` calls `this.retain(ctx, id)` (`:686-687`). Replacing prototype methods or wrapping the exported class misses that dispatch, because a new wrapper class's instances reach the *original* prototype's `retain` unless every method is copied.

Writing instance-level own properties (`registry.resolve = ...`, `registry.retain = ...` in `src/index.ts`) satisfies both: JavaScript property lookup prefers own over prototype, so *both* external readers and internal `this.retain` dispatch hit the wrapper, while the prototype originals remain untouched and uninstall restores them (`delete registry.resolve`).

## The rescue rule

`resolve` and `retain` fail for exactly two rescuable conditions: the identity never existed or was removed (`agent-preset/not-found`), or its composition failed to install (`agent-preset/invalid`). Both are "this preset cannot compose a session" states that a sensible default recovers from — so both retry against `registry.defaultId`. Two exclusions:

- The wanted id equal to `defaultId` is never rescued. Retrying the same missing default would recurse; and if the default itself is gone, the error *should* surface, because there is nothing to fall back to. The config `default` is deployment-owned and validated, so this is a "should never happen" path left honest.
- Codes outside the set — `agent-preset/locked` ("session already started") and any non-`RemoteError` — propagate. `locked` means the composition is fine but the timing is wrong; rescuing it would mask real state-machine bugs. Discrimination is by `error.code` only: `RemoteError` subclasses do not survive a cross-package `instanceof` check reliably, and the objects carry `code`/`details` as own properties.

## Why not also repair storage

The stale `agentPreset` in the session header/projection and the `workspace_agent_preset` bindings written by `@banzhe/dsh-agent-preset-per-workspace` keep pointing at the gone id. That is deliberate: per-workspace binding revival is a real feature (reinstall the preset, old workspaces light up again), and per-session stored presets come back the same way. `@banzhe/dsh-agent-preset-per-workspace` only ever *selects* a remembered preset through `select` → `recompose` → `mount` → the patched `retain`, so a rescued `retain` returning the default revision silently degrades an apply of a dead preset into "session keeps the default, stale binding survives" — the same non-destructive outcome that plugin's ADR (`docs/adr/0008-per-workspace-agent-preset.md`, "Fallback is do nothing") specifies, now without failing creation.

## What still fails

Admin/reader paths (`readDocument`, roster `list`) reject with their own raw `not-found` and are deliberately untouched: no session creation depends on them. And the rescue cannot conjure a preset back — it maps gone → default, which re-renders stranded sessions with the deployment default's tool set. A user who wants the old composition back re-declares it (same preset id) and restarts.

## Verified against the web profile

Reproduced the failure before the fix (`plugins/agent-preset-fallback` absent): create a blank session under `D:/personal/preset-gone-test` with preset `fragile-test` (declared via a temporary `cordis.patch.yml` overlay), remove that overlay, restart, then try to reuse the blank session — `session/create` fails with `agent-preset/not-found: Unknown agent preset: fragile-test`. After installing and rebuilding the Bundle, the same strand composes as the default (`standard`) and the session is usable.