# agent-preset-visibility — implementation notes

Moved out of the plugin's README, which now covers only features and installation.

Three version facts, measured, and the only ones this doc relies on:

- the DSH the desktop app **runs** is **0.2.1-rc.3**, unpacked at
  `%TEMP%\asar-dsh\dsh\node_modules\@deepseek-ai`; the source tree read for the
  line references below is the **0.2.1-rc.3** checkout at
  `F:\personal\dsh\deepseek-harness`, and every reference was cross-checked
  against the unpacked install;
- this workspace's `devDependencies` resolve from the catalog at
  **0.2.1-alpha.2** — that is the build typecheck and `tsdown` see;
- this Bundle's peers say `^0.2.1-alpha.2`, which **does** accept the running
  rc.3: DSH evaluates peer ranges with `{ includePrerelease: true }`
  (`packages/boot/app-boot/src/plugin-compatibility.ts:51-53`), so a prerelease of
  the same `0.2.1` tuple satisfies the range.

## What the Bundle is

One Host row (Config schema only) and one browser plugin:

| piece | file | role |
| --- | --- | --- |
| Host row | `src/index.ts` | the `hidden` settings field: `z.array(z.string()).default([]).volatile()` |
| roster filter | `src/client/remote.ts` | replaces the browser roster listing so hidden rows never reach a picker |
| pure rules | `src/client/visibility.ts` | `hiddenIds` / `visibleRoster` / `nextHidden`, unit-tested |
| page | `src/client/controller.ts`, `PresetVisibilitySection.tsx` | `settings.section` listing every preset with one checkbox per row |

Both halves are one package because the page only exists where the filter does:
the Host schema without the browser half would be an unwritable settings field,
and the browser half without the schema would have nowhere to persist the list.

## The four design checks

### 1. Where the filter lands: the browser roster read (primary)

The three web surfaces — new-session chip, session-header label, Settings roster —
read one listing. `packages/client/ui-agent-preset/src/client/settings-store.ts:70-78`
(`readRoster` → `ctx.remote.agentPresets.list()`) feeds the chip and the
header; `packages/client/ui-agent-preset/src/client/section-store.ts:48` makes
the same call for the Settings roster. That is the only place all three agree
on, and `packages/client/ui-agent-preset/src/client/settings-store.ts:119-127`
(`presetOptions`) is only a *second*, narrower filter for broken rows, not a
visibility point.

The method is replaceable: the api gateway installs every Remote method as an
own **configurable accessor** on the namespace service —
`packages/api/gateway/src/client/index.ts:687-701`
(`Object.defineProperty(this, method, { configurable: true, enumerable: true, get … })`),
and the installed build agrees (`dsh-api-gateway/lib/client.browser.js:1993-2006`).
`ctx.get('…')` / `ctx.remote.agentPresets` return a Cordis *traceable proxy*
(`vendor/cordis/src/utils.ts:117-125`, `:165-217`) that forwards
`defineProperty` to the service instance, so this Bundle re-defines
`list` as an accessor of its own and restores the original descriptor on
unload. Nothing is frozen: `Service` registers the plain instance
(`vendor/cordis/src/service.ts:42-59`).

Why the Host-side override (`ctx.get('agentPresets').list`, the fallback below)
is **not** the primary path: `AgentPresetRegistry.list`
(`packages/preset/agent-preset-registry/src/index.ts:193-205`) is also the
source of `remoteExportList` (`:210-214`) and nothing else, so filtering it
would cover every client with one edit — but the configuration page could then
never list a hidden preset again: no other endpoint returns the roster
(`compositionInventory`, `:403-413`, is not Remote-exported, and carries a
different shape). A page that cannot see what it hid cannot undo it.

### 2. Persistence semantics of `volatile()`

`volatile()` is **not** "keep it in memory for this process". It is the DSH
settings write path's precondition:

- The Loader hands a volatile field a **live reference**
  (`vendor/schemastery/src/index.ts:521-529` → `vendor/cosmokit/src/volatile.ts:39-45`):
  a frozen object whose `get()` returns an immutable snapshot. The plugin keeps
  the reference and reads `.get()` per operation.
- A config change that differs **only** in volatile fields does not remount the
  plugin: `vendor/loader/src/config/entry.ts:145-157` takes the "`volatileOnly`"
  branch and `:164-197` (`_commitVolatile`) writes the new values into the
  running references, then emits `loader/volatile-update`.
- The write itself is durable: `ctx.configForms` → `settings.mutate` →
  `configEditor.edit` rewrites the **profile patch YAML**
  (`packages/boot/config-editor/src/index.ts:87-153`, `writeFileAtomic(path…)`)
  and reconciles the Loader from it. That is a file under
  `$DSH_HOME/profiles/web/cordis.patch.yml`, so the list survives a restart.
- Conversely, a **non**-volatile field cannot be written from Settings at all:
  `packages/settings/settings/src/index.ts:386-390` refuses a path that is not
  volatile, and `packages/settings/settings/src/schema.ts:74-79`
  (`isVolatilePath`) is what the check consults.

So `hidden` **must** be `volatile`: without it the page's write is rejected,
and with it the write is both live and persistent. The default stays ordinary
data (`.default([])`), which is what makes "nothing hidden" the shipped state
without writing anything.

### 3. The page must see the full roster

Because the filter removes hidden rows from the listing the pickers use, the page
cannot read through the same call. `src/client/remote.ts` therefore captures the
**original accessor** at install time and exposes it as
`PresetRosterFilter.readAll`: the page asks the Host for the roster exactly as
the shipped surfaces would, gets every declared preset including the hidden ones,
and renders one checkbox per row. Nothing else was needed — no new Remote
namespace, no Host-side duplicate endpoint (a plugin cannot add one: the browser
assembly lists its Remote contributions explicitly at
`packages/api/remotes/src/client/index.ts:186-199`, and its contributions are
tsdown-generated).

The same captured listing serves the filter, so there is exactly one
`agentPresets/list` request shape in this Bundle.

### 4. The control: `Checkbox`

```tsx
export function Checkbox({ checked, onChange, label, disabled, title, className })
```

`packages/client/ui-primitives/src/Checkbox.tsx:16-31` — a controlled native
checkbox with a caller-owned visible + accessible label, exported from
`packages/client/ui-primitives/src/index.ts:32` and present in the 0.2.1-alpha.2
package this workspace installs (`lib/types/Checkbox.d.ts`; also `Switch.tsx`
for a two-state toggle). The running rc.3 ships no standalone copy of that
package — its shell carries the primitive compiled into the frontend bundle
(`@deepseek-ai/dsh-web-frontend` depends on
`@deepseek-ai/dsh-client-ui-primitives` 0.2.1-rc.3 and inlines it into
`dist/assets/index-*.js`), which is exactly why the specifier resolves from the
module table and needs no `dsh.client.external` entry. The page uses `Checkbox` rather than a shell `Menu`
because the setting is a **set**, not one choice, and rather than a hand-rolled
row because the primitive already carries the shell's checkbox geometry.
`ui-primitives` is one of the shell's seeded platform modules
(`packages/client/web/src/platform.ts:8-15`), so the bundle imports it as an
external and renders against the shell's own React instance.

## Surfaces

- `settings.section` id `agent-preset-visibility`, order 30 — one nav entry
  after the shipped **Agent presets** section (order 20), because this page
  adjusts the roster that section shows. A `plugins.row.config` card was
  rejected: this preference belongs to the picker, not to this Loader row.
- Registration is gated on `ctx.configForms.whileServed([NS], …)`, so the page
  appears only while the Host serves this plugin's settings namespace — the same
  gate `session-title-rules` uses for its row page.
- The page lists every preset, marks the default and any broken row, and shows
  `Shown` / `Hidden` per row. With the shipped `hidden: []` all rows render
  checked and the summary line reads "Every preset is shown".

## Writes: one list, queued toggles

Each write carries the **whole** hidden list (the settings path op is
`{ op: 'set', path: ['hidden'] }`), so the page owns the ordering of its own
writes instead of relying on the form's queue:

- a toggle is applied to the list the queue holds — the one already crossing the
  wire, when a write is in flight — and the rows repaint from that list
  immediately (`controller.ts`, `setHidden`), so a person clearing several rows
  in a row keeps every click and sees each one at once;
- `flush` sends the queued list and keeps it set across the `await`, so a toggle
  that lands mid-write folds into the list being sent rather than starting a new
  one from the stale section the Host has not stored yet; the list is cleared only
  when the write it sent is still the newest intent;
- a refusal drops the queue and reports `write`: every queued intent was derived
  from a list the Host never stored, so replaying it would toggle a different set
  than the one the person was looking at. The notice clears on the next accepted
  write — and on a successful roster read as well, since `load` clears it when the
  read succeeds (`controller.ts:134`), so pressing **Retry** removes a write
  refusal even when no write has succeeded.

The rows stay enabled during a write (`PresetVisibilitySection.tsx`) precisely
because the queue, not the disabled state, is what prevents a lost click.

## Known limits

- **Only the web Client is filtered.** The Host still serves the full roster
  (`packages/preset/agent-preset-registry/src/index.ts:210-214`) and so does any
  other client of the same Host. That is the price of a page that can undo its own
  hiding; see check 1.
- **A hidden preset also leaves the shipped Agent presets section.** All three
  surfaces read the one listing (check 1), so a hidden row disappears from the
  Settings roster too — including its "set as new task default" action. That is
  the same filter doing its job, and `agentPresetVisibility` is where the row is
  recovered; the page's intro says as much.
- **A picker that is already open does not re-render.** Each surface re-reads the
  roster when it next mounts — the chip on a new-session screen, the Settings
  roster when its section opens. The page says so ("Pickers re-read the roster the
  next time one opens").
- **Hiding the current default preset leaves the hero chip showing another one.**
  `packages/client/ui-agent-preset/src/client/seat-store.ts:113-114` reads the
  roster and then falls back to the first *listed* preset when no row carries
  `isDefault`, so the chip's displayed preset can disagree with what a new session
  will actually compose. The default itself is untouched, which is the behaviour
  asked for; the page marks the default row so the risk is visible before it is
  taken.
- **A write is refused when a Home patch overrides this row.** `configEditor`
  re-composes the layers and rejects a write whose effective config differs from
  the one it just wrote (`packages/boot/config-editor/src/index.ts:134-140`).
  Put `hidden` in the profile patch (what the page does), not in
  `$DSH_HOME/cordis.patch.yml`.
- **The override is not re-applied after the api-remotes plugin is reloaded.** The
  namespace service itself outlives a reconnect (`connection/reset` does not
  remount namespaces), but an HMR reload of `@deepseek-ai/dsh-api-remotes` would
  re-install `list` and drop the wrapper until the page is reloaded. If the
  accessor is not the expected shape at all, `src/client/index.ts:60-65` takes the
  same one decision for both halves: the plugin logs a warning, leaves every preset
  visible, and **does not register the page** — a page whose writes would have no
  effect is worse than no page — rather than guessing at another shape.

## Alternatives considered

- **Host-side `list` override** (`ctx.get('agentPresets').list`): one edit for
  every client, but the configuration page loses sight of hidden presets, and it
  changes a Host service other consumers read. Kept as the fallback for a
  deployment whose gateway does not expose a replaceable namespace accessor; it
  would need a second, unfiltered channel for the page.
- **`hidden`/`visible` on `PresetDefinition`** (`packages/preset/agent-preset-registry/src/definition.ts:5-11`):
  rejected — it means changing the DSH Host to carry a preference this repo does
  not own.
- **`disabled: true` on the preset rows**: rejected — a Home patch binds presets
  by `agentPreset:` before anything else can run — twelve such references in
  the Home patch, at lines 398, 415, 435, 851, 865, 879 and 1177-1252 of
  `C:\Users\asuka\.dsh\cordis.patch.yml` — so a preset that never registered
  breaks subagent delegation, and the brief forbids it.
- **Rewriting `selectedDefault` when the default is hidden**: rejected — the
  selection semantics are not this plugin's to change.
