/**
 * Per-workspace agent preset memory. `agent-preset/selected` records the preset
 * a person picks by hand for that session's workspace; `agent/created` applies
 * the remembered preset to the next fresh session in it, and
 * `sessionController.create` receives it up front so reusing a blank session
 * cannot resolve the omitted preset to the global default first.
 *
 * See `docs/adr/0008-per-workspace-agent-preset.md`.
 */

import type { Context } from '@deepseek-ai/cordis'
// Type-only: each applies its package's Cordis context and event augmentations.
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-preset-registry'
import type {} from '@deepseek-ai/dsh-agent-preset-registry/types'
import type { SessionId } from '@deepseek-ai/dsh-session'
// Type-only: `WorkspaceId`, plus the `workspaceRegistry` augmentation.
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace'
import { WORKSPACE_PRESET_TABLE, workspacePresetDomainSpec } from './domain.ts'
import { isPresetResolutionError, isTopLevelSession, needsSelect, needsWrite, shouldApplyOn } from './policy.ts'

export const name = 'agent-preset-per-workspace'

export const inject = ['agentPresets', 'sessions', 'storageDomain', 'workspaceRegistry']

/** The part of a `sessionController.create` request this Bundle reads and forwards. */
export interface SessionCreateRequestLike {
  readonly sessionId?: string
  readonly workspaceId?: WorkspaceId
  readonly cwd?: string
  readonly agentPreset?: string
  readonly [key: string]: unknown
}

/** `sessionController` as this Bundle needs it: one call, structurally typed. */
export interface SessionControllerLike {
  create(request?: SessionCreateRequestLike): Promise<unknown>
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    sessionController: SessionControllerLike
  }
}

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

  /**
   * A request that omits `agentPreset` is resolved to the global default before
   * the session exists, so reusing a blank session (`reuseLive` / `reuseSetup`)
   * would commit that default first and let its own echo overwrite the binding.
   * Supplying the remembered preset in the request keeps both where they were;
   * a preset that no longer resolves falls back to the original request.
   */
  ctx.inject(['sessionController'], (controllerCtx) => {
    controllerCtx.effect(() => {
      const controller = controllerCtx.sessionController
      // Restoring the same reference is what makes unload invisible to callers,
      // so this one reference must survive unbound; every call below passes
      // `controller` as `this` explicitly.
      // oxlint-disable-next-line typescript/unbound-method
      const originalCreate = controller.create

      controller.create = async function create(request: SessionCreateRequestLike = {}): Promise<unknown> {
        if (request.agentPreset !== undefined) return await originalCreate.call(controller, request)
        const sessionId = request.sessionId
        const existing = sessionId === undefined ? undefined : ctx.sessions.get(sessionId as SessionId)
        if (existing !== undefined && !isTopLevelSession(existing.header)) {
          return await originalCreate.call(controller, request)
        }
        const workspaceId = request.workspaceId ?? await workspaceIdOf(request.cwd ?? existing?.header.cwd)
        if (workspaceId === undefined) return await originalCreate.call(controller, request)
        const remembered = bindings.get(workspaceId)?.agentPreset
        if (remembered === undefined) return await originalCreate.call(controller, request)
        if (sessionId !== undefined) selfApplied.add(sessionId)
        try {
          const injected: SessionCreateRequestLike = { ...request, agentPreset: remembered }
          return await originalCreate.call(controller, injected)
        } catch (error) {
          if (!isPresetResolutionError(error)) throw error
          ctx.logger.warn(
            `${name}: workspace "${workspaceId}" preset "${remembered}" could not be applied `
            + `on create; falling back to global default: ${String(error)}`,
          )
          return await originalCreate.call(controller, request)
        } finally {
          if (sessionId !== undefined) selfApplied.delete(sessionId)
        }
      }

      return () => {
        controller.create = originalCreate
      }
    }, `${name}.sessionCreate`)
  })
}
