import { afterAll, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { PresetDefinition } from '@deepseek-ai/dsh-agent-preset-registry'
import { apply, Config, name } from '../src/index.ts'
import type { Config as PluginConfig } from '../src/index.ts'
import type { HostMountsConfig } from '../src/types.ts'
import {
  DEVCONTAINER_ENV_KEY, DEVCONTAINER_ENV_VALUE, DEVCONTAINER_PRESET_ENV_KEY,
  SBX_ENV_KEY, SBX_ENV_VALUE, SBX_PRESET_ENV_KEY,
} from '../src/refusal.ts'
import type { AssembleContext, PromptAssembly } from '@deepseek-ai/dsh-system-prompt'
import { liveHostMounts, liveSandboxTemplate, repoRegistry } from '../src/registry.ts'
import { cleanupTemporaryDirectories, makeRepo } from './support.ts'

const BASH = '@deepseek-ai/dsh-tool-bash'
const PWSH = '@deepseek-ai/dsh-tool-pwsh'
const PRESET_MODULE = '@deepseek-ai/dsh-agent-preset'

/** Two declarations as the Loader would carry them: a router and a subagent. */
const ENTRIES = [
  {
    options: {
      name: PRESET_MODULE,
      config: {
        id: 'delegate-only',
        name: '委派模式',
        plugins: [
          { id: 'tool-subagent-coder', name: '@deepseek-ai/dsh-tool-subagent', config: { toolName: 'coder', agentPreset: 'subagent-coder' } },
        ],
      },
    },
  },
  {
    options: {
      name: PRESET_MODULE,
      config: {
        id: 'subagent-coder',
        name: 'coder',
        plugins: [
          { id: 'tool-bash', name: BASH, disabled: { __jsExpr: "process.platform === 'win32'" } },
          { id: 'tool-pwsh', name: PWSH, disabled: { __jsExpr: "process.platform !== 'win32'" } },
        ],
      },
    },
  },
]

/** The protocol symbol the loader and settings services write a volatile ref through. */
const VOLATILE_WRITE = Symbol.for('cosmokit.volatile.write')

/** A volatile reference a test can move, exactly as the owning runtime moves a real one. */
type WritableRef<T> = { get(): T } & { [VOLATILE_WRITE]: (value: unknown) => void }

function mutableRef<T>(initial: T): WritableRef<T> {
  let current = initial
  return {
    get: () => current,
    [VOLATILE_WRITE]: (value: unknown) => { current = value as T },
  }
}

/** Move a reference the way a settings write does. */
function storeSources<T>(ref: WritableRef<T>, next: T): void {
  ref[VOLATILE_WRITE](next)
}

interface Harness {
  readonly root: Context
  readonly config: PluginConfig
  readonly registered: string[]
  readonly disposed: string[]
  /** Store one source list the way a settings write does. */
  store(sources: readonly string[]): void
  /** Announce the settings write the way the settings service does. */
  announce(ns?: string): void
}

function harness(sources: readonly string[] = []): Harness {
  const registered: string[] = []
  const disposed: string[] = []
  const root = new Context()
  root.provide('loader', {
    await: async () => {},
    entries: () => ENTRIES,
  })
  root.provide('agentPresets', {
    register: async (definition: PresetDefinition) => {
      registered.push(definition.id)
      return async () => {
        registered.splice(registered.indexOf(definition.id), 1)
        disposed.push(definition.id)
      }
    },
  })
  // win32Only off, so the suite measures the derivation rather than the platform.
  const ref = mutableRef<readonly string[]>(sources)
  const config = {
    ...Config({ presets: { win32Only: false } }),
    sources: ref,
  } as unknown as PluginConfig
  apply(root, config)
  return {
    root,
    config,
    registered,
    disposed,
    store: (next: readonly string[]) => { storeSources(ref, next) },
    announce: (ns: string = name) => { root.emit('settings/document-updated', ns as never, 1) },
  }
}

describe('the Host half', () => {
  it('is the Loader row id the settings page edits', () => {
    expect(name).toBe('devcontainer')
  })

  it('derives nothing by default', () => {
    expect(Config({}).sources.get()).toEqual([])
    expect(Config({ sources: ['standard'] }).sources.get()).toEqual(['standard'])
  })

  it('derives nothing when the stored list is empty', async () => {
    const page = harness()
    await Promise.resolve()
    await Promise.resolve()
    expect(page.registered).toEqual([])
  })

  it('registers a checked source and its subagent variant once the Loader settles', async () => {
    const page = harness(['delegate-only'])
    await expect.poll(() => page.registered).toEqual([
      'subagent-coder-devcontainer',
      'delegate-only-devcontainer',
    ])
  })

  it('registers on a settings write, without a restart', async () => {
    const page = harness()
    await Promise.resolve()
    expect(page.registered).toEqual([])
    page.store(['delegate-only'])
    page.announce()
    await expect.poll(() => page.registered).toContain('delegate-only-devcontainer')
  })

  it('disposes the variant as soon as the box is cleared', async () => {
    const page = harness(['delegate-only'])
    await expect.poll(() => page.registered).toHaveLength(2)
    page.store([])
    page.announce()
    await expect.poll(() => page.registered).toEqual([])
    expect(page.disposed).toEqual(['delegate-only-devcontainer', 'subagent-coder-devcontainer'])
  })

  it('ignores a write that leaves the stored list unchanged', async () => {
    const page = harness()
    await Promise.resolve()
    page.announce('some-other-plugin')
    await Promise.resolve()
    await Promise.resolve()
    expect(page.registered).toEqual([])
  })

  it('announces a changed roster on the preset registry namespace', async () => {
    const page = harness()
    const heard: unknown[][] = []
    page.root.on('settings/document-updated' as never, ((...args: unknown[]) => {
      heard.push(args)
    }) as never)
    await Promise.resolve()
    await Promise.resolve()
    // Nothing derived yet, so there is no roster change to announce.
    expect(heard).toEqual([])
    page.store(['delegate-only'])
    page.announce()
    await expect.poll(() => page.registered).toContain('delegate-only-devcontainer')
    await expect.poll(() => heard.map(args => args[0])).toContain('agent-preset-registry')
  })

  it('announces nothing when a sync leaves the derived set as it was', async () => {
    const page = harness(['delegate-only'])
    await expect.poll(() => page.registered).toHaveLength(2)
    const heard: unknown[][] = []
    page.root.on('settings/document-updated' as never, ((...args: unknown[]) => {
      heard.push(args)
    }) as never)
    // The same list again: a no-op sync must not wake every open picker.
    page.announce()
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(heard.map(args => args[0])).not.toContain('agent-preset-registry')
  })

  it('follows its own write even when the row is loaded under a custom id', async () => {
    const page = harness()
    await Promise.resolve()
    page.store(['delegate-only'])
    // The event carries the OWNING LOADER ENTRY id, which need not be the
    // namespace name; a row loaded as `my-devcontainer` must still re-sync.
    page.announce('my-devcontainer')
    await expect.poll(() => page.registered).toEqual(['subagent-coder-devcontainer', 'delegate-only-devcontainer'])
  })

  it('registers nothing when the variants are switched off', async () => {
    const root = new Context()
    const registered: string[] = []
    root.provide('loader', { await: async () => {}, entries: () => ENTRIES })
    root.provide('agentPresets', {
      register: async (definition: PresetDefinition) => {
        registered.push(definition.id)
        return async () => {}
      },
    })
    const config = Config({ sources: ['delegate-only'], presets: { enabled: false, win32Only: false } }) as unknown as PluginConfig
    apply(root, config)
    await Promise.resolve()
    await Promise.resolve()
    expect(registered).toEqual([])
  })
})
/** One contributor as the shell-env registry would hold it. */
interface RegisteredContributor {
  name: string
  variables: Record<string, { description: string }>
  resolve(execution: { agent?: { session: unknown } }): Record<string, string>
}

/** A context whose services answer without a Loader or a live Agent. */
function guarded(presetOf: (session: unknown) => string | null, options: { requireContainer?: boolean } = {}): {
  readonly root: Context
  readonly prompt: (workdir: string) => Promise<string | undefined>
  readonly contributor: () => RegisteredContributor | undefined
} {
  const root = new Context()
  const contributors: RegisteredContributor[] = []
  root.provide('systemPrompt', {})
  root.provide('loader', { await: async () => {}, entries: () => [] })
  root.provide('shellEnv', {
    register: (contributor: RegisteredContributor) => {
      contributors.push(contributor)
      return () => {}
    },
  })
  root.provide('agentPresets', {
    presetForSession: (session: unknown) => presetOf(session),
    register: async (definition: PresetDefinition) => async () => { void definition },
  })
  const config = Config({
    presets: { win32Only: false },
    ...options.requireContainer === true ? { requireContainer: true } : {},
  }) as unknown as PluginConfig
  apply(root, config)

  const assembly = (workdir: string): PromptAssembly => ({
    sections: [],
    // JSON.stringify, because the real service writes the path as a JSON string
    // literal — and a Windows path is the case where that matters.
    contexts: [{ name: 'working-directory:current', text: `Current working directory: ${JSON.stringify(workdir)}.`, interpolate: false }],
    tools: [],
    variables: {},
  })

  return {
    root,
    contributor: () => contributors[0],
    prompt: async (workdir: string) => {
      // `ctx.inject` resolves its callback on a later tick, so wait for it before
      // asking the waterfall: a listener that is not registered yet is a silent no-op.
      await vi.waitFor(() => { expect(root.fiber).toBeDefined() })
      await Promise.resolve()
      const built = assembly(workdir)
      const context = { agent: { session: { header: { id: 'session-1' } } } } as unknown as AssembleContext
      const assembled: PromptAssembly = await root.waterfall(
        'system-prompt/assemble',
        built,
        context,
        async () => built,
      )
      return assembled.contexts.find(entry => entry.name === 'working-directory:current')?.text
    },
  }
}

describe('the (devContainer) guard', () => {
  afterAll(cleanupTemporaryDirectories)

  it('marks a shell call issued from a derived preset', async () => {
    const page = guarded(() => 'delegate-only-devcontainer')
    await expect.poll(() => page.contributor()).toBeDefined()
    const contributor = page.contributor() as RegisteredContributor
    expect(contributor.name).toBe('devcontainer-preset')
    expect(Object.keys(contributor.variables).sort())
      .toEqual([DEVCONTAINER_ENV_KEY, DEVCONTAINER_PRESET_ENV_KEY, SBX_ENV_KEY, SBX_PRESET_ENV_KEY].sort())
    expect(contributor.resolve({ agent: { session: {} } })).toEqual({
      [DEVCONTAINER_ENV_KEY]: DEVCONTAINER_ENV_VALUE,
      [DEVCONTAINER_PRESET_ENV_KEY]: 'delegate-only-devcontainer',
    })
  })

  it('marks a sandbox call with the sandbox pair instead', async () => {
    const page = guarded(() => 'delegate-only-sbx')
    await expect.poll(() => page.contributor()).toBeDefined()
    const contributor = page.contributor() as RegisteredContributor
    expect(contributor.resolve({ agent: { session: {} } })).toEqual({
      [SBX_ENV_KEY]: SBX_ENV_VALUE,
      [SBX_PRESET_ENV_KEY]: 'delegate-only-sbx',
    })
  })

  it('marks nothing for an ordinary preset', async () => {
    const page = guarded(() => 'standard')
    await expect.poll(() => page.contributor()).toBeDefined()
    expect((page.contributor() as RegisteredContributor).resolve({ agent: { session: {} } })).toEqual({})
    expect((page.contributor() as RegisteredContributor).resolve({})).toEqual({})
  })

  it('warns the model when a derived preset meets a repository with no container', async () => {
    repoRegistry().reset()
    const empty = makeRepo({ 'README.md': '# no container here\n' })
    const page = guarded(() => 'delegate-only-devcontainer')
    const text = await page.prompt(empty)
    expect(text).toContain('declares no Dev Container configuration')
    expect(text).toContain('delegate-only-devcontainer')
    expect(text).toContain(empty)
    expect(text).toContain('BLOCKED')
    expect(text).toContain('.devcontainer/devcontainer.json')
    expect(text).toContain('标准模式 / 委派模式')
  })

  it('switches to the container context when the repository declares one', async () => {
    repoRegistry().reset()
    const repo = makeRepo({ '.devcontainer/devcontainer.json': '{ "workspaceFolder": "/workspaces/demo" }' })
    const page = guarded(() => 'standard-devcontainer')
    const text = await page.prompt(repo)
    expect(text).toContain('Linux Docker container')
    expect(text).toContain('Current working directory: "/workspaces/demo"')
    expect(text).not.toContain('BLOCKED')
  })

  it('says nothing new for an ordinary preset over a repository with no container', async () => {
    repoRegistry().reset()
    const empty = makeRepo({ 'README.md': '# no container here\n' })
    const page = guarded(() => 'standard')
    const text = await page.prompt(empty)
    expect(text).toBe(`Current working directory: ${JSON.stringify(empty)}.`)
  })
})
describe('the guard does not touch an ordinary session', () => {
  afterAll(cleanupTemporaryDirectories)

  it('keeps the working-directory context of an ordinary preset over a container repository', async () => {
    repoRegistry().reset()
    const repo = makeRepo({ '.devcontainer/devcontainer.json': '{ "workspaceFolder": "/workspaces/demo" }' })
    const page = guarded(() => 'standard')
    const text = await page.prompt(repo)
    expect(text).toBe(`Current working directory: ${JSON.stringify(repo)}.`)
  })

  it('rewrites the context when the row requires containers outright', async () => {
    repoRegistry().reset()
    const repo = makeRepo({ '.devcontainer/devcontainer.json': '{ "workspaceFolder": "/workspaces/demo" }' })
    const page = guarded(() => 'standard', { requireContainer: true })
    const text = await page.prompt(repo)
    expect(text).toContain('Linux Docker container')
  })
})

describe('the marker registration', () => {
  it('is owned by the row, so unloading the row unregisters the contributor', async () => {
    const root = new Context()
    let disposed = 0
    root.provide('systemPrompt', {})
    root.provide('loader', { await: async () => {}, entries: () => [] })
    root.provide('shellEnv', {
      register: () => () => { disposed += 1 },
    })
    root.provide('agentPresets', {
      presetForSession: () => 'standard',
      register: async (definition: PresetDefinition) => async () => { void definition },
    })
    const config = Config({ presets: { win32Only: false } }) as unknown as PluginConfig
    apply(root, config)
    await expect.poll(() => disposed).toBe(0)
    await root.fiber.dispose()
    await expect.poll(() => disposed).toBe(1)
  })
})
describe('the sandbox image the Host row publishes', () => {
  /**
   * Mount the Host row with a movable image reference, the shape the settings page
   * writes: the page stores a value, and the row's reader answers with it.
   */
  function publishing(initial: string): { root: Context, store(next: string): void } {
    const root = new Context()
    const image = mutableRef(initial)
    const config = {
      ...Config({ presets: { win32Only: false } }),
      sbxTemplate: image,
    } as unknown as PluginConfig
    apply(root, config)
    return { root, store: (next) => { storeSources(image, next) } }
  }

  it('publishes the image a write stored, and follows the next write', () => {
    const page = publishing('')
    expect(liveSandboxTemplate(page.root)).toBeUndefined()
    page.store('docker.io/org/img:1.2')
    expect(liveSandboxTemplate(page.root)).toBe('docker.io/org/img:1.2')
  })

  it('publishes nothing for a blank value', () => {
    const page = publishing('   ')
    expect(liveSandboxTemplate(page.root)).toBeUndefined()
  })
})
describe('the extra host mounts the Host row publishes', () => {
  /**
   * Mount the Host row with a movable mount list, the shape the settings page
   * writes: the page stores a value, and the row's reader answers with the live
   * reference it was given.
   */
  function publishing(initial: HostMountsConfig): { root: Context, store(next: HostMountsConfig): void } {
    const root = new Context()
    const mounts = mutableRef(initial)
    const config = {
      ...Config({ presets: { win32Only: false } }),
      hostMounts: mounts,
    } as unknown as PluginConfig
    apply(root, config)
    return { root, store: (next) => { storeSources(mounts, next) } }
  }

  it('answers with the value a write stored, not with the schema default', () => {
    const page = publishing('auto')
    expect(liveHostMounts(page.root)).toBe('auto')
    // The live reference is unwrapped at use, so a stored `off` is `off` — not the
    // default `auto` the reader would otherwise fall back to.
    page.store('off')
    expect(liveHostMounts(page.root)).toBe('off')
  })

  it('answers with a stored list as it was written', () => {
    const page = publishing('off')
    const stored = ['D:\\x\\AGENTS.md:ro']
    page.store(stored)
    expect(liveHostMounts(page.root)).toEqual(stored)
  })
})
