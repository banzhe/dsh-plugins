import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import type { ContainerRun } from '../src/exec.ts'
import {
  hostMountArgument,
  hostMountPlan,
  hostMountRejections,
  hostMountSourceExists,
  splitHostTarget,
  splitMountMode,
  hostMountsConfig,
  parseHostMount,
} from '../src/host-mounts.ts'
import { resolveSbxTarget, sandboxNameFor, sbxSpecFor } from '../src/sbx.ts'
import type { RepoContainerSpec } from '../src/types.ts'
import { DEFAULT_OPTIONS, cleanupTemporaryDirectories, temporaryDirectory } from './support.ts'

afterAll(cleanupTemporaryDirectories)

/** The two user roots the default set is read from, standing in for this host's own. */
const HOMES = { dshHome: 'C:\\Users\\me\\.dsh', agentsHome: 'C:\\Users\\me\\.agents' }

/**
 * A CLI stand-in that answers `sbx ls` and `sbx exec` separately.
 * @param listing - the `sbx ls --json` rows to report.
 * @returns the runner and every argv it was asked for.
 */
function sandboxCli(listing: readonly unknown[]): { calls: string[][], run: ContainerRun } {
  const calls: string[][] = []
  const run: ContainerRun = (argv) => {
    calls.push([...argv])
    if (argv[1] === 'ls') return Promise.resolve({ stdout: JSON.stringify(listing), stderr: '', exitCode: 0 })
    if (argv[1] === 'exec') return Promise.resolve({ stdout: '/usr/bin/node\\n', stderr: '', exitCode: 0 })
    return Promise.resolve({ stdout: '', stderr: '', exitCode: 0 })
  }
  return { calls, run }
}

/**
 * A host directory holding the given relative files.
 * @param files - repository-relative paths to contents.
 * @returns the absolute path of the directory.
 */
function hostTree(files: Record<string, string>): string {
  const root = temporaryDirectory()
  for (const [relative, content] of Object.entries(files)) {
    const absolute = join(root, ...relative.split('/'))
    mkdirSync(join(absolute, '..'), { recursive: true })
    writeFileSync(absolute, content, 'utf8')
  }
  return root
}

/**
 * A sandbox specification for one workspace, carrying the expressions under test.
 * @param expressions - the row's `hostMounts` list.
 * @param root - the host workspace the sandbox would be created around.
 * @returns the specification a `(sbx)` session runs under.
 */
function specWith(expressions: readonly string[], root = 'F:\\personal\\my-repo'): RepoContainerSpec {
  return sbxSpecFor(root, { ...DEFAULT_OPTIONS, hostMounts: expressions })
}

describe('the default extra mount set', () => {
  it('names the AGENTS.md and skill tree of both user roots, in that order', () => {
    expect(hostMountPlan('auto', HOMES)).toEqual([
      { host: 'C:\\Users\\me\\.dsh\\AGENTS.md' },
      { host: 'C:\\Users\\me\\.agents\\AGENTS.md' },
      { host: 'C:\\Users\\me\\.dsh\\skills' },
      { host: 'C:\\Users\\me\\.agents\\skills' },
    ])
  })

  it('mounts nothing when the row says off', () => {
    expect(hostMountPlan('off', HOMES)).toEqual([])
  })

  it('reads an absent value as the default set', () => {
    expect(hostMountPlan(undefined, HOMES)).toEqual(hostMountPlan('auto', HOMES))
  })

  it('takes an explicit list as written', () => {
    expect(hostMountPlan(['D:\\data\\AGENTS.md', 'E:\\team\\skills'], HOMES)).toEqual([
      { host: 'D:\\data\\AGENTS.md' },
      { host: 'E:\\team\\skills' },
    ])
  })
})

describe('one configured mount expression', () => {
  it('keeps a Windows path and its drive colon', () => {
    expect(parseHostMount('D:\\data\\AGENTS.md')).toEqual({ host: 'D:\\data\\AGENTS.md' })
  })

  it('drops the mode token, which the argument adds back as read-only', () => {
    expect(parseHostMount('D:\\data\\AGENTS.md:ro')).toEqual({ host: 'D:\\data\\AGENTS.md' })
    expect(parseHostMount('D:\\data\\skills:rw')).toEqual({ host: 'D:\\data\\skills' })
  })

  it('reads a drive path spelled with forward slashes as a whole path', () => {
    expect(parseHostMount('D:/data/AGENTS.md')).toEqual({ host: 'D:\\data\\AGENTS.md' })
    expect(parseHostMount('D:/data/AGENTS.md:ro')).toEqual({ host: 'D:\\data\\AGENTS.md' })
    expect(parseHostMount('D:/data/x.md:/mnt/x.md:ro')).toEqual({
      host: 'D:\\data\\x.md',
      target: '/mnt/x.md',
    })
  })

  it('rejects an entry that names the sandbox root as its target', () => {
    for (const target of ['/', '//', '/./', '/x/..']) {
      const expression = `C:/a/b.md:${target}`
      expect(parseHostMount(expression)).toBeUndefined()
      const rejections = hostMountRejections([expression])
      expect(rejections).toHaveLength(1)
      expect(rejections[0]).toContain(expression)
      expect(rejections[0]).toContain('root')
      expect(rejections[0]).toContain('target')
      expect(hostMountPlan([expression], HOMES)).toEqual([])
    }
  })

  it('splits a mode token and a host/target pair the way a listing does', () => {
    // One implementation reads the row's entries and the listing, so the two cannot
    // disagree: this is the same call `parseSandboxList` makes for an entry.
    expect(splitMountMode('C:/a/b.md:/mnt/x.md:ro')).toEqual({ text: 'C:/a/b.md:/mnt/x.md', readOnly: true })
    expect(splitHostTarget('C:/a/b.md:/mnt/x.md')).toEqual({ host: 'C:/a/b.md', target: '/mnt/x.md' })
    // A second drive path is not a sandbox target in either reader.
    expect(splitHostTarget('C:/a/b.md:D:/c.md')).toEqual({ host: 'C:/a/b.md', target: 'D:/c.md' })
    expect(parseHostMount('C:/a/b.md:D:/c.md')).toBeUndefined()
  })

  it('rejects an entry whose target is a host path, with its own diagnostic', () => {
    const expression = 'C:/a/b.md:D:/c.md:ro'
    // A second drive path is not a sandbox path: re-reading it as part of the host
    // path would turn the mistake into "the source does not exist".
    expect(parseHostMount(expression)).toBeUndefined()
    const rejections = hostMountRejections([expression])
    expect(rejections).toHaveLength(1)
    expect(rejections[0]).toContain(expression)
    expect(rejections[0]).toContain('D:/c.md')
    expect(rejections[0]).toContain('target')
    expect(rejections[0]).toContain('/mnt/x.md')
    expect(rejections[0]).not.toContain('does not exist')
    expect(hostMountPlan([expression], HOMES)).toEqual([])
  })

  it('reads the sandbox path an entry names', () => {
    expect(parseHostMount('D:\\data\\skills:/opt/skills:ro')).toEqual({
      host: 'D:\\data\\skills',
      target: '/opt/skills',
    })
  })

  it('ignores a blank entry', () => {
    expect(parseHostMount('   ')).toBeUndefined()
    expect(parseHostMount(':ro')).toBeUndefined()
  })

  it('forces every argument read-only', () => {
    expect(hostMountArgument({ host: 'D:\\data\\AGENTS.md' })).toBe('D:\\data\\AGENTS.md:ro')
    expect(hostMountArgument({ host: 'D:\\data\\skills', target: '/opt/skills' }))
      .toBe('D:\\data\\skills:/opt/skills:ro')
  })

  it('reads a value the schema never validated', () => {
    expect(hostMountsConfig('off')).toBe('off')
    expect(hostMountsConfig(['D:\\a'])).toEqual(['D:\\a'])
    expect(hostMountsConfig(42)).toBe('auto')
    expect(hostMountsConfig(undefined)).toBe('auto')
  })
})

describe('whether a mount source exists', () => {
  it('answers for a file and for a directory', async () => {
    const root = hostTree({ 'AGENTS.md': '# agents\\n' })
    await expect(hostMountSourceExists({ host: join(root, 'AGENTS.md') })).resolves.toBe(true)
    await expect(hostMountSourceExists({ host: root })).resolves.toBe(true)
    await expect(hostMountSourceExists({ host: join(root, 'skills') })).resolves.toBe(false)
  })
})

describe('the argv a created sandbox carries', () => {
  const root = 'F:\\personal\\my-repo'
  const name = sandboxNameFor(root)

  it('appends every existing mount as a read-only positional, in declaration order', async () => {
    const host = hostTree({ 'AGENTS.md': '# agents\\n', 'skills/demo/SKILL.md': '# skill\\n' })
    const spec = specWith([join(host, 'AGENTS.md'), `${join(host, 'skills')}:/opt/skills`], root)
    const cli = sandboxCli([])
    await resolveSbxTarget(spec, cli.run)
    expect(cli.calls[1]).toEqual([
      'sbx', 'create', '--name', name, 'shell', root,
      `${join(host, 'AGENTS.md')}:ro`,
      `${join(host, 'skills')}:/opt/skills:ro`,
    ])
  })

  it('skips a source that does not exist and reports it once', async () => {
    const host = hostTree({ 'AGENTS.md': '# agents\\n' })
    const missing = join(host, 'skills')
    const spec = specWith([join(host, 'AGENTS.md'), missing], root)
    const warnings: string[] = []
    const cli = sandboxCli([])
    await resolveSbxTarget(spec, cli.run, undefined, message => warnings.push(message))
    expect(cli.calls[1]).toEqual([
      'sbx', 'create', '--name', name, 'shell', root, `${join(host, 'AGENTS.md')}:ro`,
    ])
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain(missing)
    expect(warnings[0]).toContain('does not exist')
    expect(warnings[0]).toContain(`sbx rm ${name}`)
  })

  it('leaves out an entry whose target is a host path', async () => {
    const host = hostTree({ 'AGENTS.md': '# agents\\n', 'notes.md': '# notes\\n' })
    const expression = `${join(host, 'notes.md')}:D:/notes.md:ro`
    const spec = specWith([join(host, 'AGENTS.md'), expression], root)
    // The diagnostic is the row's, reported once from its own configuration; the
    // argv simply does not carry the entry.
    expect(hostMountRejections([join(host, 'AGENTS.md'), expression])).toHaveLength(1)
    const cli = sandboxCli([])
    await resolveSbxTarget(spec, cli.run)
    expect(cli.calls[1]).toEqual(['sbx', 'create', '--name', name, 'shell', root, `${join(host, 'AGENTS.md')}:ro`])
  })

  it('adds nothing when the row mounts nothing', async () => {
    const cli = sandboxCli([])
    await resolveSbxTarget(sbxSpecFor(root, { ...DEFAULT_OPTIONS, hostMounts: 'off' }), cli.run)
    expect(cli.calls[1]).toEqual(['sbx', 'create', '--name', name, 'shell', root])
  })
})

describe('a declaration an existing sandbox never took', () => {
  const root = 'F:\\personal\\my-repo'
  const name = sandboxNameFor(root)

  it('is reported against the sandbox that has to be recreated', async () => {
    const host = hostTree({ 'AGENTS.md': '# agents\\n' })
    const spec = specWith([join(host, 'AGENTS.md')], root)
    const warnings: string[] = []
    const cli = sandboxCli([{ name, status: 'running', mounts: [`${root}:/f/personal/my-repo`], workspaces: [root] }])
    await resolveSbxTarget(spec, cli.run, undefined, message => warnings.push(message))
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('does not mount')
    expect(warnings[0]).toContain(`sbx rm ${name}`)
  })

  it('is silent when the sandbox reports the mount', async () => {
    const host = hostTree({ 'AGENTS.md': '# agents\\n' })
    const agents = join(host, 'AGENTS.md')
    const spec = specWith([agents], root)
    const warnings: string[] = []
    const cli = sandboxCli([{
      name,
      status: 'running',
      mounts: [`${root}:/f/personal/my-repo`, `${agents}:/d/agents.md:ro`],
      workspaces: [root, `${agents}:ro`],
    }])
    await resolveSbxTarget(spec, cli.run, undefined, message => warnings.push(message))
    expect(warnings).toEqual([])
  })
})

describe('a declaration whose source is gone', () => {
  const root = 'F:\\personal\\my-repo'
  const name = sandboxNameFor(root)

  it('starts when the missing source is one the sandbox never mounted', async () => {
    const host = hostTree({ 'AGENTS.md': '# agents\\n' })
    const absent = join(host, 'skills')
    const spec = specWith([join(host, 'AGENTS.md'), absent], root)
    const warnings: string[] = []
    const cli = sandboxCli([{
      name,
      status: 'stopped',
      mounts: [`${root}:/f/personal/my-repo`, `${join(host, 'AGENTS.md')}:/d/agents.md:ro`],
      workspaces: [root, join(host, 'AGENTS.md')],
    }])
    await expect(resolveSbxTarget(spec, cli.run, undefined, message => warnings.push(message)))
      .resolves.toEqual({ kind: 'sbx', sandboxName: name, workspaceFolder: '/f/personal/my-repo' })
    expect(cli.calls.map(call => call[1])).toEqual(['ls', 'run', 'exec'])
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain(absent)
    expect(warnings[0]).toContain('does not exist')
  })

  it('is refused with what to do, instead of the runtime failure behind it', async () => {
    const host = hostTree({ 'AGENTS.md': '# agents\\n' })
    // The source is gone after the sandbox was created with it, which is what makes
    // `sbx` fail the automatic start behind `exec`; the refusal names the fix.
    const gone = join(host, 'gone.md')
    const spec = specWith([gone], root)
    const cli = sandboxCli([{ name, status: 'stopped', mounts: [`${root}:/f/personal/my-repo`], workspaces: [root, gone] }])
    await expect(resolveSbxTarget(spec, cli.run)).rejects.toThrow('no longer exists')
    await expect(resolveSbxTarget(spec, cli.run)).rejects.toThrow(`sbx rm ${name}`)
    expect(cli.calls.map(call => call[1])).toEqual(['ls', 'ls'])
  })
})
