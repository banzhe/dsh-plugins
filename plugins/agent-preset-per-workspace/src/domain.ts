/**
 * The per-workspace preset memory: one record per {@link WorkspaceId}, keyed by
 * the same canon the workspace registry uses for session membership, so a
 * workspace renamed in place keeps its preset while a removed and re-added
 * directory starts fresh.
 *
 * @module @banzhe/dsh-agent-preset-per-workspace/domain
 */

import { z } from 'zod'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace'

const presetBindingSchema = z.object({
  /** A bare id: a preset that is gone today is resolved at apply time, not here. */
  agentPreset: z.string().min(1),
  /** ISO-8601 instant of the last hand pick; nothing branches on it. */
  updatedAt: z.string().min(1),
})

export type PresetBinding = z.infer<typeof presetBindingSchema>

/** Doubles as the backend unit name. */
export const WORKSPACE_PRESET_DOMAIN = 'workspace_agent_preset'

export const WORKSPACE_PRESET_TABLE = 'bindings'

/** No global slot: an absent record already means "this workspace remembers nothing". */
export const workspacePresetDomainSpec = defineDomain({
  name: WORKSPACE_PRESET_DOMAIN,
  version: 1,
  tables: { [WORKSPACE_PRESET_TABLE]: domainTable<WorkspaceId, PresetBinding>(presetBindingSchema) },
})
