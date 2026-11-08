import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import {
  DEVCONTAINER_ENV_KEY,
  DEVCONTAINER_ENV_VALUE,
  DEVCONTAINER_PRESET_ENV_KEY,
  callingContainerPreset,
  containerPresetOf,
  fsEscapeRefusalText,
  fsRefusalText,
  markedContainerOnly,
  markedPreset,
  markedVariantKind,
  presetKindOf,
  SBX_ENV_KEY,
  SBX_ENV_VALUE,
  SBX_PRESET_ENV_KEY,
  refusalText,
  refusedExecution,
  sbxRefusalText,
} from '../src/refusal.ts'
import type { InitiatorLookup, PresetLookup } from '../src/refusal.ts'
import type { DshEnvironment, ShellExecSpec } from '@deepseek-ai/dsh-shell'

const SPEC: ShellExecSpec = {
  command: 'pwd',
  workdir: 'F:/work/repo',
  timeoutMs: 120_000,
  onExpiry: 'kill',
  stdoutMaxBytes: 64_000,
  maxSpillBytes: 1024,
  graceMs: 100,
} as unknown as ShellExecSpec

/** A registry double answering with one fixed preset. */
function lookup(id: string | null): PresetLookup {
  return { presetForSession: () => id }
}

const MARKED = {
  [DEVCONTAINER_ENV_KEY]: DEVCONTAINER_ENV_VALUE,
  [DEVCONTAINER_PRESET_ENV_KEY]: 'delegate-only-devcontainer',
} as unknown as DshEnvironment

describe('containerPresetOf', () => {
  it('names the derived preset a session runs, on either track', () => {
    expect(containerPresetOf(lookup('delegate-only-devcontainer'), {})).toBe('delegate-only-devcontainer')
    expect(containerPresetOf(lookup('subagent-coder-devcontainer'), {})).toBe('subagent-coder-devcontainer')
    expect(containerPresetOf(lookup('delegate-only-sbx'), {})).toBe('delegate-only-sbx')
  })

  it('says which runtime that preset targets', () => {
    expect(presetKindOf('delegate-only-devcontainer')).toBe('devcontainer')
    expect(presetKindOf('delegate-only-sbx')).toBe('sbx')
    expect(presetKindOf('delegate-only')).toBeUndefined()
    expect(presetKindOf(undefined)).toBeUndefined()
  })

  it('ignores an ordinary preset', () => {
    expect(containerPresetOf(lookup('standard'), {})).toBeUndefined()
    expect(containerPresetOf(lookup('delegate-only'), {})).toBeUndefined()
  })

  it('ignores a session with no selection, no registry, or no session', () => {
    expect(containerPresetOf(lookup(null), {})).toBeUndefined()
    expect(containerPresetOf(undefined, {})).toBeUndefined()
    expect(containerPresetOf(lookup('standard-devcontainer'), undefined)).toBeUndefined()
    expect(containerPresetOf(lookup('standard-devcontainer'), null)).toBeUndefined()
  })

  it('survives a registry that cannot answer', () => {
    const broken: PresetLookup = {
      presetForSession: () => { throw new Error('projection not ready') },
    }
    expect(containerPresetOf(broken, {})).toBeUndefined()
  })
})

/** A context carrying the two lookups a filesystem call reads, as the composition supplies them. */
async function callerContext(agents: InitiatorLookup, presets: PresetLookup): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin((child: Context) => {
    child.provide('agents' as string, agents)
    child.provide('agentPresets' as string, presets)
  })
  return ctx
}

describe('callingContainerPreset', () => {
  const session = {}

  it("names the derived preset of the calling agent's session", async () => {
    const ctx = await callerContext(
      { currentInitiator: () => ({ session }) },
      lookup('delegate-only-devcontainer'),
    )
    expect(callingContainerPreset(ctx)).toBe('delegate-only-devcontainer')
  })

  it('is undefined outside any initiator boundary', async () => {
    const ctx = await callerContext({ currentInitiator: () => undefined }, lookup('delegate-only-devcontainer'))
    expect(callingContainerPreset(ctx)).toBeUndefined()
  })

  it('is undefined for an ordinary preset and for a composition with no agent service', async () => {
    const ordinary = await callerContext({ currentInitiator: () => ({ session }) }, lookup('standard'))
    expect(callingContainerPreset(ordinary)).toBeUndefined()
    expect(callingContainerPreset(new Context())).toBeUndefined()
  })

  it('survives a registry that cannot answer', async () => {
    const broken = await callerContext(
      { currentInitiator: () => ({ session }) },
      { presetForSession: () => { throw new Error('projection not ready') } },
    )
    expect(callingContainerPreset(broken)).toBeUndefined()
    const disposed = await callerContext(
      { currentInitiator: () => { throw new Error('agent initiator scope is disposed') } },
      lookup('standard-devcontainer'),
    )
    expect(callingContainerPreset(disposed)).toBeUndefined()
  })
})

describe('the managed marker', () => {
  it('reads the flag and the preset id back out', () => {
    expect(markedContainerOnly(MARKED)).toBe(true)
    expect(markedPreset(MARKED)).toBe('delegate-only-devcontainer')
  })

  it('is absent for an ordinary call', () => {
    expect(markedContainerOnly(undefined)).toBe(false)
    expect(markedContainerOnly({})).toBe(false)
    expect(markedPreset(undefined)).toBeUndefined()
    expect(markedPreset({})).toBeUndefined()
  })

  it('does not read a lookalike value as the marker', () => {
    expect(markedContainerOnly({ [DEVCONTAINER_ENV_KEY]: '0' })).toBe(false)
  })

  it('carries the sandbox pair the same way, and says which runtime it selects', () => {
    const sandbox = {
      [SBX_ENV_KEY]: SBX_ENV_VALUE,
      [SBX_PRESET_ENV_KEY]: 'standard-sbx',
    } as unknown as DshEnvironment
    expect(markedContainerOnly(sandbox)).toBe(true)
    expect(markedPreset(sandbox)).toBe('standard-sbx')
    expect(markedVariantKind(sandbox)).toBe('sbx')
    expect(markedVariantKind(MARKED)).toBe('devcontainer')
    expect(markedVariantKind(undefined)).toBeUndefined()
    expect(markedVariantKind({})).toBeUndefined()
  })
})

describe('refusalText', () => {
  it('names the preset, the directory and every file it looked for', () => {
    const text = refusalText('F:/work/repo', 'delegate-only-devcontainer')
    expect(text).toContain('refused to run this command on the host')
    expect(text).toContain('delegate-only-devcontainer')
    expect(text).toContain('F:/work/repo')
    for (const name of ['.devcontainer/devcontainer.json', '.devcontainer.json', '.dsh/devcontainer.json', '.dsh/docker.json']) {
      expect(text).toContain(name)
    }
    expect(text).toContain('switch to an ordinary preset')
  })

  it('still explains itself when the preset id is unknown', () => {
    expect(refusalText('F:/work/repo', undefined)).toContain('a (devContainer) preset')
  })
})

describe('sbxRefusalText', () => {
  it('attributes the refusal to sbx and names the setting that fixes it', () => {
    const text = sbxRefusalText('relative/dir', 'delegate-only-sbx')
    expect(text).toContain('sbx: refused to run this command on the host')
    expect(text).toContain('delegate-only-sbx')
    expect(text).toContain('relative/dir')
    expect(text).toContain('"cwd"')
    expect(text).toContain('switch to a preset without the (sbx) suffix')
  })

  it('still explains itself when the preset id is unknown', () => {
    expect(sbxRefusalText('relative/dir', undefined)).toContain('a (sbx) preset')
  })
})

describe('fsRefusalText', () => {
  it('names the preset, the path and every file it looked for', () => {
    const text = fsRefusalText('F:/work/repo/src/a.ts', 'delegate-only-devcontainer')
    expect(text).toContain('refused to access this path on the host')
    expect(text).toContain('delegate-only-devcontainer')
    expect(text).toContain('F:/work/repo/src/a.ts')
    for (const name of ['.devcontainer/devcontainer.json', '.devcontainer.json', '.dsh/devcontainer.json', '.dsh/docker.json']) {
      expect(text).toContain(name)
    }
    expect(text).toContain('switch to an ordinary preset')
  })

  it('still explains itself when the preset id is unknown', () => {
    expect(fsRefusalText('F:/work/repo/src/a.ts', undefined)).toContain('a (devContainer) preset')
  })
})

describe('fsEscapeRefusalText', () => {
  it('names both spellings, the preset, and the link that caused it', () => {
    const text = fsEscapeRefusalText(
      'F:/work/repo/linked/secret.txt',
      'F:/secrets/secret.txt',
      'standard-devcontainer',
    )
    expect(text).toContain('refused to access this path')
    expect(text).toContain('standard-devcontainer')
    expect(text).toContain('F:/work/repo/linked/secret.txt')
    expect(text).toContain('F:/secrets/secret.txt')
    expect(text).toContain('outside that repository')
    expect(text).toContain('symbolic link inside the repository must not point out of it')
  })

  it('still explains itself when the preset id is unknown', () => {
    expect(fsEscapeRefusalText('a', 'b', undefined)).toContain('a (devContainer) preset')
  })
})

describe('refusedExecution', () => {
  const text = refusalText(SPEC.workdir, 'standard-devcontainer')

  it('settles as a failure with the diagnostic on stderr', async () => {
    const execution = refusedExecution(SPEC, text)
    const result = await execution.result()
    expect(result.exitCode).toBe(1)
    expect(result.signal).toBeNull()
    expect(result.timedOut).toBe(false)
    expect(result.aborted).toBe(false)
    expect(result.stdout).toEqual({ text: '', truncated: false })
    expect(result.stderr.text).toBe(text)
    expect(result.stderr.truncated).toBe(false)
  })

  it('looks like a finished process to everything that inspects the handle', async () => {
    const execution = refusedExecution(SPEC, text)
    expect(execution.status).toBe('completed')
    expect(execution.exitCode).toBe(1)
    expect(execution.signal).toBeNull()
    expect(execution.kill()).toBe(false)
    await execution.done
    expect(execution.readOutput()).toEqual({ delta: text, lossy: false })
    expect(execution.readOutput()).toEqual({ delta: '', lossy: false })
    expect(execution.observed.stderr.readFrom(0)).toEqual({ text, nextOffset: text.length, lossy: false })
    expect(execution.observed.stderr.readFrom(4)).toEqual({ text: text.slice(4), nextOffset: text.length, lossy: false })
    expect(execution.observed.stdout.readFrom(0).text).toBe('')
  })
})
