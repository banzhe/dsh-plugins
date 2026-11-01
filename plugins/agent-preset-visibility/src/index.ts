/**
 * Host half: the declaration the settings page writes.
 *
 * Hiding a preset is a list filter, not a registration change. `hidden` names
 * presets the browser roster leaves out; every declaration still registers, so
 * `agentPresets.select`/`resolve`/`mount` and subagent delegation behave exactly
 * as before — a Home patch binds presets by `agentPreset:`, and a preset that
 * never registered could not be bound. The filter itself lives in
 * `src/client/index.ts`, where the roster request is answered.
 *
 * `hidden` is `volatile` because only volatile fields are writable from
 * Settings (`packages/settings/settings/src/index.ts:386-390`): a write lands in
 * the profile patch YAML through `configEditor` and commits into this live
 * reference without a remount, so the list survives a restart AND takes effect
 * without one.
 */

import type { Context, Volatile } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'

/** Loader row id; also the settings namespace the page edits. */
export const name = 'agent-preset-visibility'

/** Row config as the running plugin reads it. */
export interface Config {
  /** Preset ids the web roster leaves out; empty shows every preset. */
  hidden: Volatile<readonly string[]>
}

/**
 * Live schema the settings page edits, and the entry's own settings-section
 * shape.
 *
 * Deliberately not annotated `z<Config>`: the interface describes the runtime
 * config with a `Volatile` reference, while the schema's own output type is the
 * plain field type. `exactOptionalPropertyTypes` makes the annotated form
 * unassignable, and DSH's live-preference plugins keep the two apart the same
 * way.
 */
export const Config = z.object({
  hidden: z.array(z.string()).default([]).volatile(),
})

/**
 * Load the row. Nothing is filtered here on purpose: the Host `agentPresets`
 * service keeps serving the full roster, so `resolve`, `select`, `mount`,
 * `compositionInventory` and every other Host consumer keep their behaviour. The
 * row exists for its Config schema — the contract the browser page writes and
 * the list the browser roster read filters on.
 * @param _ctx - the Host plugin context; this half registers no service.
 */
export function apply(_ctx: Context): void {}
