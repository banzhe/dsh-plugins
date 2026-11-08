/**
 * The Host half of the Dev Container / Docker Sandbox Bundle: the Linux runtime
 * context and the two derived preset tracks (`… (devContainer)`, `… (sbx)`).
 *
 * Neither half provides a service, so this row has no `inject` requirement: it
 * waits for `systemPrompt` to listen, and reads `loader`/`agentPresets` only when
 * a composition supplies them.
 *
 * The variant set is a SETTING, not a constant: `sources` (the Dev Container
 * track, written by the settings page) and `sbxSources` (the Docker Sandbox
 * track) are volatile fields, so a write lands in this live reference and in the
 * profile patch, and each write re-derives the whole set immediately — the newly
 * checked source registers, the unchecked one disposes. Nothing is derived until
 * someone asks for it.
 *
 * @module @banzhe/dsh-devcontainer
 */

import type { Context, Volatile } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { PromptAssembly } from '@deepseek-ai/dsh-system-prompt'
// Type-only: the `settings/document-updated` event this row follows.
import type {} from '@deepseek-ai/dsh-settings'
import type {} from '@deepseek-ai/dsh-working-directory'
import { containerOptionFields, containerOptions, presetSourceFields } from './options.ts'
import { toContainerPath } from './paths.ts'
import {
  applyContainerContext, containerContextText, hostDirectoryFromContext, missingContainerContextText, sbxContextText,
} from './prompt.ts'
import { asDeclaration, PRESET_MODULE } from './presets.ts'
import type { PresetDeclaration } from './presets.ts'
import { installPtcCwdMapping } from './ptc.ts'
import {
  containerPresetOf,
  DEVCONTAINER_ENV_KEY,
  DEVCONTAINER_ENV_VALUE,
  DEVCONTAINER_PRESET_ENV_KEY,
  presetKindOf,
  SBX_ENV_KEY,
  SBX_ENV_VALUE,
  SBX_PRESET_ENV_KEY,
} from './refusal.ts'
import type { PresetLookup } from './refusal.ts'
import { repoRegistry } from './registry.ts'
import { installSpawnCwdMapping, repositoryOfPath } from './subprocess.ts'
import { sandboxNameFor, sbxSpecFor, sbxWorkspaceRootFor } from './sbx.ts'
import { VariantSync } from './variants.ts'
import type { VariantRegistryLike } from './variants.ts'
import type { ContainerOptions } from './types.ts'

/** Plugin name used by the Loader row, and the settings namespace the page edits. */
export const name = 'devcontainer'

/** How deep a derived preset may follow its subagent routes. */
const MAX_VARIANT_DEPTH = 4

/** The host-level event a settings write emits once the entry's config changed. */
const SETTINGS_UPDATED = 'settings/document-updated'

/** The Loader event a volatile-only config change commits through. */
const VOLATILE_UPDATED = 'loader/volatile-update'

/**
 * The settings namespace the shipped preset surfaces watch for roster changes.
 *
 * They re-read `agentPresets.list` when `settings/document-updated` names the
 * preset REGISTRY entry (`packages/client/ui-agent-preset/src/client/index.ts:164-167`),
 * which is the only roster-refresh signal a third-party registration can reach.
 */
const PRESET_REGISTRY_NS = 'agent-preset-registry'

/** Labelling and gating the schema also supplies, kept here for the runtime read. */
const VARIANT_DEFAULTS: PresetVariantConfig = {
  enabled: true,
  win32Only: true,
  orderOffset: 1,
}

/** How the derived variants are built and labelled. */
export interface PresetVariantConfig {
  /** Register variants at all (default true); a false row is a pure container shell. */
  enabled: boolean
  /**
   * Only derive on win32 (default true): the platform where presets ship
   * `pwsh` instead of `bash`. Elsewhere the variants would be duplicates.
   */
  win32Only: boolean
  /**
   * Added to the source preset's `order` so the variant sorts right after it.
   *
   * The display suffix is not configurable: it is what the shell row reads back
   * to know which marker a preset needs, so it is owned by `src/ids.ts`.
   */
  orderOffset: number
}

/** Plugin config. */
export interface Config extends ContainerOptions {
  /** Source preset ids the page asked to derive a `… (devContainer)` variant from; empty derives nothing. */
  sources: Volatile<readonly string[]>
  /** Source preset ids the profile asked to derive a `… (sbx)` variant from; empty derives nothing. */
  sbxSources: Volatile<readonly string[]>
  presets: PresetVariantConfig
}

/**
 * The live schema the settings page edits and the Loader validates.
 *
 * Deliberately not annotated `z<Config>`: the interface describes the runtime
 * config (`sources` is a `Volatile` reference), while the schema's own output is
 * the plain field type.
 */
export const Config = z.object({
  ...containerOptionFields(),
  ...presetSourceFields(),
  presets: z.object({
    enabled: z.boolean().default(true),
    win32Only: z.boolean().default(true),
    orderOffset: z.number().default(1),
  }),
})

/** The subset of the Cordis Loader this row reads, kept structural so the Bundle needs no Loader dependency. */
interface LoaderEntryLike {
  readonly options: { readonly name: string; readonly config?: unknown }
}

interface LoaderLike {
  await(): Promise<void>
  entries(): Iterable<LoaderEntryLike>
}

/** The subset of the preset registry this row calls. */
type PresetRegistryLike = VariantRegistryLike

/** Read one service without a typed `Context` augmentation. */
function serviceOf(ctx: Context, service: string): unknown {
  return (ctx as unknown as { get(name: string): unknown }).get(service)
}

/** The host directory one assembly is about. */
function hostDirectoryOf(ctx: Context, assembly: PromptAssembly, agent: Agent | undefined): string | undefined {
  if (agent === undefined) return hostDirectoryFromContext(assembly)
  const workingDirectory = serviceOf(ctx, 'workingDirectory') as { get(session: Agent['session']): string } | undefined
  return workingDirectory === undefined
    ? hostDirectoryFromContext(assembly)
    : workingDirectory.get(agent.session)
}

/**
 * Load the row: rewrite the working-directory context, and keep the derived
 * preset set equal to the two stored source lists.
 *
 * Deliberately the module's only plugin export besides its schema and name: the
 * Loader's `unwrapExports` prefers a `default` export, and a `default`-exported
 * `apply` would be the whole plugin — losing this module's `Config`, so the row
 * would activate with the raw (absent) config instead of the resolved one.
 * @param ctx - the Host plugin context.
 * @param configured - this row's resolved config; absent when the row declares none.
 */
export function apply(ctx: Context, configured?: Config): void {
  const config: Config = configured ?? ({} as Config)
  ctx.inject(['systemPrompt'], (child: Context) => {
    child.on('system-prompt/assemble', async (_assembly, context, next) => {
      // Prepend runs this listener first, so `next()` returns after the
      // working-directory service wrote its final text.
      const result = await next()
      const agent = context.agent
      // Only a session that actually runs in the container is told it does. An
      // ordinary preset keeps its own working-directory context and its own
      // shell, even when the repository declares a container.
      const preset = containerPresetOf(serviceOf(child, 'agentPresets') as PresetLookup | undefined, agent?.session)
      if (preset === undefined && !config.requireContainer) return result
      const hostWorkdir = hostDirectoryOf(child, result, agent)
      if (hostWorkdir === undefined) return result
      const options = containerOptions(config)
      const repository = repoRegistry(child).locate(hostWorkdir, { ...options, cwd: hostWorkdir })
      if (presetKindOf(preset) === 'sbx') {
        // A sandbox needs no declaration, so the missing-configuration branch
        // below cannot apply: the workspace is the session's own directory.
        const root = sbxWorkspaceRootFor(hostWorkdir, hostWorkdir, repository)
        if (root === undefined) return result
        const spec = sbxSpecFor(root, options, repository)
        applyContainerContext(result, sbxContextText(
          toContainerPath(hostWorkdir, spec),
          spec.sandbox ?? sandboxNameFor(root),
          hostWorkdir,
        ))
        return result
      }
      if (repository === undefined) {
        // A (devContainer) preset over a repository that declares no container:
        // say so in the prompt, because the shell tool will refuse every command.
        if (preset === undefined) return result
        applyContainerContext(result, missingContainerContextText(hostWorkdir, preset))
        return result
      }
      applyContainerContext(result, containerContextText(
        toContainerPath(hostWorkdir, repository),
        repository,
        hostWorkdir,
      ))
      return result
    }, { prepend: true })
  })

  // A container-bound session hands every seam container paths, but a host
  // process can only start in a directory this host has: the working directory a
  // `run_code` PTC worker receives is `/workspaces/<repo>`, which no host can
  // `chdir` into. The spawn directory is translated back onto the repository root
  // and nothing else about the seam changes.
  ctx.inject(['subprocess'], (child: Context) => {
    child.effect(() => installSpawnCwdMapping(
      child.subprocess,
      cwd => repositoryOfPath(child, cwd, containerOptions(config)),
    ), 'devcontainer.spawn-cwd')
  })

  // The PTC seam starts a worker of its own: `resolve` fills a directory the
  // caller left out from the sandbox policy's workspace root — the container's
  // `/workspaces/<repo>` — and `run` hands it to a program that `process.chdir`s
  // into it. Decorating `ctx.subprocess` does not reach that worker, so the
  // directory is translated here as well, at both entry points.
  ctx.inject(['ptcRuntime'], (child: Context) => {
    child.effect(() => installPtcCwdMapping(
      child.ptcRuntime,
      cwd => repositoryOfPath(child, cwd, containerOptions(config)),
    ), 'devcontainer.ptc-cwd')
  })

  ctx.effect(() => {
    const cache = repoRegistry(ctx)
    markContainerPresets(ctx)
    return () => { cache.reset() }
  })
  registerVariants(ctx, config)
}

/** The `ctx.shellEnv` slice this row registers into. */
interface ShellEnvLike {
  register(contributor: {
    name: string
    variables: Record<string, { description: string }>
    resolve(execution: { agent?: { session: unknown } }): Record<string, string>
  }): () => void
}

/**
 * Mark every shell call issued from a derived preset.
 *
 * The marker rides the managed `DSH_*` environment, which the shell tools build
 * per call from the calling agent: `exec.agent` is the one fact the executor
 * cannot otherwise see, so this is what lets `DevcontainerShellExecutor` refuse a
 * command instead of guessing whose it is. Each track has its own pair of
 * variables — `DSH_DEVCONTAINER` / `DSH_DEVCONTAINER_PRESET` and `DSH_SBX` /
 * `DSH_SBX_PRESET` — so the executor, the filesystem, the subprocess, and the PTC
 * seams route a call without re-deriving which preset asked for it. Values are
 * recomputed per call, so switching presets mid-session needs no reload.
 */
function markContainerPresets(ctx: Context): void {
  ctx.inject(['shellEnv'], (child: Context) => {
    const shellEnv = serviceOf(child, 'shellEnv') as ShellEnvLike | undefined
    if (shellEnv === undefined) return
    child.effect(() => shellEnv.register({
      name: 'devcontainer-preset',
      variables: {
        [DEVCONTAINER_ENV_KEY]: {
          description: 'Set for shell calls issued from a (devContainer) preset; the command must reach a container.',
        },
        [DEVCONTAINER_PRESET_ENV_KEY]: {
          description: 'The (devContainer) preset id that issued this shell call.',
        },
        [SBX_ENV_KEY]: {
          description: 'Set for shell calls issued from a (sbx) preset; the command must reach its Docker Sandbox.',
        },
        [SBX_PRESET_ENV_KEY]: {
          description: 'The (sbx) preset id that issued this shell call.',
        },
      },
      resolve: (execution) => {
        const presets = serviceOf(child, 'agentPresets') as PresetLookup | undefined
        const preset = containerPresetOf(presets, execution.agent?.session)
        if (preset === undefined) return {}
        if (presetKindOf(preset) === 'sbx') {
          return { [SBX_ENV_KEY]: SBX_ENV_VALUE, [SBX_PRESET_ENV_KEY]: preset }
        }
        return { [DEVCONTAINER_ENV_KEY]: DEVCONTAINER_ENV_VALUE, [DEVCONTAINER_PRESET_ENV_KEY]: preset }
      },
    }))
  })
}

/**
 * Wire the variant set: derive once the tree is up, then re-derive on every write
 * that lands in this row's config.
 *
 * The sync is built inside `ctx.inject`, not at mount time. Both services can
 * activate AFTER this row (this row is inserted by the Bundle patch; the preset
 * registry is configured by the Profile patch), and a lookup made at mount time —
 * memoized like any other lazy init — would keep reporting "no registry" for the
 * life of the process, which looks exactly like a page whose checkbox never
 * registers anything. Cordis holds this callback until both exist and re-runs it
 * if they ever go away, so the derived set follows the composition.
 */
function registerVariants(ctx: Context, config: Config): void {
  const presets: PresetVariantConfig = { ...VARIANT_DEFAULTS, ...config.presets }
  if (!presets.enabled) return
  if (presets.win32Only && process.platform !== 'win32') return

  // A stored list is read defensively: a row mounted programmatically (no profile
  // config) reaches this point with no `sources` / `sbxSources` reference at all,
  // and "nothing is derived" is the only sane reading of an absent list.
  const storedList = (field: 'sources' | 'sbxSources'): readonly string[] => {
    // Read the LIVE config: the Profile patch can land after this row mounted,
    // and a volatile-only change commits into the fiber's effective config
    // rather than into the object `apply` was handed.
    const live = (ctx as unknown as { fiber?: { effectiveConfig?: Record<string, unknown> } })
      .fiber?.effectiveConfig?.[field]
    const value: unknown = live ?? config[field]
    if (value === undefined || value === null) return []
    const list: unknown = typeof (value as { get?: unknown }).get === 'function'
      ? (value as { get(): unknown }).get()
      : value
    return Array.isArray(list) ? list.filter((id): id is string => typeof id === 'string' && id.length > 0) : []
  }

  const root = (ctx as unknown as { root: Context }).root

  ctx.inject(['loader', 'agentPresets'], (child: Context) => {
    const loader = serviceOf(child, 'loader') as LoaderLike
    const registry = serviceOf(child, 'agentPresets') as PresetRegistryLike
    // Read the declarations per sync: a preset row declared after this row
    // settled is still derivable without reloading the Bundle.
    const declarations = (): ReadonlyMap<string, PresetDeclaration> => {
      const found = new Map<string, PresetDeclaration>()
      for (const entry of loader.entries()) {
        if (entry.options.name !== PRESET_MODULE) continue
        const declaration = asDeclaration(entry.options.config)
        if (declaration !== undefined) found.set(declaration.id, declaration)
      }
      return found
    }
    const sync = new VariantSync({
      registry,
      logger: ctx.logger,
      declarations,
      orderOffset: presets.orderOffset,
      maxDepth: MAX_VARIANT_DEPTH,
    })

    const run = (): void => {
      void (async () => {
        // The tree must be up before its declarations can be read: a source
        // preset row may be inserted by a later patch layer.
        await loader.await()
        const before = sync.ids().join('\n')
        await sync.sync(storedList('sources'), storedList('sbxSources'))
        // A roster change is invisible to an open picker unless it hears about
        // one: those surfaces re-read the roster on `settings/document-updated`
        // for the preset registry's namespace, and a registration made here is
        // not a settings write. Announce the new roster there.
        if (sync.ids().join('\n') !== before) {
          // The event contract brands its namespace; this row owns no such type
          // for a foreign entry id, and the payload is what makes it a refresh.
          (root.emit as (name: string, ...args: unknown[]) => void)(
            SETTINGS_UPDATED, PRESET_REGISTRY_NS, Date.now(),
          )
        }
      })().catch((error: unknown) => {
        ctx.logger.warn(`devcontainer: preset variants unavailable: ${String(error)}`)
      })
    }

    // Reverse order: stop the queue before the scope it registers into goes away.
    child.effect(() => () => { void sync.stop() }, 'devcontainer.preset-variants')
    // A settings write commits the stored list into the live reference and then
    // emits this event, so the derived set follows the page without a remount.
    //
    // The event carries the Loader entry id of the row that owns the namespace,
    // not necessarily the namespace itself, so this listener cannot filter by
    // name: an entry loaded under a custom id would never sync. Syncing an
    // unchanged list is a no-op, so listening to every settings write is both
    // safe and cheap.
    child.on(SETTINGS_UPDATED, run)
    // The same write also commits a volatile field in place; that commit is what
    // carries the value this row reads, and it is emitted on this row's fiber.
    child.on(VOLATILE_UPDATED, run)
    run()
  })
}
