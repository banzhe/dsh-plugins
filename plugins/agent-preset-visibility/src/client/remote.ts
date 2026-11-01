/**
 * The one seam that makes hiding possible without touching the Host.
 *
 * Every web roster surface reads `ctx.remote.agentPresets.list` — the
 * new-session chip, the session header, and the Settings roster share
 * `readRoster` — and the api gateway installs that method as a CONFIGURABLE own
 * accessor on the namespace service
 * (`packages/api/gateway/src/client/index.ts:687-701`). Replacing the accessor
 * therefore filters all three surfaces at their single read point, while
 * `resolve`/`select`/`mount` — Host methods a picker never calls — stay
 * untouched. See `docs/plugins/agent-preset-visibility.md` for why the Host-side
 * alternative was rejected.
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
// Type-only: the ctx.remote merge, the agentPresets namespace face, and RemoteResult.
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type { RemoteResult } from '@deepseek-ai/dsh-api-remotes/client'
import type { AgentPresetRoster } from '@deepseek-ai/dsh-agent-preset-registry/types'
import { visibleRoster } from './visibility.ts'

/** One roster read, with the failure branch the picker already handles. */
export type PresetListing = () => Promise<RemoteResult<AgentPresetRoster>>

/** The roster seam, split into what the page reads and what the picker sees. */
export interface PresetRosterFilter {
  /** The unfiltered listing, exactly as the shipped surfaces would have called it. */
  readonly readAll: PresetListing
  /**
   * Replace the namespace's listing with one that drops hidden rows.
   * @param hidden - reads the live hidden set, so one install follows every edit.
   * @returns the restore, which is a no-op once someone else owns the property.
   */
  readonly install: (hidden: () => ReadonlySet<string>) => () => void
}

/**
 * Take the roster seam, or report that this deployment does not offer it.
 *
 * A namespace without the expected accessor (a different gateway build, or a
 * namespace mounted as a plain property) is left alone: guessing at its shape
 * would break the picker instead of filtering it.
 * @param ctx - the browser plugin context carrying the Remote namespaces.
 * @returns the seam, or undefined when the listing is not replaceable.
 */
export function presetRosterFilter(ctx: ClientContext): PresetRosterFilter | undefined {
  const namespace = ctx.remote.agentPresets
  const accessor = Object.getOwnPropertyDescriptor(namespace, 'list')
  if (accessor === undefined || accessor.get === undefined) return undefined
  // Bound once, to the namespace service itself: `agentPresets/list` is a DIRECT
  // invocation, so the gateway consults the caller context only for a
  // context-scoped method (this one is not), and the accessor rebuilds its own
  // listing on every read anyway.
  const listingOf = accessor.get.bind(namespace) as () => PresetListing
  const readAll: PresetListing = () => listingOf()()
  const install = (hidden: () => ReadonlySet<string>): (() => void) => {
    const filtered = function (): PresetListing {
      return async () => {
        const result = await readAll()
        return result.ok ? { ok: true, value: visibleRoster(result.value, hidden()) } : result
      }
    }
    Object.defineProperty(namespace, 'list', { configurable: true, enumerable: true, get: filtered })
    return () => {
      if (Object.getOwnPropertyDescriptor(namespace, 'list')?.get !== filtered) return
      Object.defineProperty(namespace, 'list', accessor)
    }
  }
  return { readAll, install }
}
