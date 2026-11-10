import { afterAll, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { AssembleContext, PromptAssembly } from '@deepseek-ai/dsh-system-prompt'

/** Every image the rows under test handed to `sbxSpecFor` on its options, in call order. */
const templates = vi.hoisted(() => [] as (string | undefined)[])

// The rows that create a sandbox are not the row that owns the setting, so the
// only way to observe the value they pass is at the seam they share. Everything
// else stays the real module.
vi.mock('../src/sbx.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/sbx.ts')>()
  return {
    ...actual,
    sbxSpecFor: (...args: Parameters<typeof actual.sbxSpecFor>) => {
      templates.push(args[1].sbxTemplate)
      return actual.sbxSpecFor(...args)
    },
  }
})

import type { ContainerRun } from '../src/exec.ts'
import { DevcontainerFileSystem } from '../src/fs.ts'
import { Config, apply } from '../src/index.ts'
import { repoRegistry } from '../src/registry.ts'
import type { ContainerRpcChannel } from '../src/rpc/client.ts'
import { sandboxNameFor } from '../src/sbx.ts'
import { repositoryOfPath } from '../src/subprocess.ts'
import { DEFAULT_OPTIONS, cleanupTemporaryDirectories, temporaryDirectory } from './support.ts'

afterAll(cleanupTemporaryDirectories)

/** The image the Host row publishes in this suite. */
const IMAGE = 'docker.io/org/img:1.2'

/** The workspace a sandbox mounts in the filesystem case. */
const HOST = 'F:\\personal\\live-template-repo'

/** The path that workspace has inside its sandbox. */
const MOUNT = '/f/personal/live-template-repo'

/**
 * Publish one image the way the settings page does: into the Host row, which
 * registers the reader every other row consults.
 * @param ctx - the composition.
 * @param image - the image to publish, or undefined for none.
 */
function publish(ctx: Context, image?: string): void {
  apply(ctx, image === undefined
    ? Config({ presets: { win32Only: false } })
    : Config({ sbxTemplate: image, presets: { win32Only: false } }))
}

/**
 * A CLI stand-in that reports one running sandbox and answers the node probe.
 * @returns the runner; the callers assert on the seam, not on this listing.
 */
function runningSandbox(root: string, mount: string): ContainerRun {
  const name = sandboxNameFor(root)
  return (argv) => {
    if (argv[1] === 'ls') {
      return Promise.resolve({
        stdout: JSON.stringify([{ name, status: 'running', mounts: [`${root}:${mount}`] }]),
        stderr: '',
        exitCode: 0,
      })
    }
    if (argv[1] === 'exec') return Promise.resolve({ stdout: '/usr/local/bin/node\n', stderr: '', exitCode: 0 })
    return Promise.resolve({ stdout: '', stderr: '', exitCode: 0 })
  }
}

/** The channel stand-in the filesystem row needs to resolve one path. */
function channel(workspace: string): ContainerRpcChannel {
  return {
    handshake: { workspace, workspaceReal: workspace },
    isClosed: false,
    closedPromise: Promise.resolve(),
    request: (method: string, params: unknown) => {
      const path = (params as { path?: string }).path ?? ''
      return Promise.resolve(method === 'fs.resolve'
        ? { targetKey: path, displayPath: path }
        : { version: 'v1', type: 'file', size: 3 })
    },
  } as unknown as ContainerRpcChannel
}

describe('the image the rows hand to sbxSpecFor', () => {
  it('is the Host row\'s live value where the prompt assembly builds a sandbox spec', async () => {
    repoRegistry().reset()
    templates.length = 0
    const ctx = new Context()
    ctx.provide('systemPrompt', {})
    ctx.provide('loader', { await: async () => {}, entries: () => [] })
    ctx.provide('shellEnv', { register: () => () => {} })
    ctx.provide('agentPresets', {
      presetForSession: () => 'delegate-only-sbx',
      register: async () => async () => {},
    })
    publish(ctx, IMAGE)
    await vi.waitFor(() => { expect(ctx.fiber).toBeDefined() })
    await Promise.resolve()

    const workdir = temporaryDirectory()
    const built: PromptAssembly = {
      sections: [],
      contexts: [{ name: 'working-directory:current', text: `Current working directory: ${JSON.stringify(workdir)}.`, interpolate: false }],
      tools: [],
      variables: {},
    }
    const context = { agent: { session: { header: { id: 'session-1' } } } } as unknown as AssembleContext
    await ctx.waterfall('system-prompt/assemble', built, context, async () => built)
    expect(templates).toEqual([IMAGE])
  })

  it('is the Host row\'s live value where the subprocess row resolves a sandbox directory', async () => {
    repoRegistry().reset()
    templates.length = 0
    const ctx = new Context()
    ctx.provide('agents', { currentInitiator: () => ({ session: {} }) })
    ctx.provide('agentPresets', { presetForSession: () => 'delegate-only-sbx' })
    publish(ctx, IMAGE)

    const root = temporaryDirectory()
    const spec = repositoryOfPath(ctx, root, DEFAULT_OPTIONS)
    expect(spec?.sbxTemplate).toBe(IMAGE)
    expect(templates).toEqual([IMAGE])
  })

  it('is the Host row\'s live value where the filesystem row attributes a sandbox path', async () => {
    repoRegistry().reset()
    templates.length = 0
    const ctx = new Context()
    ctx.provide('sandboxPolicy', {
      defaultMode: 'danger-full-access',
      resolve: () => ({ mode: 'danger-full-access', workspaceRoot: HOST }),
    })
    ctx.provide('agents', { currentInitiator: () => ({ session: {} }) })
    ctx.provide('agentPresets', { presetForSession: () => 'delegate-only-sbx' })
    publish(ctx, IMAGE)
    await ctx.plugin(DevcontainerFileSystem, { cwd: HOST })
    const fs = ctx.fs as DevcontainerFileSystem
    fs.containerInternals.run = runningSandbox(HOST, MOUNT)
    fs.containerInternals.channel = async () => channel(MOUNT)

    // Two calls: the mount probe on the way in, and the attribution of the path
    // itself. Both read the Host row, so neither can be the row's own config.
    await fs.resolve(`${MOUNT}/src/a.ts`)
    expect(templates).toEqual([IMAGE, IMAGE])
  })

  it('is no image at all when the Host row publishes none', async () => {
    repoRegistry().reset()
    templates.length = 0
    const ctx = new Context()
    ctx.provide('sandboxPolicy', {
      defaultMode: 'danger-full-access',
      resolve: () => ({ mode: 'danger-full-access', workspaceRoot: HOST }),
    })
    ctx.provide('agents', { currentInitiator: () => ({ session: {} }) })
    ctx.provide('agentPresets', { presetForSession: () => 'delegate-only-sbx' })
    publish(ctx)
    await ctx.plugin(DevcontainerFileSystem, { cwd: HOST })
    const fs = ctx.fs as DevcontainerFileSystem
    fs.containerInternals.run = runningSandbox(HOST, MOUNT)
    fs.containerInternals.channel = async () => channel(MOUNT)

    await fs.resolve(`${MOUNT}/src/a.ts`)
    expect(templates.length).toBeGreaterThan(0)
    expect(templates.every(template => template === undefined)).toBe(true)
  })
})
