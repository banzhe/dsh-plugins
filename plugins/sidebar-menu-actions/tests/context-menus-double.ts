/**
 * Test double for the `contextMenus` service.
 *
 * The published `@deepseek-ai/dsh-client-ui-context-menu/client` entry is a
 * BROWSER bundle, so a Node spec cannot import its implementation. This double
 * implements the two members this plugin's `apply` touches — `register` and
 * `notify` — and records what it received.
 *
 * `register` returns a plain disposer and deliberately does NOT wrap the
 * registration in an effect of its own: withdrawing the contribution on unload
 * is the plugin's cleanup, and a double that performed it would hide a plugin
 * that never does. The unload specs therefore assert the effect the plugin
 * owns, not the double's convenience.
 *
 * Production code never imports this: every cross-package import in `src/` is
 * type-only, so the shipped browser bundle has no runtime imports at all.
 */
import { Service, type Context } from '@deepseek-ai/cordis'
import type { MenuAction } from '@deepseek-ai/dsh-client-ui-context-menu/client'

/** The contribution fields the specs read back. */
export interface RecordedContribution {
  readonly id: string
  readonly target: string
  readonly order: number
  readonly resolve: (
    target: unknown,
    signal: AbortSignal,
  ) => readonly MenuAction[] | Promise<readonly MenuAction[]>
}

/** One `notify` call: the localized text and the success flag as passed. */
export interface RecordedNotice {
  readonly text: string
  readonly success: boolean | undefined
}

export class ContextMenusDouble extends Service {
  private readonly contributions = new Map<string, RecordedContribution>()
  private readonly notices: RecordedNotice[] = []

  constructor(ctx: Context) {
    super(ctx, 'contextMenus')
  }

  register(contribution: RecordedContribution): () => void {
    this.contributions.set(contribution.id, contribution)
    return () => { this.contributions.delete(contribution.id) }
  }

  notify(text: string, success?: boolean): void {
    this.notices.push({ text, success })
  }

  /** Contributions still registered, in registration order. */
  get live(): readonly RecordedContribution[] {
    return [...this.contributions.values()]
  }

  /** Every `notify` call recorded so far, in call order. */
  get notifications(): readonly RecordedNotice[] {
    return [...this.notices]
  }

  contribution(id: string): RecordedContribution {
    const found = this.contributions.get(id)
    if (found === undefined) throw new Error(`no live context-menu contribution "${id}"`)
    return found
  }
}
