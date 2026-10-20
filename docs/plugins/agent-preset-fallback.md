# agent-preset-fallback — implementation notes

Moved out of the plugin's README, which now covers only features and installation.

## What it fixes

A blank session that a workspace reuses remembers the agent preset it was
composed with (`agentPreset` in the session header/projection). When that
preset's declaration is later removed — a Bundle upgrade dropping it, an edited
profile patch rename, a plugin uninstall — reusing the stranded blank session
runs `composeAgent(storedPreset)`, whose `resolve` rejects with
`agent-preset/not-found`; the whole `session/create` then fails and the Web UI
only shows a generic "create failed" notice. Restarting the host has the same
effect on any session recorded with a preset that is now gone.

## Mechanism

`agentPresets` admits exactly one provider, so the registry singleton cannot be
re-provided; and `mount` reaches `retain` through `this.retain`, so only an own
property on the singleton intercepts both external readers (the session
controller's `resolve`) and the registry's internal dispatch. The plugin writes
instance-level `resolve`/`retain` wrappers that, for `agent-preset/not-found`
and `agent-preset/invalid` on a non-default id, retry against the current
default. A guarded uninstall deletes the own properties and restores the
prototype methods.

Codes outside the rescue set (`agent-preset/locked`, foreign errors) and the
default id itself (whose absence would otherwise recurse) propagate untouched.

## Test

```sh
pnpm --filter @banzhe/dsh-agent-preset-fallback test
```
