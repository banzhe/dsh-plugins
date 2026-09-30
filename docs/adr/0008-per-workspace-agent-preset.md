# Per-workspace agent preset, observed and applied rather than resolved

DSH resolves an agent preset in three layers, none keyed by workspace: the deployment `default`, the global user setting `selectedDefault`, and the per-session choice committed to that session's log (`packages/preset/agent-preset-registry/src/index.ts:74`). `@banzhe/dsh-agent-preset-per-workspace` adds the fourth layer without touching any of them.

## The seam

`AgentPresetRegistry.resolve`/`defaultId` are plain class methods and `agentPresets` admits exactly one provider, so a plugin cannot replace the host default — only observe its consequences. Two observations are enough:

- `agent-preset/selected(sessionId, agentPreset)` is re-emitted by the registry for every selection it commits to a log, and **only** for those. A session's creation-time composition happens in `composeAgent`'s setup callback through `presets.mount`, which never appends the event (`packages/api/session-controller/src/agent.ts:381-397`). So the event means precisely "a person changed this session's preset by hand" — no diffing and no client cooperation needed to tell a pick from a creation.
- `agent/created` is a serial, awaited event dispatched inside `AgentRegistry.announce` (`packages/core/agent/src/index.ts:550`), which the agent loop holds queued input behind. Switching the preset there lands before the session is addressable and before its first turn, which is the only window `select` accepts (`agent-preset/locked` afterwards).

Being able to *read* the event is not the whole story, because the applier's own `select` produces one too. `select` awaits its remount before it appends, so a person can pick a different preset in the same workspace — in another session — while an apply is in flight; that pick is newer and must win. An in-memory mark of the session the applier is switching (`selfApplied` in `src/index.ts`) suppresses the echo, and it is the only thing that does: by the time the echo arrives the stored binding already holds the newer pick, so the "nothing changed" write guard would say "write" and put the older id back.

The chip and resume both read the `agentPreset` session projection, which the applied selection advances, so no client change is needed and the GUI cannot disagree with the host.

## Keying by `WorkspaceId`, not by path

`ctx.workspaceRegistry.resolveByPath` canonicalizes through `fs.realpath` and returns the owning workspace, whose `id` is a generated uuid that survives a rename (`packages/workspace/workspace/src/types.ts:12-16`). That is the same canon the workspace registry already uses for session membership, so a binding means the same thing the sidebar does. The cost is that removing a project and re-adding the same directory starts a fresh project — deliberately so, and this memory starts fresh with it.

## Fallback is "do nothing"

A remembered preset that no longer resolves is not repaired, not pruned, and not allowed to break session creation. `AgentPresetRegistry.select` retains the requested definition before it binds anything, so a miss or a failed activation rejects with the agent still composed exactly as it was created — the deployment or global default. The stale record is kept on purpose: a preset that comes back is honoured again without the user re-picking.

## Recorded as a pick: the Settings default

`ui-agent-preset`'s "Set as new task default" writes the global `selectedDefault` and then calls the same `select` on the current blank session (`packages/client/ui-agent-preset/src/client/settings-store.ts:28`, `seat-store.ts:176`). At the host seam that pair is indistinguishable from a chip pick, and correlating it with `settings/document-updated` would be a timing heuristic. It is therefore counted as a pick, under the plugin's single rule: a workspace's default is the preset the user last confirmed by hand inside that workspace. The alternative — silently dropping the workspace's own choice whenever the global default changes — would defeat the feature.

## Consequences

Host-side storage only, in a `workspace_agent_preset` domain over the composition's configured backend. Orphaned bindings after a workspace removal are one small record and are never pruned. Subagents, forks, resumes, clears, and compactions keep the composition their parent or their log established, because only a fresh top-level `startup` creation is uncomposed.
