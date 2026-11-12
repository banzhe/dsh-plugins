/**
 * Test double for the `contextMenus` service.
 *
 * The owner (`@deepseek-ai/dsh-client-ui-context-menu`) is not a dependency of
 * this Bundle: the plugin restates the one member it uses, and this double
 * implements that restatement so a spec can inspect the contribution a plugin
 * registered and resolve it on demand.
 *
 * Extending `Service` under the service's own name is what lets
 * `export const inject = [..., 'contextMenus']` wait on this double the way it
 * waits on the real registry.
 *
 * Production code never imports this.
 */
import { Service, type Context } from '@deepseek-ai/cordis'
import type { FileMenuAction, FileTarget } from '../src/client/actions.ts'

/** One registered file-menu contribution. */
export interface Contribution {
  readonly id: string
  readonly target: string
  readonly order: number
  resolve(target: FileTarget, signal: AbortSignal): readonly FileMenuAction[] | Promise<readonly FileMenuAction[]>
}

export class ContextMenusDouble extends Service {
  private readonly contributions = new Map<string, Contribution>()

  constructor(ctx: Context) {
    super(ctx, 'contextMenus')
  }

  register(contribution: Contribution): () => void {
    this.contributions.set(contribution.id, contribution)
    return () => { this.contributions.delete(contribution.id) }
  }

  /** Throws when absent, so a spec cannot silently assert against a missing contribution. */
  contribution(id: string): Contribution {
    const found = this.contributions.get(id)
    if (found === undefined) throw new Error(`no live context-menu contribution "${id}"`)
    return found
  }

  /**
   * Resolve one contribution the way the registry does, through a fresh signal.
   * @param id - contribution id.
   * @param target - clicked destination.
   * @returns the rows the contribution built.
   */
  async resolve(id: string, target: FileTarget): Promise<readonly FileMenuAction[]> {
    return await this.contribution(id).resolve(target, new AbortController().signal)
  }
}
