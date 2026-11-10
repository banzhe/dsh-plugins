import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { ContainerTarget } from '../src/container.ts'
import type { ContainerRun } from '../src/exec.ts'
import type { RepoContainerSpec } from '../src/types.ts'
import {
  asSbxSpec,
  assertSandboxNode,
  bindSbxMount,
  listSandboxes,
  parseSandboxList,
  resolveSbxTarget,
  SANDBOX_NAME_PREFIX,
  sandboxHostPathFor,
  sandboxMountFor,
  sandboxNameFor,
  sandboxTemplateArgs,
  sandboxWorkspacePath,
  sbxSpecFor,
  sbxTargetOf,
  sbxWorkspaceRootFor,
} from '../src/sbx.ts'
import { liveSandboxTemplate, registerSandboxTemplate } from '../src/registry.ts'
import { DEFAULT_OPTIONS, fakeRunner, repoSpec } from './support.ts'

describe('sandboxNameFor', () => {
  it('names the sandbox after the repository and a digest of its path', () => {
    expect(sandboxNameFor('F:\\personal\\my-repo')).toMatch(new RegExp(`^${SANDBOX_NAME_PREFIX}my-repo-[0-9a-f]{8}$`))
  })

  it('gives two repositories with the same directory name different sandboxes', () => {
    expect(sandboxNameFor('F:\\one\\repo')).not.toBe(sandboxNameFor('F:\\two\\repo'))
  })

  it('folds the spelling a Windows host reports two ways', () => {
    expect(sandboxNameFor('F:\\personal\\my-repo')).toBe(sandboxNameFor('f:/personal/my-repo/'))
  })

  it('keeps the case a case-sensitive host distinguishes', () => {
    expect(sandboxNameFor('/home/dev/Repo')).not.toBe(sandboxNameFor('/home/dev/repo'))
  })

  it('slugifies a directory name that is not an identifier', () => {
    expect(sandboxNameFor('/home/dev/My Repo!')).toMatch(/^dsh-my-repo-[0-9a-f]{8}$/)
    expect(sandboxNameFor('/')).toMatch(/^dsh-workspace-[0-9a-f]{8}$/)
  })
})

describe('parseSandboxList', () => {
  it('reads the current array form', () => {
    expect(parseSandboxList('[{"name":"a","status":"running"},{"name":"b","status":"stopped"}]'))
      .toEqual([{ name: 'a', running: true, mounts: [] }, { name: 'b', running: false, mounts: [] }])
  })

  it('reads the older envelope form', () => {
    expect(parseSandboxList('{"sandboxes":[{"name":"a","detached":true}]}'))
      .toEqual([{ name: 'a', running: true, mounts: [] }])
  })

  it('treats a row that says nothing about its state as not running', () => {
    // Starting an existing sandbox again is harmless; treating a stopped one as
    // running would make every later `sbx exec` fail and never recover.
    expect(parseSandboxList('[{"name":"a"}]')).toEqual([{ name: 'a', running: false, mounts: [] }])
  })

  it('ignores rows without a name, and output it cannot parse', () => {
    expect(parseSandboxList('[{"status":"running"},{"name":""}]')).toEqual([])
    expect(parseSandboxList('NAME STATUS')).toEqual([])
    expect(parseSandboxList('')).toEqual([])
  })
})

describe('listSandboxes', () => {
  it('asks the CLI for its structured listing', async () => {
    const ran = fakeRunner({ sbx: { stdout: '[{"name":"a","status":"running"}]', stderr: '' } })
    await expect(listSandboxes(ran.run, 1000)).resolves.toEqual({
      available: true,
      sandboxes: [{ name: 'a', running: true, mounts: [] }],
    })
    expect(ran.calls[0]?.argv).toEqual(['sbx', 'ls', '--json'])
  })

  it('reports a CLI that is not installed at all', async () => {
    const ran = fakeRunner({ sbx: { stdout: '', stderr: 'not found', exitCode: null } })
    await expect(listSandboxes(ran.run, 1000)).resolves.toEqual({ available: false, sandboxes: [] })
  })

  it('reports a failed listing as available but empty', async () => {
    const ran = fakeRunner({ sbx: { stdout: '', stderr: 'daemon down', exitCode: 1 } })
    await expect(listSandboxes(ran.run, 1000)).resolves.toEqual({ available: true, sandboxes: [] })
  })
})

describe('the sandbox view of a repository', () => {
  const root = 'F:\\personal\\my-repo'

  it('mounts a plain repository at the path its sandbox has for it', () => {
    const declared = repoSpec(root, { containerWorkspaceFolder: '/workspaces/demo' })
    const spec = asSbxSpec(declared)
    expect(spec.cli).toBe('sbx')
    expect(spec.containerWorkspaceFolder).toBe('/f/personal/my-repo')
  })

  it('keeps the mount point a repository declared for the sandbox driver', () => {
    const declared = repoSpec(root, { containerWorkspaceFolder: '/workspace/demo', cli: 'sbx' as const })
    expect(asSbxSpec(declared).containerWorkspaceFolder).toBe('/workspace/demo')
  })

  it('names the target after the declared sandbox', () => {
    expect(sbxTargetOf({ ...repoSpec(root), containerWorkspaceFolder: root, sandbox: 'acme' })).toEqual({
      kind: 'sbx',
      sandboxName: 'acme',
      workspaceFolder: root,
    })
    const named = sbxTargetOf({ ...repoSpec(root), containerWorkspaceFolder: root })
    expect(named.kind === 'sbx' ? named.sandboxName : undefined).toBe(sandboxNameFor(root))
  })

  it('synthesizes a specification for a directory that declares nothing', () => {
    const spec = sbxSpecFor(root, DEFAULT_OPTIONS)
    expect(spec).toMatchObject({
      hostWorkspaceRoot: root,
      containerWorkspaceFolder: '/f/personal/my-repo',
      configPath: '',
      cli: 'sbx',
      shell: DEFAULT_OPTIONS.shell,
      ensureUp: DEFAULT_OPTIONS.ensureUp,
      containerTimeoutMs: DEFAULT_OPTIONS.containerTimeoutMs,
    })
  })

  it('adopts the declaration that owns the directory', () => {
    const declared = repoSpec(root, { remoteUser: 'node', sandbox: 'acme' })
    const spec = sbxSpecFor(root, DEFAULT_OPTIONS, declared)
    expect(spec.remoteUser).toBe('node')
    expect(spec.sandbox).toBe('acme')
    expect(spec.cli).toBe('sbx')
  })
})

describe('sbxWorkspaceRootFor', () => {
  it('takes the declaration first, then the configured cwd, then the directory itself', () => {
    const declared = repoSpec('/home/dev/repo')
    expect(sbxWorkspaceRootFor('/home/dev/repo/src', '/other', declared)).toBe('/home/dev/repo')
    expect(sbxWorkspaceRootFor('/home/dev/repo/src', '/home/dev/repo')).toBe('/home/dev/repo')
    expect(sbxWorkspaceRootFor('F:\\personal\\my-repo\\src', undefined)).toBe('F:\\personal\\my-repo\\src')
  })

  it('refuses to read a POSIX mount point as a host directory on Windows', () => {
    const expected = process.platform === 'win32' ? undefined : '/workspaces/demo'
    expect(sbxWorkspaceRootFor('/workspaces/demo', undefined)).toBe(expected)
    expect(sbxWorkspaceRootFor('relative/dir', undefined)).toBeUndefined()
  })
})

/**
 * A CLI stand-in that answers `sbx ls` and `sbx exec` separately: one answer for
 * both would make the node probe look like a listing.
 */
function sandboxCli(
  listing: string,
  node: { stdout?: string, stderr?: string, exitCode?: number } = {},
): { calls: string[][], run: ContainerRun } {
  const calls: string[][] = []
  const run: ContainerRun = (argv) => {
    calls.push([...argv])
    if (argv[1] === 'exec') {
      return Promise.resolve({ stdout: node.stdout ?? '', stderr: node.stderr ?? '', exitCode: node.exitCode ?? 0 })
    }
    if (argv[1] === 'ls') return Promise.resolve({ stdout: listing, stderr: '', exitCode: 0 })
    return Promise.resolve({ stdout: '', stderr: '', exitCode: 0 })
  }
  return { calls, run }
}

describe('assertSandboxNode', () => {
  const name = 'dsh-demo-00000000'

  it('asks the sandbox where its node is', async () => {
    const cli = sandboxCli('', { stdout: '/usr/local/bin/node\n' })
    await expect(assertSandboxNode(repoSpec('/w'), name, cli.run)).resolves.toBeUndefined()
    expect(cli.calls).toEqual([['sbx', 'exec', name, '--', 'which', 'node']])
  })

  it('names the missing runtime and the fix when the sandbox has no node', async () => {
    const cli = sandboxCli('', { stderr: 'which: no node in (/usr/bin:/bin)\n', exitCode: 1 })
    await expect(assertSandboxNode(repoSpec('/w'), name, cli.run))
      .rejects.toThrow(`sbx: Docker Sandbox "${name}" does not have Node.js installed`)
    await expect(assertSandboxNode(repoSpec('/w'), name, cli.run)).rejects.toThrow('no node in')
  })
})

describe('resolveSbxTarget', () => {
  const root = 'F:\\personal\\my-repo'

  it('probes a running sandbox before handing it out', async () => {
    const spec = sbxSpecFor(root, DEFAULT_OPTIONS)
    const name = sandboxNameFor(root)
    const cli = sandboxCli(JSON.stringify([{ name, status: 'running' }]), { stdout: '/usr/local/bin/node\n' })
    await expect(resolveSbxTarget(spec, cli.run)).resolves.toMatchObject({ kind: 'sbx', sandboxName: name })
    expect(cli.calls.at(-1)).toEqual(['sbx', 'exec', name, '--', 'which', 'node'])
  })

  it('refuses a running sandbox that cannot run the helper', async () => {
    const spec = sbxSpecFor(root, DEFAULT_OPTIONS)
    const name = sandboxNameFor(root)
    const cli = sandboxCli(JSON.stringify([{ name, status: 'running' }]), { stderr: 'which: no node\n', exitCode: 1 })
    await expect(resolveSbxTarget(spec, cli.run))
      .rejects.toThrow(`sbx: Docker Sandbox "${name}" does not have Node.js installed`)
  })

  it('starts a stopped sandbox and probes it afterwards', async () => {
    const spec = sbxSpecFor(root, DEFAULT_OPTIONS)
    const name = sandboxNameFor(root)
    const cli = sandboxCli(JSON.stringify([{ name, status: 'stopped' }]), { stdout: '/usr/bin/node\n' })
    await expect(resolveSbxTarget(spec, cli.run)).resolves.toMatchObject({ sandboxName: name })
    expect(cli.calls.map(call => call.slice(0, 2))).toEqual([
      ['sbx', 'ls'],
      ['sbx', 'run'],
      ['sbx', 'exec'],
    ])
  })

  it('creates a sandbox it cannot find, then probes it', async () => {
    const spec = sbxSpecFor(root, DEFAULT_OPTIONS)
    const name = sandboxNameFor(root)
    const cli = sandboxCli('[]', { stdout: '/usr/bin/node\n' })
    await expect(resolveSbxTarget(spec, cli.run)).resolves.toMatchObject({ sandboxName: name })
    expect(cli.calls.map(call => call.slice(0, 2))).toEqual([
      ['sbx', 'ls'],
      ['sbx', 'create'],
      ['sbx', 'run'],
      ['sbx', 'exec'],
    ])
  })

  it('reports the state instead of probing when ensureUp is off', async () => {
    const spec = { ...sbxSpecFor(root, DEFAULT_OPTIONS), ensureUp: false }
    const name = sandboxNameFor(root)
    const cli = sandboxCli(JSON.stringify([{ name, status: 'stopped' }]), { stdout: '/usr/bin/node\n' })
    await expect(resolveSbxTarget(spec, cli.run)).rejects.toThrow('is not running')
    expect(cli.calls).toHaveLength(1)
  })
})

describe('the image a created sandbox runs', () => {
  const root = 'F:\\personal\\my-repo'
  const name = sandboxNameFor(root)

  /**
   * The specification a row builds for this workspace, carrying the image the
   * composition's Host row published — the path every row takes in production.
   */
  function specification(ctx: Context): RepoContainerSpec {
    return sbxSpecFor(root, { ...DEFAULT_OPTIONS, sbxTemplate: liveSandboxTemplate(ctx) }, undefined)
  }

  it('passes no --template when the composition published none', async () => {
    const cli = sandboxCli('[]', { stdout: '/usr/bin/node\n' })
    await resolveSbxTarget(specification(new Context()), cli.run)
    expect(cli.calls[1]).toEqual(['sbx', 'create', '--name', name, 'shell', root])
  })

  it('passes the published image before the agent and the workspace', async () => {
    const ctx = new Context()
    registerSandboxTemplate(ctx, () => 'docker.io/org/img:1.2')
    const cli = sandboxCli('[]', { stdout: '/usr/bin/node\n' })
    await resolveSbxTarget(specification(ctx), cli.run)
    expect(cli.calls[1]).toEqual([
      'sbx', 'create', '--name', name, '--template', 'docker.io/org/img:1.2', 'shell', root,
    ])
  })

  it('trims the published image and reads a whitespace-only one as unset', async () => {
    const trimmed = new Context()
    registerSandboxTemplate(trimmed, () => '  my-template:v1\t')
    const cli = sandboxCli('[]', { stdout: '/usr/bin/node\n' })
    await resolveSbxTarget(specification(trimmed), cli.run)
    expect(cli.calls[1]).toEqual(['sbx', 'create', '--name', name, '--template', 'my-template:v1', 'shell', root])

    const blank = new Context()
    registerSandboxTemplate(blank, () => '   ')
    const bare = sandboxCli('[]', { stdout: '/usr/bin/node\n' })
    await resolveSbxTarget(specification(blank), bare.run)
    expect(bare.calls[1]).toEqual(['sbx', 'create', '--name', name, 'shell', root])
    expect(specification(blank).sbxTemplate).toBeUndefined()
  })

  it('carries a digest reference and a local template name as they are', () => {
    const digest = 'docker.io/org/img@sha256:6f9e3f0c0d0f4f0e8f7a1b2c3d4e5f60718293a4b5c6d7e8f90102130405060'
    expect(sandboxTemplateArgs({ ...repoSpec(root), sbxTemplate: digest })).toEqual(['--template', digest])
    expect(sandboxTemplateArgs({ ...repoSpec(root), sbxTemplate: 'my-template:v1' })).toEqual(['--template', 'my-template:v1'])
    expect(sandboxTemplateArgs(repoSpec(root))).toEqual([])
    expect(sandboxTemplateArgs({ ...repoSpec(root), sbxTemplate: '' })).toEqual([])
  })

  it('refuses a value it cannot pass as one argv token, without creating anything', async () => {
    for (const value of ['--rm', 'org/img latest', 'org/\timg']) {
      const cli = sandboxCli('[]', { stdout: '/usr/bin/node\n' })
      await expect(resolveSbxTarget({ ...specification(new Context()), sbxTemplate: value }, cli.run))
        .rejects.toThrow(/sbxTemplate .* cannot be passed as one image name/u)
      expect(cli.calls.map(call => call[1])).toEqual(['ls'])
    }
  })


  it('never keeps an image a declaration carried when the Host row configured none', async () => {
    const declared = { ...repoSpec(root), sbxTemplate: 'declared/img:9' }
    const cli = sandboxCli('[]', { stdout: '/usr/bin/node\n' })
    await resolveSbxTarget(
      sbxSpecFor(root, { ...DEFAULT_OPTIONS, sbxTemplate: liveSandboxTemplate(new Context()) }, declared),
      cli.run,
    )
    expect(cli.calls[1]).toEqual(['sbx', 'create', '--name', name, 'shell', root])
    expect('sbxTemplate' in sbxSpecFor(root, DEFAULT_OPTIONS, declared)).toBe(false)
  })

  it('runs the image the Host row configured instead of one a declaration carried', async () => {
    const ctx = new Context()
    registerSandboxTemplate(ctx, () => 'docker.io/org/img:1.2')
    const declared = { ...repoSpec(root), sbxTemplate: 'declared/img:9' }
    const cli = sandboxCli('[]', { stdout: '/usr/bin/node\n' })
    await resolveSbxTarget(
      sbxSpecFor(root, { ...DEFAULT_OPTIONS, sbxTemplate: liveSandboxTemplate(ctx) }, declared),
      cli.run,
    )
    expect(cli.calls[1]).toEqual([
      'sbx', 'create', '--name', name, '--template', 'docker.io/org/img:1.2', 'shell', root,
    ])
    expect(sbxSpecFor(root, { ...DEFAULT_OPTIONS, sbxTemplate: liveSandboxTemplate(ctx) }, declared).sbxTemplate)
      .toBe('docker.io/org/img:1.2')
  })

  it('reads a blank Host value as no image and still drops the declared one', () => {
    const blank = new Context()
    registerSandboxTemplate(blank, () => '   ')
    const declared = { ...repoSpec(root), sbxTemplate: 'declared/img:9' }
    const spec = sbxSpecFor(root, { ...DEFAULT_OPTIONS, sbxTemplate: liveSandboxTemplate(blank) }, declared)
    expect('sbxTemplate' in spec).toBe(false)
  })

  it('keeps an existing sandbox and never recreates it for another image', async () => {
    const ctx = new Context()
    registerSandboxTemplate(ctx, () => 'docker.io/org/img:1.2')
    const running = sandboxCli(JSON.stringify([{ name, status: 'running' }]), { stdout: '/usr/bin/node\n' })
    await resolveSbxTarget(specification(ctx), running.run)
    expect(running.calls.map(call => call[1])).toEqual(['ls', 'exec'])

    const stopped = sandboxCli(JSON.stringify([{ name, status: 'stopped' }]), { stdout: '/usr/bin/node\n' })
    await resolveSbxTarget(specification(ctx), stopped.run)
    expect(stopped.calls.map(call => call[1])).toEqual(['ls', 'run', 'exec'])
  })

  it('names the image in the command it suggests when creating is disabled', async () => {
    const ctx = new Context()
    registerSandboxTemplate(ctx, () => 'docker.io/org/img:1.2')
    const cli = sandboxCli('[]', { stdout: '/usr/bin/node\n' })
    await expect(resolveSbxTarget({ ...specification(ctx), ensureUp: false }, cli.run))
      .rejects.toThrow('sbx create --name ' + name + ' --template docker.io/org/img:1.2 shell ' + root)

    const bare = sandboxCli('[]', { stdout: '/usr/bin/node\n' })
    await expect(resolveSbxTarget({ ...specification(new Context()), ensureUp: false }, bare.run))
      .rejects.toThrow('sbx create --name ' + name + ' shell ' + root)
  })
})

describe('the live sandbox image a composition publishes', () => {
  it('answers with the reader the Host row registered, and forgets it when withdrawn', () => {
    const ctx = new Context()
    expect(liveSandboxTemplate(ctx)).toBeUndefined()
    const withdraw = registerSandboxTemplate(ctx, () => 'my-template:v1')
    expect(liveSandboxTemplate(ctx)).toBe('my-template:v1')
    withdraw()
    expect(liveSandboxTemplate(ctx)).toBeUndefined()
  })

  it('keeps two compositions apart', () => {
    const one = new Context()
    const other = new Context()
    registerSandboxTemplate(one, () => 'docker.io/org/img:1.2')
    expect(liveSandboxTemplate(other)).toBeUndefined()
    expect(liveSandboxTemplate(one)).toBe('docker.io/org/img:1.2')
  })
})

describe('sandboxWorkspacePath', () => {
  it('spells a Windows drive directory the way the sandbox mounts it', () => {
    expect(sandboxWorkspacePath('F:\\personal\\asmr-manager')).toBe('/f/personal/asmr-manager')
    expect(sandboxWorkspacePath('f:/personal/asmr-manager/')).toBe('/f/personal/asmr-manager')
    expect(sandboxWorkspacePath('F:\\')).toBe('/f')
  })

  it('keeps an absolute path a POSIX host mounts it at', () => {
    expect(sandboxWorkspacePath('/home/dev/repo')).toBe('/home/dev/repo')
    expect(sandboxWorkspacePath('/home/dev/repo/')).toBe('/home/dev/repo')
  })

  it('names no path for a UNC share, which carries no drive letter', () => {
    expect(sandboxWorkspacePath('\\\\server\\share\\repo')).toBeUndefined()
  })

  it('gives a declaration whose sandbox mounts nothing the same spelling', () => {
    const declared = repoSpec('F:\\personal\\asmr-manager', { containerWorkspaceFolder: '/workspaces/asmr-manager' })
    expect(asSbxSpec(declared, []).containerWorkspaceFolder).toBe('/f/personal/asmr-manager')
    expect(sbxTargetOf(sbxSpecFor('F:\\personal\\asmr-manager', DEFAULT_OPTIONS), []).workspaceFolder)
      .toBe('/f/personal/asmr-manager')
  })

  it('lets the mount a listing reports win over the convention', () => {
    const declared = repoSpec('F:\\personal\\asmr-manager', { containerWorkspaceFolder: '/workspaces/asmr-manager' })
    const mount = { host: 'F:\\personal\\asmr-manager', sandbox: '/workspace/asmr-manager' }
    expect(asSbxSpec(declared, [mount]).containerWorkspaceFolder).toBe('/workspace/asmr-manager')
  })
})

describe('the mounts a sandbox reports', () => {
  const root = 'F:\\personal\\asmr-manager'
  const name = sandboxNameFor(root)
  const mount = { host: root, sandbox: '/f/personal/asmr-manager' }

  it('splits every entry into its host and sandbox side', () => {
    expect(parseSandboxList(JSON.stringify([
      { name: 'a', status: 'running', mounts: ['F:\\repo:/f/repo', '/home/dev/other:/home/dev/other'] },
    ]))).toEqual([{
      name: 'a',
      running: true,
      mounts: [
        { host: 'F:\\repo', sandbox: '/f/repo' },
        { host: '/home/dev/other', sandbox: '/home/dev/other' },
      ],
    }])
  })

  it('drops entries that do not carry two absolute paths', () => {
    expect(parseSandboxList('[{"name":"a","mounts":["F:\\\\repo","nonsense",42]}]'))
      .toEqual([{ name: 'a', running: false, mounts: [] }])
  })

  it('maps a Windows workspace to the path its sandbox mounts it at', () => {
    expect(sandboxMountFor(root, [mount])).toBe('/f/personal/asmr-manager')
  })

  it('maps a workspace through the mount of one of its parent directories', () => {
    expect(sandboxMountFor('F:\\personal\\repo\\src', [{ host: 'F:\\personal', sandbox: '/f/personal' }]))
      .toBe('/f/personal/repo/src')
  })

  it('finds no mount for a workspace no entry covers', () => {
    expect(sandboxMountFor('F:\\other', [mount])).toBeUndefined()
  })

  it('prefers the reported mount over the folder a declaration named for the sandbox', () => {
    const declared = repoSpec(root, { containerWorkspaceFolder: '/workspace/demo', cli: 'sbx' as const })
    expect(asSbxSpec(declared, [mount]).containerWorkspaceFolder).toBe('/f/personal/asmr-manager')
    expect(asSbxSpec(declared, []).containerWorkspaceFolder).toBe('/workspace/demo')
  })

  it('resolves the target and the specification to the mounted path', async () => {
    const cli = sandboxCli(
      JSON.stringify([{ name, status: 'running', mounts: [`${root}:${mount.sandbox}`] }]),
      { stdout: '/usr/local/bin/node\n' },
    )
    const target = await resolveSbxTarget(sbxSpecFor(root, DEFAULT_OPTIONS), cli.run)
    expect(target).toEqual({ kind: 'sbx', sandboxName: name, workspaceFolder: '/f/personal/asmr-manager' })
    expect(sbxSpecFor(root, DEFAULT_OPTIONS).containerWorkspaceFolder).toBe('/f/personal/asmr-manager')
    expect(sbxTargetOf(sbxSpecFor(root, DEFAULT_OPTIONS)).workspaceFolder).toBe('/f/personal/asmr-manager')
  })

  it('keeps the host spelling for a sandbox that mounts it at that same path', async () => {
    const posixRoot = '/home/dev/mount-repo'
    const posixName = sandboxNameFor(posixRoot)
    const cli = sandboxCli(
      JSON.stringify([{ name: posixName, status: 'running', mounts: [`${posixRoot}:${posixRoot}`] }]),
      { stdout: '/usr/bin/node\n' },
    )
    const target = await resolveSbxTarget(sbxSpecFor(posixRoot, DEFAULT_OPTIONS), cli.run)
    expect(target.workspaceFolder).toBe(posixRoot)
  })

  it('falls back to the path the host convention gives the sandbox when the row declares no mount', async () => {
    const bare = 'F:\\personal\\bare-repo'
    const bareName = sandboxNameFor(bare)
    const cli = sandboxCli(JSON.stringify([{ name: bareName, status: 'running' }]), { stdout: '/usr/bin/node\n' })
    const target = await resolveSbxTarget(sbxSpecFor(bare, DEFAULT_OPTIONS), cli.run)
    expect(target.workspaceFolder).toBe('/f/personal/bare-repo')
  })

  it('binds the specification to the folder a resolved target reported', () => {
    const spec = sbxSpecFor(root, DEFAULT_OPTIONS, undefined, [])
    const target: ContainerTarget = { kind: 'sbx', sandboxName: name, workspaceFolder: '/f/personal/asmr-manager' }
    const bound = bindSbxMount(spec, target)
    expect(bound.containerWorkspaceFolder).toBe('/f/personal/asmr-manager')
    expect(bindSbxMount(bound, target)).toBe(bound)
  })
})

describe('sandboxHostPathFor', () => {
  it('spells a sandbox path back into the drive directory it names', () => {
    // A drive no earlier listing mounts, so the convention is what answers.
    expect(sandboxHostPathFor('/q/personal/unmounted-repo')).toEqual({ host: 'Q:\\personal\\unmounted-repo' })
    expect(sandboxHostPathFor('/q')).toEqual({ host: 'Q:\\' })
    expect(sandboxHostPathFor('/Q/personal/unmounted-repo/')).toEqual({ host: 'Q:\\personal\\unmounted-repo' })
  })

  it('names no host directory for a path no host convention can spell', () => {
    expect(sandboxHostPathFor('/workspaces/demo/src')).toBeUndefined()
    expect(sandboxHostPathFor('/etc/passwd')).toBeUndefined()
    expect(sandboxHostPathFor('relative/dir')).toBeUndefined()
    expect(sandboxHostPathFor('')).toBeUndefined()
  })

  it('reads the host directory and its workspace from the mounts a listing reported', async () => {
    const root = 'F:\\personal\\mounted-elsewhere'
    const name = sandboxNameFor(root)
    const cli = sandboxCli(
      JSON.stringify([{ name, status: 'running', mounts: [`${root}:/workspace/elsewhere`] }]),
      { stdout: '/usr/bin/node\n' },
    )
    await listSandboxes(cli.run, 1000)
    expect(sandboxHostPathFor('/workspace/elsewhere/src/a.ts')).toEqual({
      host: 'F:\\personal\\mounted-elsewhere\\src\\a.ts',
      workspaceRoot: root,
    })
  })

  it('lets the deepest reported mount win over a parent directory one', async () => {
    const name = 'dsh-nested-00000000'
    const cli = sandboxCli(
      JSON.stringify([{ name, status: 'running', mounts: ['F:\\personal:/f/personal', 'F:\\personal\\nested:/elsewhere/nested'] }]),
      { stdout: '/usr/bin/node\n' },
    )
    await listSandboxes(cli.run, 1000)
    expect(sandboxHostPathFor('/elsewhere/nested/src')).toEqual({
      host: 'F:\\personal\\nested\\src',
      workspaceRoot: 'F:\\personal\\nested',
    })
  })
})
