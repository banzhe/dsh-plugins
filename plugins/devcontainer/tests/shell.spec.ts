import { afterAll, describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { SandboxProvider, type ConfinedArgv, type SandboxMode as PolicyMode, type SandboxPolicy } from '@deepseek-ai/dsh-sandbox'
import { SandboxPolicyService } from '@deepseek-ai/dsh-sandbox-policy'
import { SessionProjectionRegistry } from '@deepseek-ai/dsh-session-projection'
import { apply, Config } from '../src/index.ts'
import { DevcontainerShellExecutor } from '../src/shell.ts'
import { repoRegistry } from '../src/registry.ts'
import { BASE_CONTAINER_ENV } from '../src/argv.ts'
import {
  DEVCONTAINER_ENV_KEY, DEVCONTAINER_ENV_VALUE, DEVCONTAINER_PRESET_ENV_KEY,
  SBX_ENV_KEY, SBX_ENV_VALUE, SBX_PRESET_ENV_KEY,
} from '../src/refusal.ts'
import { sandboxNameFor, sandboxWorkspacePath } from '../src/sbx.ts'
import { cleanupTemporaryDirectories, fakeRunner, FakeSubprocess, makeRepo, temporaryDirectory } from './support.ts'

afterAll(cleanupTemporaryDirectories)

const CONFIG = '{ "workspaceFolder": "/workspaces/demo", "remoteUser": "node" }'

/** The managed snapshot the shell tools hand down for a container-bound preset. */
const MARKED = {
  [DEVCONTAINER_ENV_KEY]: DEVCONTAINER_ENV_VALUE,
  [DEVCONTAINER_PRESET_ENV_KEY]: 'standard-devcontainer',
} as const

/** The managed snapshot the shell tools hand down for a sandbox-bound preset. */
const SANDBOX_MARKED = {
  [SBX_ENV_KEY]: SBX_ENV_VALUE,
  [SBX_PRESET_ENV_KEY]: 'standard-sbx',
} as const

/** Classify an invocation by the shell it starts, whichever well-known path it resolved to. */
function localShellOf(argv: readonly string[]): string {
  const program = (argv[0] ?? '').toLowerCase()
  if (program.endsWith('pwsh.exe') || program === 'pwsh') return 'pwsh'
  if (program.endsWith('powershell.exe') || program === 'powershell') return 'pwsh'
  return program
}

/**
 * A provider that hands the caller's argv straight back, so a confined run is
 * observable (the argv reaches the fake subprocess unchanged) and the policy it
 * rode with is recordable.
 */
class PassthroughSandbox extends SandboxProvider {
  readonly calls: { argv: string[], policy: SandboxPolicy }[] = []

  async confine(argv: readonly string[], policy: SandboxPolicy): Promise<ConfinedArgv> {
    this.calls.push({ argv: [...argv], policy })
    return { argv: [...argv], enforcement: 'full', denialSignatures: [], runnerFailureRules: [] }
  }
}

/** Boot a context with the sandbox seams this row injects. */
async function contextWith(mode: PolicyMode = 'danger-full-access'): Promise<{
  ctx: Context
  sandbox: PassthroughSandbox
}> {
  const ctx = new Context()
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(PassthroughSandbox)
  await ctx.plugin(SandboxPolicyService, { mode })
  await ctx.plugin(FakeSubprocess)
  return { ctx, sandbox: ctx.sandbox as PassthroughSandbox }
}

async function setup(root: string, mode: PolicyMode = 'danger-full-access'): Promise<{
  shell: DevcontainerShellExecutor
  subprocess: FakeSubprocess
  sandbox: PassthroughSandbox
}> {
  repoRegistry().reset()
  const { ctx, sandbox } = await contextWith(mode)
  await ctx.plugin(DevcontainerShellExecutor, { cwd: root })
  return { shell: ctx.shell as DevcontainerShellExecutor, subprocess: ctx.subprocess as FakeSubprocess, sandbox }
}

describe('DevcontainerShellExecutor.resolve', () => {
  it('reports the container workdir for a repository path', async () => {
    const root = makeRepo({ '.devcontainer/devcontainer.json': CONFIG })
    const { shell } = await setup(root)
    expect(shell.resolve({ command: 'ls', workdir: join(root, 'src'), dshEnv: MARKED }).workdir).toBe('/workspaces/demo/src')
    expect(shell.resolve({ command: 'ls', dshEnv: MARKED }).workdir).toBe('/workspaces/demo')
  })

  it('keeps a workdir outside any Dev Container repository', async () => {
    const root = makeRepo({ '.devcontainer/devcontainer.json': CONFIG })
    const outside = temporaryDirectory()
    const { shell } = await setup(root)
    expect(shell.resolve({ command: 'ls', workdir: outside, dshEnv: MARKED }).workdir).toBe(outside)
  })

  it('leaves an ordinary session on host paths even inside a Dev Container repository', async () => {
    const root = makeRepo({ '.devcontainer/devcontainer.json': CONFIG })
    const { shell } = await setup(root)
    expect(shell.resolve({ command: 'ls', workdir: join(root, 'src') }).workdir).toBe(join(root, 'src'))
  })

  it('reports the deployment sandbox mode permission presets read', async () => {
    const root = makeRepo({ '.devcontainer/devcontainer.json': CONFIG })
    const { shell } = await setup(root, 'workspace-write')
    expect(shell.sandboxMode).toBe('workspace-write')
  })

  it('stamps the per-call policy onto the spec', async () => {
    const root = makeRepo({ '.devcontainer/devcontainer.json': CONFIG })
    const { shell } = await setup(root, 'workspace-write')
    expect(shell.resolve({ command: 'ls' }).sandboxPolicy).toMatchObject({ mode: 'workspace-write' })
  })
})

describe('DevcontainerShellExecutor.execute', () => {
  it('runs the command through docker exec from the host repository root', async () => {
    const root = makeRepo({ '.devcontainer/devcontainer.json': CONFIG })
    const { shell, subprocess } = await setup(root)
    const ran = fakeRunner({ docker: { stdout: `abc123\t${root}`, stderr: '' } })
    shell.internals.run = ran.run

    const result = await (await shell.execute(shell.resolve({
      command: 'pwd',
      workdir: join(root, 'src'),
      dshEnv: MARKED,
    }))).result()
    expect(result.exitCode).toBe(0)

    const spawn = subprocess.spawns[0]
    expect(spawn?.cwd).toBe(root)
    expect(spawn?.argv).toEqual([
      'docker', 'exec', '-i', '-w', '/workspaces/demo/src',
      '-u', 'node',
      '-e', 'GIT_TERMINAL_PROMPT=0',
      '-e', 'NO_COLOR=1',
      '-e', 'TERM=dumb',
      'abc123',
      '/bin/bash', '-c', 'pwd',
    ])
  })

  it('forwards only the caller environment, never the Windows one', async () => {
    const root = makeRepo({ '.devcontainer/devcontainer.json': CONFIG })
    const { shell, subprocess } = await setup(root)
    shell.internals.run = fakeRunner({ docker: { stdout: `abc123\t${root}`, stderr: '' } }).run
    const spec = shell.resolve({
      command: 'env',
      workdir: root,
      env: { FOO: 'bar' },
      dshEnv: { DSH_WEB_URL: 'http://127.0.0.1:1/', ...MARKED },
    })
    await (await shell.execute(spec)).result()

    const argv = subprocess.spawns[0]?.argv ?? []
    const forwarded = argv.flatMap((value, index) => (argv[index - 1] === '-e' ? [value] : []))
    expect(forwarded).not.toContain(`PATH=${process.env.PATH ?? ''}`)
    expect(forwarded.some(entry => entry.startsWith('SystemRoot='))).toBe(false)
    expect(Object.keys(BASE_CONTAINER_ENV).every(key => forwarded.some(entry => entry.startsWith(`${key}=`)))).toBe(true)
    expect(forwarded).toContain('FOO=bar')
    expect(forwarded).toContain('DSH_WEB_URL=http://127.0.0.1:1/')
    // The scheduling markers are host bookkeeping: they must not reach the container.
    expect(forwarded.some(entry => entry.startsWith(`${DEVCONTAINER_ENV_KEY}=`))).toBe(false)
    expect(forwarded.some(entry => entry.startsWith(`${DEVCONTAINER_PRESET_ENV_KEY}=`))).toBe(false)
  })

  it('probes Docker once per repository', async () => {
    const root = makeRepo({ '.devcontainer/devcontainer.json': CONFIG })
    const { shell } = await setup(root)
    const ran = fakeRunner({ docker: { stdout: `abc123\t${root}`, stderr: '' } })
    shell.internals.run = ran.run
    const spec = shell.resolve({ command: 'true', workdir: root, dshEnv: MARKED })
    await (await shell.execute(spec)).result()
    await (await shell.execute(spec)).result()
    expect(ran.calls).toHaveLength(1)
  })

  it('reuses an explicitly configured container without probing', async () => {
    const root = makeRepo({ '.devcontainer/devcontainer.json': '{ "container": "acme-dev" }' })
    const { shell, subprocess } = await setup(root)
    const ran = fakeRunner()
    shell.internals.run = ran.run
    await (await shell.execute(shell.resolve({ command: 'true', workdir: root, dshEnv: MARKED }))).result()
    expect(ran.calls).toHaveLength(0)
    expect(subprocess.spawns[0]?.argv).toContain('acme-dev')
  })

  it('falls back to the platform local shell outside a Dev Container repository', async () => {
    const root = makeRepo({ '.devcontainer/devcontainer.json': CONFIG })
    const outside = temporaryDirectory()
    const { shell, subprocess } = await setup(root)
    const ran = fakeRunner()
    shell.internals.run = ran.run
    await (await shell.execute(shell.resolve({ command: 'echo hi', workdir: outside }))).result()
    expect(ran.calls).toHaveLength(0)
    expect(subprocess.spawns[0]?.cwd).toBe(outside)
    expect(localShellOf(subprocess.spawns[0]?.argv ?? [])).toBe(process.platform === 'win32' ? 'pwsh' : 'bash')
  })

  it('surfaces a failed start instead of running on the host', async () => {
    const root = makeRepo({ '.devcontainer/devcontainer.json': '{ "container": "acme-dev" }' })
    const { shell, subprocess } = await setup(root)
    shell.internals.run = fakeRunner({ docker: { stdout: '', stderr: 'no such container', exitCode: 1 } }).run
    const execution = await shell.execute(shell.resolve({ command: 'true', workdir: root, dshEnv: MARKED }))
    // `docker exec` still runs — the id came from the configuration — but the
    // container probe itself never fell back to a host shell.
    await execution.result()
    expect(subprocess.spawns[0]?.argv[0]).toBe('docker')
  })
})
describe('DevcontainerShellExecutor local fallback', () => {
  it('runs a non-container workdir through bash on POSIX', async () => {
    const root = makeRepo({ '.devcontainer/devcontainer.json': CONFIG })
    const outside = temporaryDirectory()
    const { ctx } = await contextWith()
    await ctx.plugin(DevcontainerShellExecutor, { cwd: root, localShell: 'bash' })
    const shell = ctx.shell as DevcontainerShellExecutor
    const subprocess = ctx.subprocess as FakeSubprocess
    await (await shell.execute(shell.resolve({ command: 'echo hi', workdir: outside }))).result()
    expect(subprocess.spawns[0]?.argv).toEqual(['bash', '-c', 'echo hi'])
    expect(subprocess.spawns[0]?.cwd).toBe(outside)
  })

  it('runs a non-container workdir through PowerShell when asked, as the Windows local provider did', async () => {
    const root = makeRepo({ '.devcontainer/devcontainer.json': CONFIG })
    const outside = temporaryDirectory()
    const { ctx } = await contextWith()
    await ctx.plugin(DevcontainerShellExecutor, { cwd: root, localShell: 'powershell' })
    const shell = ctx.shell as DevcontainerShellExecutor
    const subprocess = ctx.subprocess as FakeSubprocess
    await (await shell.execute(shell.resolve({ command: 'Get-Date', workdir: outside }))).result()
    const argv = subprocess.spawns[0]?.argv ?? []
    expect(argv.slice(1, 5)).toEqual(['-NoLogo', '-NoProfile', '-NonInteractive', '-Command'])
    expect(argv.at(-1)).toContain('Get-Date')
    expect(argv.at(-1)).toContain('[Console]::OutputEncoding')
    expect(subprocess.spawns[0]?.cwd).toBe(outside)
  })

  it('defaults the local shell to the platform provider', async () => {
    const root = makeRepo({ '.devcontainer/devcontainer.json': CONFIG })
    const outside = temporaryDirectory()
    const { ctx } = await contextWith()
    await ctx.plugin(DevcontainerShellExecutor, { cwd: root })
    const shell = ctx.shell as DevcontainerShellExecutor
    const subprocess = ctx.subprocess as FakeSubprocess
    await (await shell.execute(shell.resolve({ command: 'true', workdir: outside }))).result()
    expect(localShellOf(subprocess.spawns[0]?.argv ?? [])).toBe(process.platform === 'win32' ? 'pwsh' : 'bash')
  })

  it('wraps a host-side PowerShell command through the sandbox provider when the policy confines', async () => {
    const root = makeRepo({ '.devcontainer/devcontainer.json': CONFIG })
    const outside = temporaryDirectory()
    const { ctx, sandbox } = await contextWith('workspace-write')
    await ctx.plugin(DevcontainerShellExecutor, { cwd: root, localShell: 'powershell' })
    const shell = ctx.shell as DevcontainerShellExecutor

    await (await shell.execute(shell.resolve({ command: 'Get-Date', workdir: outside }))).result()

    expect(sandbox.calls).toHaveLength(1)
    expect(sandbox.calls[0]?.policy.mode).toBe('workspace-write')
    expect(localShellOf(sandbox.calls[0]?.argv ?? [])).toBe('pwsh')
  })

  it('does not wrap a host command the policy leaves unconfined', async () => {
    const root = makeRepo({ '.devcontainer/devcontainer.json': CONFIG })
    const outside = temporaryDirectory()
    const { ctx, sandbox } = await contextWith('danger-full-access')
    await ctx.plugin(DevcontainerShellExecutor, { cwd: root, localShell: 'powershell' })
    const shell = ctx.shell as DevcontainerShellExecutor

    await (await shell.execute(shell.resolve({ command: 'Get-Date', workdir: outside }))).result()

    expect(sandbox.calls).toHaveLength(0)
  })

  it('reports a container-bound run as unconfined on the host', async () => {
    const root = makeRepo({ '.devcontainer/devcontainer.json': CONFIG })
    const { shell, sandbox } = await setup(root, 'workspace-write')
    shell.internals.run = fakeRunner({ docker: { stdout: `abc123\t${root}`, stderr: '' } }).run

    const result = await (await shell.execute(shell.resolve({ command: 'pwd', workdir: join(root, 'src'), dshEnv: MARKED }))).result()

    expect(result.sandbox).toEqual({ mode: 'danger-full-access', denied: false })
    // The container is the boundary; the host provider never sees this argv.
    expect(sandbox.calls).toHaveLength(0)
  })

  it('never enters a container for a workdir outside every Dev Container repository', async () => {
    const root = makeRepo({ '.devcontainer/devcontainer.json': '{ "container": "acme-dev" }' })
    const outside = temporaryDirectory()
    const { ctx } = await contextWith()
    await ctx.plugin(DevcontainerShellExecutor, { cwd: root })
    const shell = ctx.shell as DevcontainerShellExecutor
    const ran = fakeRunner()
    shell.internals.run = ran.run
    await (await shell.execute(shell.resolve({ command: 'true', workdir: outside }))).result()
    expect(ran.calls).toHaveLength(0)
    expect((ctx.subprocess as FakeSubprocess).spawns[0]?.argv[0]).not.toBe('docker')
  })
})
describe('DevcontainerShellExecutor under a (devContainer) preset', () => {

  it('refuses to run a command on the host instead of falling back', async () => {
    const root = makeRepo({ '.devcontainer/devcontainer.json': CONFIG })
    const outside = temporaryDirectory()
    const { shell, subprocess } = await setup(root)
    const ran = fakeRunner()
    shell.internals.run = ran.run

    const result = await (await shell.execute(shell.resolve({
      command: 'pwd',
      workdir: outside,
      dshEnv: { ...MARKED, [DEVCONTAINER_PRESET_ENV_KEY]: 'delegate-only-devcontainer' },
    }))).result()

    expect(result.exitCode).toBe(1)
    expect(result.stdout.text).toBe('')
    expect(result.stderr.text).toContain('refused to run this command on the host')
    expect(result.stderr.text).toContain('delegate-only-devcontainer')
    expect(result.stderr.text).toContain(outside)
    // Nothing ran: no container call, no local process.
    expect(ran.calls).toHaveLength(0)
    expect(subprocess.spawns).toHaveLength(0)
  })

  it('still runs in the container when the repository declares one', async () => {
    const root = makeRepo({ '.devcontainer/devcontainer.json': CONFIG })
    const { shell, subprocess } = await setup(root)
    const ran = fakeRunner({ docker: { stdout: `abc123\t${root}`, stderr: '' } })
    shell.internals.run = ran.run

    const result = await (await shell.execute(shell.resolve({
      command: 'pwd',
      workdir: join(root, 'src'),
      dshEnv: MARKED,
    }))).result()

    expect(result.exitCode).toBe(0)
    expect(subprocess.spawns[0]?.argv.slice(0, 4)).toEqual(['docker', 'exec', '-i', '-w'])
  })

  it('refuses for a deployment that requires containers for every preset', async () => {
    const outside = temporaryDirectory()
    const { ctx } = await contextWith()
    await ctx.plugin(DevcontainerShellExecutor, { cwd: outside, requireContainer: true })
    const shell = ctx.shell as DevcontainerShellExecutor
    const subprocess = ctx.subprocess as FakeSubprocess

    const result = await (await shell.execute(shell.resolve({ command: 'pwd', workdir: outside }))).result()

    expect(result.exitCode).toBe(1)
    expect(result.stderr.text).toContain('(devContainer) preset')
    expect(subprocess.spawns).toHaveLength(0)
  })

  it('leaves an ordinary preset alone when the repository declares nothing', async () => {
    const root = makeRepo({ '.devcontainer/devcontainer.json': CONFIG })
    const outside = temporaryDirectory()
    const { shell, subprocess } = await setup(root)

    const result = await (await shell.execute(shell.resolve({ command: 'pwd', workdir: outside }))).result()

    expect(result.exitCode).toBe(0)
    expect(result.stderr.text).toBe('')
    expect(subprocess.spawns).toHaveLength(1)
  })
})
describe('container target recovery', () => {
  it('re-probes after the container disappears, so a restarted container recovers', async () => {
    const root = makeRepo({ '.devcontainer/devcontainer.json': CONFIG })
    const { shell, subprocess } = await setup(root)
    const ran = fakeRunner({ docker: { stdout: `abc123\t${root}`, stderr: '' } })
    shell.internals.run = ran.run
    subprocess.stderr = 'Error: No such container: abc123'
    subprocess.exitCode = 1

    const spec = shell.resolve({ command: 'pwd', workdir: root, dshEnv: MARKED })
    await (await shell.execute(spec)).result()
    expect(ran.calls).toHaveLength(1)

    // The failure says the container is gone, so the cached target is dropped and
    // the next command asks Docker again instead of reusing a dead id.
    await (await shell.execute(spec)).result()
    expect(ran.calls).toHaveLength(2)
  })

  it('keeps a healthy target cached', async () => {
    const root = makeRepo({ '.devcontainer/devcontainer.json': CONFIG })
    const { shell, subprocess } = await setup(root)
    const ran = fakeRunner({ docker: { stdout: `abc123\t${root}`, stderr: '' } })
    shell.internals.run = ran.run
    subprocess.stderr = ''
    subprocess.exitCode = 0
    const spec = shell.resolve({ command: 'pwd', workdir: root, dshEnv: MARKED })
    await (await shell.execute(spec)).result()
    await (await shell.execute(spec)).result()
    expect(ran.calls).toHaveLength(1)
  })
})

describe('DevcontainerShellExecutor under an (sbx) preset', () => {
  it('runs the command in a sandbox without any repository declaration', async () => {
    const root = makeRepo({ 'README.md': '# demo\n' })
    const { shell, subprocess } = await setup(root)
    const name = sandboxNameFor(root)
    shell.internals.run = fakeRunner({
      sbx: { stdout: JSON.stringify([{ name, status: 'running' }]), stderr: '' },
    }).run

    const spec = shell.resolve({ command: 'pwd', workdir: root, dshEnv: SANDBOX_MARKED })
    // A sandbox mounts the workspace at its own absolute path: the same one on a
    // POSIX host, and the drive-letter spelling of it on Windows.
    expect(spec.workdir).toBe(sandboxWorkspacePath(root))
    expect((await (await shell.execute(spec)).result()).exitCode).toBe(0)

    const spawn = subprocess.spawns[0]
    expect(spawn?.cwd).toBe(root)
    expect(spawn?.argv.slice(0, 6)).toEqual(['sbx', 'exec', name, '--', '/bin/sh', '-c'])
    expect(spawn?.argv.at(-1)).toContain("cd -- ")
    expect(spawn?.argv.at(-1)).toContain("'/bin/bash' -c 'pwd'")
  })

  it('creates a missing sandbox with the image the Host row published', async () => {
    const root = makeRepo({ 'README.md': '# demo\n' })
    repoRegistry().reset()
    const { ctx } = await contextWith()
    apply(ctx, Config({ sbxTemplate: 'docker.io/org/img:1.2', presets: { win32Only: false } }))
    await ctx.plugin(DevcontainerShellExecutor, { cwd: root })
    const shell = ctx.shell as DevcontainerShellExecutor
    const ran = fakeRunner({ sbx: { stdout: '[]', stderr: '' } })
    shell.internals.run = ran.run

    const spec = shell.resolve({ command: 'true', workdir: root, dshEnv: SANDBOX_MARKED })
    expect((await (await shell.execute(spec)).result()).exitCode).toBe(0)
    expect(ran.calls.map(call => call.argv)).toContainEqual([
      'sbx', 'create', '--name', sandboxNameFor(root), '--template', 'docker.io/org/img:1.2', 'shell', root,
    ])
  })

  it('reports the mount point a sandbox declaration names', async () => {
    const root = makeRepo({
      '.dsh/docker.json': '{ "cli": "sbx", "workspaceFolder": "/workspace/demo", "sandbox": "acme-box" }',
    })
    const { shell, subprocess } = await setup(root)
    const ran = fakeRunner({
      sbx: { stdout: JSON.stringify([{ name: 'acme-box', status: 'running' }]), stderr: '' },
    })
    shell.internals.run = ran.run

    expect(shell.resolve({ command: 'pwd', workdir: join(root, 'src'), dshEnv: SANDBOX_MARKED }).workdir)
      .toBe('/workspace/demo/src')
    await (await shell.execute(shell.resolve({ command: 'pwd', workdir: join(root, 'src'), dshEnv: SANDBOX_MARKED }))).result()
    expect(subprocess.spawns[0]?.argv.slice(0, 4)).toEqual(['sbx', 'exec', 'acme-box', '--'])
  })

  it('re-probes after the sandbox disappears, so a restarted sandbox recovers', async () => {
    const root = makeRepo({ 'README.md': '# demo\n' })
    const { shell, subprocess } = await setup(root)
    const name = sandboxNameFor(root)
    const ran = fakeRunner({ sbx: { stdout: JSON.stringify([{ name, status: 'running' }]), stderr: '' } })
    shell.internals.run = ran.run
    // `sbx exec` reports a sandbox it cannot enter with exit code 125.
    subprocess.stderr = `no such sandbox: ${name}`
    subprocess.exitCode = 125

    const spec = shell.resolve({ command: 'pwd', workdir: root, dshEnv: SANDBOX_MARKED })
    const listings = (): number => ran.calls.filter(call => call.argv[1] === 'ls').length
    await (await shell.execute(spec)).result()
    expect(listings()).toBe(1)
    await (await shell.execute(spec)).result()
    expect(listings()).toBe(2)
  })

  it('keeps a healthy sandbox target cached', async () => {
    const root = makeRepo({ 'README.md': '# demo\n' })
    const { shell, subprocess } = await setup(root)
    const name = sandboxNameFor(root)
    const ran = fakeRunner({ sbx: { stdout: JSON.stringify([{ name, status: 'running' }]), stderr: '' } })
    shell.internals.run = ran.run
    subprocess.exitCode = 0
    subprocess.stderr = ''

    const spec = shell.resolve({ command: 'pwd', workdir: root, dshEnv: SANDBOX_MARKED })
    await (await shell.execute(spec)).result()
    await (await shell.execute(spec)).result()
    expect(ran.calls.filter(call => call.argv[1] === 'ls')).toHaveLength(1)
  })
})

describe('a (sbx) session whose workdir is a sandbox path', () => {
  // A sandbox is a Linux machine: it spells a Windows drive directory without the
  // drive colon, so `F:\personal\asmr-manager` is `/f/personal/asmr-manager` inside it.
  // Such a workdir has no host ancestry to walk, and a row mounted without a
  // "cwd" has no configured directory to fall back on either.
  const onWindows = it.skipIf(process.platform !== 'win32')

  /** Boot a row configured with no directory at all, as the failing deployment was. */
  async function setupWithoutCwd(): Promise<{
    shell: DevcontainerShellExecutor
    subprocess: FakeSubprocess
  }> {
    repoRegistry().reset()
    const { ctx } = await contextWith()
    await ctx.plugin(DevcontainerShellExecutor, {})
    return { shell: ctx.shell as DevcontainerShellExecutor, subprocess: ctx.subprocess as FakeSubprocess }
  }

  onWindows('finds the host workspace the spelling names and execs into its sandbox', async () => {
    const root = makeRepo({ 'README.md': '# demo\n' })
    const mount = sandboxWorkspacePath(root) ?? root
    const name = sandboxNameFor(root)
    const { shell, subprocess } = await setupWithoutCwd()
    shell.internals.run = fakeRunner({
      sbx: { stdout: JSON.stringify([{ name, status: 'running' }]), stderr: '' },
    }).run

    const spec = shell.resolve({ command: 'pwd', workdir: mount, dshEnv: SANDBOX_MARKED })
    const result = await (await shell.execute(spec)).result()

    expect(result.exitCode).toBe(0)
    const spawn = subprocess.spawns[0]
    // The host process starts in the directory the sandbox spelling names, and the
    // command re-enters the sandbox through the same spelling.
    expect(spawn?.cwd).toBe(root)
    expect(spawn?.argv.slice(0, 6)).toEqual(['sbx', 'exec', name, '--', '/bin/sh', '-c'])
    expect(spawn?.argv.at(-1)).toContain(`cd -- '${mount}'`)
    expect(spawn?.argv.at(-1)).toContain(`'/bin/bash' -c 'pwd'`)
  })

  onWindows('prefers the container repository it finds at the host path', async () => {
    const root = makeRepo({ '.dsh/docker.json': '{ "sandbox": "acme-box" }' })
    const mount = sandboxWorkspacePath(root) ?? root
    const { shell, subprocess } = await setupWithoutCwd()
    shell.internals.run = fakeRunner({
      sbx: { stdout: JSON.stringify([{ name: 'acme-box', status: 'running' }]), stderr: '' },
    }).run

    const result = await (await shell.execute(shell.resolve({
      command: 'pwd',
      workdir: `${mount}/src`,
      dshEnv: SANDBOX_MARKED,
    }))).result()

    expect(result.exitCode).toBe(0)
    expect(subprocess.spawns[0]?.cwd).toBe(root)
    expect(subprocess.spawns[0]?.argv.slice(0, 4)).toEqual(['sbx', 'exec', 'acme-box', '--'])
    expect(subprocess.spawns[0]?.argv.at(-1)).toContain(`cd -- '${mount}/src'`)
  })
})

describe('a repository that declares a container, an ordinary session', () => {
  it('keeps every command on the host', async () => {
    const root = makeRepo({ '.devcontainer/devcontainer.json': '{ "container": "acme-dev" }' })
    const { shell, subprocess } = await setup(root)
    const ran = fakeRunner()
    shell.internals.run = ran.run

    const spec = shell.resolve({ command: 'Get-Date', workdir: root })
    // Host paths, no container workdir.
    expect(spec.workdir).toBe(root)
    await (await shell.execute(spec)).result()

    expect(ran.calls).toHaveLength(0)
    expect(subprocess.spawns[0]?.cwd).toBe(root)
    expect(subprocess.spawns[0]?.argv[0]).not.toBe('docker')
  })
})
