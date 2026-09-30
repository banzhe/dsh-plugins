/**
 * Per-workspace agent preset memory. `agent-preset/selected` records the preset
 * a person picks by hand for that session's workspace; `agent/created` applies
 * the remembered preset to the next fresh session in it.
 *
 * See `docs/adr/0008-per-workspace-agent-preset.md`.
 *
 * @module @banzhe/dsh-agent-preset-per-workspace
 */

import type { Context } from '@deepseek-ai/cordis'
// Type-only: each applies its package's Cordis context and event augmentations.
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-preset-registry'
import type {} from '@deepseek-ai/dsh-agent-preset-registry/types'
import type {} from '@deepseek-ai/dsh-session'
// Type-only: `WorkspaceId`, plus the `workspaceRegistry` augmentation.
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace'
import { WORKSPACE_PRESET_TABLE, workspacePresetDomainSpec } from './domain.ts'
import { isTopLevelSession, needsSelect, needsWrite, shouldApplyOn } from './policy.ts'

export const name = 'agent-preset-per-workspace'

export const inject = ['agentPresets', 'sessions', 'storageDomain', 'workspaceRegistry']

export async function apply(ctx: Context): Promise<void> {
  const domain = await ctx.storageDomain.open(workspacePresetDomainSpec)
  ctx.effect(() => () => domain.close(), `${name}.domainClose`)
  const bindings = domain.table(WORKSPACE_PRESET_TABLE)

  /**
   * The sessions this plugin's own `select` is switching. `select` awaits its
   * remount before it appends, so a pick made in another session of the same
   * workspace while an apply is in flight is newer than the value being
   * applied; without this mark the apply's own event arrives after that pick
   * and writes the older id back over it.
   */
  const selfApplied = new Set<string>()

  /** `resolveByPath` rejects for a directory that no longer exists. */
  const workspaceIdOf = async (cwd: string | undefined): Promise<WorkspaceId | undefined> => {
    if (cwd === undefined) return undefined
    try {
      return (await ctx.workspaceRegistry.resolveByPath(cwd))?.id
    } catch (error) {
      ctx.logger.debug(`${name}: no workspace for "${cwd}": ${String(error)}`)
      return undefined
    }
  }

  const record = async (cwd: string | undefined, agentPreset: string): Promise<void> => {
    const workspaceId = await workspaceIdOf(cwd)
    if (workspaceId === undefined) return
    if (!needsWrite(bindings.get(workspaceId), agentPreset)) return
    await bindings.put(workspaceId, { agentPreset, updatedAt: new Date().toISOString() })
    ctx.logger.info(`${name}: workspace "${workspaceId}" now defaults to preset "${agentPreset}"`)
  }

  ctx.on('agent-preset/selected', (sessionId, agentPreset) => {
    if (selfApplied.has(sessionId)) return
    const header = ctx.sessions.get(sessionId)?.header
    if (header === undefined || !isTopLevelSession(header)) return
    void record(header.cwd, agentPreset).catch((error: unknown) => {
      ctx.logger.warn(`${name}: remembering preset "${agentPreset}" failed: ${String(error)}`)
    })
  })

  ctx.on('agent/created', async ({ agent, source }) => {
    // A serial listener's rejection fails agent creation, so a preset that no
    // longer resolves has to stop here instead of propagating.
    try {
      if (!shouldApplyOn(source)) return
      const header = agent.session.header
      if (!isTopLevelSession(header)) return
      const workspaceId = await workspaceIdOf(header.cwd)
      if (workspaceId === undefined) return
      const remembered = bindings.get(workspaceId)?.agentPreset
      if (!needsSelect(remembered, header.agentPreset)) return
      selfApplied.add(agent.id)
      try {
        await ctx.agentPresets.select(agent, remembered)
      } finally {
        selfApplied.delete(agent.id)
      }
      ctx.logger.info(`${name}: session "${agent.id}" started with workspace preset "${remembered}"`)
    } catch (error) {
      ctx.logger.warn(
        `${name}: session "${agent.id}" keeps the global default; `
        + `the workspace preset could not be applied: ${String(error)}`,
      )
    }
  })
}
