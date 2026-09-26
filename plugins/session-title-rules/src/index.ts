/**
 * Rules-based session-title provider: `emoji 主题`, plus the `/title-refresh`
 * command that re-derives a title on demand.
 *
 * Replaces the built-in `session-title-first-prompt-llm` provider — the
 * `session-title-llm` Loader row this Bundle's patch disables. The service
 * still owns scheduling, result validation, and the `session/title` append;
 * `./title.ts` owns the derivation, and this module is the Loader row: the
 * `Config` schema, the two live reads its adapter performs, and registration.
 *
 * Unlike the shipped providers it appends no log-only
 * `session/title-llm-request` audit row: `@deepseek-ai/dsh-session-title-llm`
 * keeps its system prompt private and hardcodes its own framing, so none of its
 * call policy is reusable for these rules.
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Volatile } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { SessionTitleProviderId } from '@deepseek-ai/dsh-session-title'
import type { SessionTitleProviderRequest, SessionTitleProviderResult } from '@deepseek-ai/dsh-session-title'
import { registerTitleRefreshCommand } from './command.ts'
import { deriveTitle, type TitlePolicy } from './title.ts'

/** Loader row id, package identity, and the provider id recorded with each title. */
export const name = 'session-title-rules'

/** Services that must exist before the provider registers. */
export const inject = ['sessionTitle', 'llm']

/**
 * Deployment policy: an explicit auxiliary route, plus the reasoning effort to
 * drive it with.
 *
 * Every field is optional AND `volatile`, which is what lets the Settings page
 * write it without restarting the plugin: the Loader hands a volatile field a
 * live reference, so the adapter reads the CURRENT value at each call instead
 * of the one captured at load. Omitting all three keeps the original behaviour
 * (follow the Session's logged `request/header` route).
 *
 * This is the only place `Volatile` appears. `deriveTitle` takes plain values,
 * so the "read live on every call" invariant is enforced HERE, by building the
 * policy inside the `generate` closure — the one spot that must not hoist the
 * three `.get()` calls out of it.
 *
 * The pair is validated in `deriveTitle`, NOT by the schema: an unpaired
 * `provider`/`model` is a configuration mistake the settings page must be able
 * to explain, and a schema `required` would instead reject the whole entry at
 * load.
 */
export interface Config {
  /** Explicit auxiliary provider route; must be paired with `model`. */
  provider: Volatile<string | undefined>
  /** Explicit auxiliary model id; must be paired with `provider`. */
  model: Volatile<string | undefined>
  /** Reasoning effort for the auxiliary call; omission follows the route default. */
  reasoningEffort: Volatile<string | undefined>
}

/**
 * Live policy schema; also the `session-title-rules` settings-section shape.
 *
 * Deliberately NOT annotated `z<Config>`: the interface describes the entry's
 * runtime config with `Volatile` references, while the schema's own output type
 * is the plain field type. DSH's other live-preference plugins keep the two
 * apart the same way, and `exactOptionalPropertyTypes` makes the annotated form
 * unassignable.
 */
export const Config = z.object({
  provider: z.string().volatile(),
  model: z.string().volatile(),
  reasoningEffort: z.string().volatile(),
})

/** Read the live policy once, for one call. Never hoisted out of `generate`. */
function policyOf(config: Config | undefined): TitlePolicy {
  return {
    provider: config?.provider.get(),
    model: config?.model.get(),
    reasoningEffort: config?.reasoningEffort.get(),
  }
}

/**
 * Bind this Loader row's row-config and the two Host services onto one
 * derivation call.
 *
 * The adapter reads exactly two things the module does not: the live policy
 * (above) and the service's standing title, which the module takes as a value
 * for the same reason `request.route` already arrives as one.
 */
function deriveFrom(ctx: Context, config: Config | undefined, request: SessionTitleProviderRequest): Promise<SessionTitleProviderResult> {
  return deriveTitle({
    policy: policyOf(config),
    request,
    currentTitle: ctx.sessionTitle.get(request.session)?.title,
    llm: ctx.llm,
  })
}

/**
 * Register the rules-based provider. `first-prompt` derives the title once, from
 * the Session's opening message: the service schedules it only for a top-level
 * Session's first eligible human message, before any title exists.
 *
 * Also contributes `/title-refresh`, which mounts only where a command registry
 * is composed.
 */
export function apply(ctx: Context, config?: Config): void {
  ctx.sessionTitle.register({
    id: SessionTitleProviderId(name),
    automatic: 'first-prompt',
    generate: request => deriveFrom(ctx, config, request),
  })
  registerTitleRefreshCommand(ctx)
}
