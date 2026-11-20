/** Host-pushed helper provisioning: archive inspection, remote probing, and the installation commands. */
import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { gzipSync } from 'node:zlib'
import { Context } from '@deepseek-ai/cordis'
import { afterAll, describe, expect, it, onTestFinished, vi } from 'vitest'
import { SshConnection } from '../src/index.ts'
import type { Config } from '../src/index.ts'
import { createPlacement, installScript, receiveScript, cleanupScript, probeDigest } from '../src/provision.ts'
import { SshRpcPeer } from '../src/protocol.ts'

const transport = vi.hoisted(() => ({ spawn: vi.fn(), exec: vi.fn(), connect: vi.fn(), tls: vi.fn(), directory: vi.fn(), remove: vi.fn() }))
vi.mock('node:child_process', async original => ({ ...await original<typeof import('node:child_process')>(), spawn: transport.spawn, execFile: transport.exec }))
vi.mock('node:net', async original => ({ ...await original<typeof import('node:net')>(), createConnection: transport.connect }))
vi.mock('node:tls', async original => ({ ...await original<typeof import('node:tls')>(), connect: transport.tls }))
vi.mock('node:fs/promises', async original => ({ ...await original<typeof import('node:fs/promises')>(), mkdtemp: transport.directory, rm: transport.remove }))

const POSIX_BANNER = 'OpenSSH_9.9p1, LibreSSL 3.8.2'
const WINDOWS_BANNER = 'OpenSSH_for_Windows_9.5p1, LibreSSL 3.8.2'
const HELPER = '/opt/dsh-helper/dsh-ssh-helper'
const fixtures = mkdtempSync(join(tmpdir(), 'dsh-provision-spec-'))
afterAll(() => { rmSync(fixtures, { recursive: true, force: true }) })

/** One tar member: header, payload, and the block padding that follows it. */
function tarMember(name: string, content: string, type = '0'): Buffer {
  const payload = Buffer.from(content, 'utf8')
  const header = Buffer.alloc(512)
  header.write(name, 0, 100, 'utf8')
  header.write('0000644', 100)
  header.write('0000000', 108)
  header.write('0000000', 116)
  header.write(payload.length.toString(8).padStart(11, '0'), 124)
  header.write('00000000000', 136)
  header.write('        ', 148)
  header.write(type, 156, 'ascii')
  header.write('ustar', 257, 'ascii')
  header.write('00', 263, 'ascii')
  const checksum = header.reduce((sum, byte) => sum + byte, 0)
  header.write(`${checksum.toString(8).padStart(6, '0')} `, 148, 'ascii')
  return Buffer.concat([header, payload, Buffer.alloc((512 - (payload.length % 512)) % 512)])
}

interface ArchiveOptions {
  /** Entry file contents the archive installs. */
  entry?: string
  /** Manifest written beside the entry; a partial one omits the entry digest. */
  manifest?: unknown
  /** Write the manifest after the entry, so inspection has to skip the entry first. */
  entryFirst?: boolean
}

interface Fixture {
  path: string
  entryHash: string
  archiveHash: string
  bytes: Buffer
}

/** Write one release-shaped archive: a payload directory holding a manifest and the entry. */
function writeArchive(name: string, options: ArchiveOptions = {}): Fixture {
  const entry = options.entry ?? 'helper executable'
  const entryHash = createHash('sha256').update(entry).digest('hex')
  const manifest = options.manifest ?? {
    format: 1, version: '0.2.2', commit: 'a'.repeat(40), dirty: false, target: 'node24-linux-x64', protocol: 3, nodeVersion: 'v24.19.0',
    files: [{ path: 'dsh-ssh-helper', sha256: entryHash, mode: 0o755 }, { path: 'native/system/package.json', sha256: 'b'.repeat(64), mode: 0o644 }],
  }
  const members = [tarMember('dsh-ssh-helper/', '', '5')]
  const manifestMember = tarMember('dsh-ssh-helper/manifest.json', JSON.stringify(manifest))
  const entryMember = tarMember('dsh-ssh-helper/dsh-ssh-helper', entry)
  members.push(...options.entryFirst === true ? [entryMember, manifestMember] : [manifestMember, entryMember])
  members.push(Buffer.alloc(1024))
  const bytes = gzipSync(Buffer.concat(members))
  const path = join(fixtures, name)
  writeFileSync(path, bytes)
  return { path, entryHash, archiveHash: createHash('sha256').update(bytes).digest('hex'), bytes }
}

/** One scripted answer from the remote host. */
interface Reply {
  exitCode?: number
  stdout?: string
  stderr?: string
}

/** One spawned SSH client: the helper connection, or a provisioning script. */
class Child extends EventEmitter {
  readonly stdin = new PassThrough()
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()
  /** Bytes the client wrote to the remote standard input. */
  readonly received: Buffer[] = []
  readonly signals: string[] = []
  exitCode: number | null = null
  signalCode: NodeJS.Signals | null = null
  kill(signal: NodeJS.Signals = 'SIGTERM'): boolean {
    this.signals.push(signal)
    queueMicrotask(() => { this.emit('close', null, signal) })
    return true
  }
}

interface ProvisioningCall {
  args: string[]
  child: Child
}

interface SetupOptions {
  platform?: NodeJS.Platform
  banner?: string
  /** Answers for the provisioning scripts, in the order the connection runs them. */
  replies: Reply[]
  config?: Partial<Config>
  hello?: Record<string, unknown>
}

function setup(options: SetupOptions) {
  const platform = vi.spyOn(process, 'platform', 'get').mockReturnValue(options.platform ?? 'win32')
  const ctx = new Context()
  const master = new Child()
  const pendingReplies = [...options.replies]
  const provisioning: ProvisioningCall[] = []
  const calls: { method: string; params: unknown }[] = []
  const helper = new SshRpcPeer(master.stdin, master.stdout, 4096, 8, async (method, params) => {
    calls.push({ method, params })
    if (method === 'hello') return options.hello
    if (method === 'heartbeat' || method === 'close') return null
    throw new Error(`unexpected helper request ${method}`)
  })
  transport.directory.mockResolvedValue('/virtual/ssh-startup')
  transport.remove.mockResolvedValue(undefined)
  transport.spawn.mockImplementation((_file: string, args: string[]) => {
    const script = args.at(-1) ?? ''
    if (pendingReplies.length > 0 && /sha256sum|cat > |ln -s |rm -rf /u.test(script)) {
      const reply = pendingReplies.shift() as Reply
      const child = new Child()
      child.stdin.on('data', (chunk: Buffer) => { child.received.push(chunk) })
      child.exitCode = reply.exitCode ?? 0
      provisioning.push({ args, child })
      queueMicrotask(() => {
        if (reply.stdout !== undefined) child.stdout.write(reply.stdout)
        if (reply.stderr !== undefined) child.stderr.write(reply.stderr)
        child.emit('close', child.exitCode, null)
      })
      return child
    }
    return master
  })
  transport.exec.mockImplementation((
    _file: string, _args: string[], _options: unknown,
    callback: (error: Error | null, stdout: string, stderr: string) => void,
  ) => {
    const command = new Child()
    queueMicrotask(() => {
      callback(null, '', options.banner ?? WINDOWS_BANNER)
      command.kill()
    })
    return command
  })
  const config: Config = {
    host: 'test-alias', launch: { kind: 'executable' }, helper: HELPER, workspace: '/remote/workspace',
    requestTimeoutMs: 1000, maxFrameBytes: 4096, maxPending: 8, leaseMs: 30_000,
    ...options.config,
  }
  const service = new SshConnection(ctx, config)
  onTestFinished(async () => {
    try { await service.dispose() } finally {
      helper.close()
      master.kill()
      await ctx.fiber.dispose()
      platform.mockRestore()
      vi.restoreAllMocks()
      for (const mock of Object.values(transport)) mock.mockReset()
    }
  })
  return { service, master, calls, provisioning }
}

/** The script one provisioning call ran. */
function scriptOf(call: ProvisioningCall): string {
  return call.args.at(-1) ?? ''
}

describe('Host-pushed helper provisioning', () => {
  it('skips the transfer when the installed entry already matches', async () => {
    const archive = writeArchive('matching.tgz')
    const test = setup({
      replies: [{ stdout: `${archive.entryHash}  ${HELPER}\n` }],
      config: { provision: { source: archive.path } },
      hello: { protocol: 3, hash: archive.entryHash, platform: 'linux', nodeVersion: 'v24.19.0', kind: 'executable', executable: '/canonical/dsh-ssh-helper', root: '/tmp/remote-helper', workspace: '/canonical/workspace' },
    })
    await test.service.ready
    expect(test.provisioning).toHaveLength(1)
    expect(scriptOf(test.provisioning[0] as ProvisioningCall)).toContain(`sha256sum '${HELPER}'`)
    expect(test.calls[0]?.method).toBe('hello')
  })

  it('installs the archive when the remote entry is absent', async () => {
    const archive = writeArchive('absent.tgz')
    const test = setup({
      replies: [{ exitCode: 96, stderr: 'dsh-provision: the configured helper entry is absent\n' }, {}, {}],
      config: { provision: { source: archive.path } },
      hello: { protocol: 3, hash: archive.entryHash, platform: 'linux', nodeVersion: 'v24.19.0', kind: 'executable', executable: '/canonical/dsh-ssh-helper', root: '/tmp/remote-helper', workspace: '/canonical/workspace' },
    })
    await test.service.ready
    expect(test.provisioning).toHaveLength(3)
    const [probe, receive, install] = test.provisioning as [ProvisioningCall, ProvisioningCall, ProvisioningCall]
    expect(scriptOf(probe)).toContain("command -v sha256sum")
    const transfer = scriptOf(receive)
    expect(transfer).toContain(`mkdir -p '/opt/dsh-helper'`)
    const transferred = /cat > '([^']+\.tgz)'/u.exec(transfer)?.[1] as string
    expect(transferred).toMatch(/^\/opt\/dsh-helper\/\.dsh-provision-[0-9a-f]+\.tgz$/u)
    expect(Buffer.concat(receive.child.received)).toEqual(archive.bytes)
    const installation = scriptOf(install)
    expect(installation).toContain(`sha256sum '${transferred}'`)
    expect(installation).toContain(archive.archiveHash)
    expect(installation).toContain(`tar -xzf '${transferred}'`)
    expect(installation).toContain(`chmod 0755 '/opt/dsh-helper/.dsh-provision/${archive.entryHash}/dsh-ssh-helper/dsh-ssh-helper'`)
    expect(installation).toContain(`ln -s '/opt/dsh-helper/.dsh-provision/${archive.entryHash}/dsh-ssh-helper/dsh-ssh-helper'`)
    expect(installation).toContain(`mv -f '/opt/dsh-helper/dsh-ssh-helper.new.`)
    expect(installation).toContain(`'${HELPER}'`)
    expect(installation).toContain(`rm -f '${transferred}'`)
    expect(test.calls[0]?.method).toBe('hello')
    // The Windows host starts the helper per stream, without a shared master.
    const helperCall = transport.spawn.mock.calls.at(-1) as [string, string[]]
    expect(helperCall[1]).not.toContain('-M')
  })

  it('reinstalls when the installed entry differs from the archive', async () => {
    const archive = writeArchive('differs.tgz')
    const test = setup({
      replies: [{ stdout: `${'c'.repeat(64)}  ${HELPER}\n` }, {}, {}],
      config: { provision: { source: archive.path } },
      hello: { protocol: 3, hash: archive.entryHash, platform: 'linux', nodeVersion: 'v24.19.0', kind: 'executable', executable: '/canonical/dsh-ssh-helper', root: '/tmp/remote-helper', workspace: '/canonical/workspace' },
    })
    await test.service.ready
    expect(test.provisioning).toHaveLength(3)
    const install = scriptOf(test.provisioning[2] as ProvisioningCall)
    expect(install).toContain(`/opt/dsh-helper/.dsh-provision/${archive.entryHash}/dsh-ssh-helper/dsh-ssh-helper`)
    expect(install).not.toContain('c'.repeat(64))
  })

  it('reports a transferred archive that differs and removes the attempt', async () => {
    const archive = writeArchive('corrupted.tgz')
    const test = setup({
      replies: [
        { exitCode: 96 },
        {},
        { exitCode: 98, stderr: 'dsh-provision: the transferred archive differs from the host archive\n' },
        {},
      ],
      config: { provision: { source: archive.path } },
    })
    await expect(test.service.ready).rejects.toThrow(/SSH helper provisioning could not install .*transferred archive differs from the host archive/u)
    expect(test.provisioning).toHaveLength(4)
    const cleanup = scriptOf(test.provisioning[3] as ProvisioningCall)
    const attempted = /\.dsh-provision-[0-9a-f]+\.tgz/u.exec(scriptOf(test.provisioning[1] as ProvisioningCall))?.[0] as string
    expect(cleanup).toContain(attempted)
    expect(cleanup).toContain('rm -rf ')
    const helperCall = transport.spawn.mock.calls.length
    expect(helperCall).toBe(4)
  })

  it('fails loudly when the archive is not a release archive', async () => {
    const path = join(fixtures, 'garbage.tgz')
    writeFileSync(path, gzipSync(Buffer.alloc(1024, 0x78)))
    const test = setup({ replies: [], config: { provision: { source: path } } })
    await expect(test.service.ready).rejects.toThrow(/SSH helper provisioning cannot read .*garbage\.tgz: the archive is not a ustar tar\.gz/u)
    expect(transport.spawn).not.toHaveBeenCalled()
  })

  it('fails loudly when the manifest declares no entry digest', async () => {
    const archive = writeArchive('no-entry.tgz', { manifest: { format: 1, files: [{ path: 'native/system/package.json', sha256: 'b'.repeat(64), mode: 0o644 }] } })
    const test = setup({ replies: [], config: { provision: { source: archive.path } } })
    await expect(test.service.ready).rejects.toThrow(/manifest\.json declares no dsh-ssh-helper entry/u)
    expect(transport.spawn).not.toHaveBeenCalled()
  })

  it('rejects a declared helperHash the archive does not install', async () => {
    const archive = writeArchive('conflict.tgz')
    const test = setup({ replies: [], config: { helperHash: 'c'.repeat(64), provision: { source: archive.path } } })
    await expect(test.service.ready).rejects.toThrow(new RegExp(`helperHash ${'c'.repeat(64)} differs from the entry digest ${archive.entryHash}`, 'u'))
    expect(transport.spawn).not.toHaveBeenCalled()
  })

  it('requires a digest from the configuration or the archive', () => {
    const ctx = new Context()
    onTestFinished(async () => { await ctx.fiber.dispose() })
    expect(() => new SshConnection(ctx, {
      host: 'test-alias', launch: { kind: 'executable' }, helper: HELPER, workspace: '/remote/workspace',
      requestTimeoutMs: 1000, maxFrameBytes: 4096, maxPending: 8, leaseMs: 30_000,
    })).toThrow(/helperHash is required unless provision\.source supplies the helper archive/u)
  })

  it('rejects provisioning for a script launch kind', () => {
    const ctx = new Context()
    const archive = writeArchive('script-kind.tgz')
    onTestFinished(async () => { await ctx.fiber.dispose() })
    expect(() => new SshConnection(ctx, {
      host: 'test-alias', launch: { kind: 'node-script', node: '/remote/node' }, helper: HELPER,
      workspace: '/remote/workspace', provision: { source: archive.path },
      requestTimeoutMs: 1000, maxFrameBytes: 4096, maxPending: 8, leaseMs: 30_000,
    })).toThrow(/provision requires launch\.kind 'executable'; a release archive is a self-contained executable/u)
  })

  it('fails loudly when the host cannot verify digests', async () => {
    const archive = writeArchive('no-sha256sum.tgz')
    const test = setup({
      replies: [{ exitCode: 97, stderr: 'dsh-provision: sha256sum is unavailable on the remote host\n' }],
      config: { provision: { source: archive.path } },
    })
    await expect(test.service.ready).rejects.toThrow(/requires sha256sum on the remote host \(exit code 97: dsh-provision: sha256sum is unavailable/u)
  })

  it('reports an unreadable installed entry instead of reinstalling it', async () => {
    const archive = writeArchive('unreadable.tgz')
    const test = setup({
      replies: [{ exitCode: 1, stderr: 'sha256sum: Permission denied\n' }],
      config: { provision: { source: archive.path } },
    })
    await expect(test.service.ready).rejects.toThrow(/cannot read the installed helper \/opt\/dsh-helper\/dsh-ssh-helper \(exit code 1: sha256sum: Permission denied/u)
  })

  it('installs through the multiplexed master on a POSIX host', async () => {
    const archive = writeArchive('multiplexed.tgz')
    const test = setup({
      platform: 'linux',
      banner: POSIX_BANNER,
      replies: [{ exitCode: 96 }, {}, {}],
      config: { provision: { source: archive.path } },
      hello: { protocol: 3, hash: archive.entryHash, platform: 'linux', nodeVersion: 'v24.19.0', kind: 'executable', executable: '/canonical/dsh-ssh-helper', root: '/tmp/remote-helper', workspace: '/canonical/workspace' },
    })
    await test.service.ready
    expect(test.provisioning).toHaveLength(3)
    const helperCall = transport.spawn.mock.calls.at(-1) as [string, string[]]
    expect(helperCall[1]).toContain('-M')
    expect(helperCall[1]).toContain(join('/virtual/ssh-startup', 'master'))
    expect(test.calls[0]?.method).toBe('hello')
  })

  it('reads the manifest when the archive lists it after the entry', async () => {
    const archive = writeArchive('entry-first.tgz', { entryFirst: true })
    const test = setup({
      replies: [{ stdout: `${archive.entryHash}  ${HELPER}\n` }],
      config: { provision: { source: archive.path } },
      hello: { protocol: 3, hash: archive.entryHash, platform: 'linux', nodeVersion: 'v24.19.0', kind: 'executable', executable: '/canonical/dsh-ssh-helper', root: '/tmp/remote-helper', workspace: '/canonical/workspace' },
    })
    await test.service.ready
    expect(test.provisioning).toHaveLength(1)
  })
})

describe('Provisioning through the loader', () => {
  /** The full configuration a profile supplies, with every default written out. */
  const loaded = {
    host: 'test-alias', launch: { kind: 'executable' as const }, helper: HELPER, workspace: '/remote/workspace',
    requestTimeoutMs: 1000, maxFrameBytes: 4096, maxPending: 8, leaseMs: 30_000,
  }

  it('rejects an empty provision object at load', async () => {
    const ctx = new Context()
    // The loader admits a source-less provision only to reject it, which the types cannot express.
    const fiber = ctx.plugin(SshConnection, { ...loaded, provision: {} as { source: string } })
    onTestFinished(async () => { await fiber.dispose() })
    await expect(fiber).rejects.toThrow(/\$\.provision\.source missing required value/u)
  })

  it('carries provision.source into the connection', async () => {
    const ctx = new Context()
    const fiber = ctx.plugin(SshConnection, { ...loaded, provision: { source: join(fixtures, 'absent-archive.tgz') } })
    onTestFinished(async () => { await fiber.dispose() })
    await expect(fiber).rejects.toThrow(/SSH helper provisioning cannot read/u)
    await expect(fiber).rejects.toThrow(/absent-archive\.tgz/u)
    expect(transport.spawn).not.toHaveBeenCalled()
  })
})

describe('Provisioning commands', () => {
  it('quotes every remote path and checks the archive before extracting it', () => {
    const placement = {
      helper: "/opt/dsh helper/it's-here", directory: "/opt/dsh helper/.dsh-provision",
      content: "/opt/dsh helper/.dsh-provision/abc", payload: "/opt/dsh helper/.dsh-provision/abc/dsh-ssh-helper",
      entry: "/opt/dsh helper/.dsh-provision/abc/dsh-ssh-helper/dsh-ssh-helper",
      archive: "/opt/dsh helper/.dsh-provision-1234.tgz", staging: "/opt/dsh helper/.dsh-provision/.partial-1234",
      link: "/opt/dsh helper/it's-here.new.1234",
    }
    expect(receiveScript(placement)).toBe(`mkdir -p '/opt/dsh helper' || exit 95\ncat > '/opt/dsh helper/.dsh-provision-1234.tgz'`)
    expect(installScript(placement, 'a'.repeat(64))).toBe([
      'set -u',
      `[ "$(sha256sum '/opt/dsh helper/.dsh-provision-1234.tgz' | cut -c1-64)" = ${'a'.repeat(64)} ] || { echo 'dsh-provision: the transferred archive differs from the host archive' >&2; exit 98; }`,
      `if [ ! -f '/opt/dsh helper/.dsh-provision/abc/dsh-ssh-helper/dsh-ssh-helper' ]; then`,
      `  mkdir -p '/opt/dsh helper/.dsh-provision/abc' || exit 99`,
      `  if [ -e '/opt/dsh helper/.dsh-provision/abc/dsh-ssh-helper' ]; then echo 'dsh-provision: the payload directory holds a different entry' >&2; exit 99; fi`,
      `  mkdir -p '/opt/dsh helper/.dsh-provision/.partial-1234' || exit 99`,
      `  tar -xzf '/opt/dsh helper/.dsh-provision-1234.tgz' -C '/opt/dsh helper/.dsh-provision/.partial-1234' || { rm -rf '/opt/dsh helper/.dsh-provision/.partial-1234'; echo 'dsh-provision: the transferred archive did not extract' >&2; exit 99; }`,
      `  [ -f '/opt/dsh helper/.dsh-provision/.partial-1234/dsh-ssh-helper/dsh-ssh-helper' ] || { rm -rf '/opt/dsh helper/.dsh-provision/.partial-1234'; echo 'dsh-provision: the archive omits the dsh-ssh-helper entry' >&2; exit 99; }`,
      `  chmod 0755 '/opt/dsh helper/.dsh-provision/.partial-1234/dsh-ssh-helper/dsh-ssh-helper' || { rm -rf '/opt/dsh helper/.dsh-provision/.partial-1234'; echo 'dsh-provision: the extracted entry is not executable' >&2; exit 99; }`,
      `  mv '/opt/dsh helper/.dsh-provision/.partial-1234/dsh-ssh-helper' '/opt/dsh helper/.dsh-provision/abc'/ || { rm -rf '/opt/dsh helper/.dsh-provision/.partial-1234'; echo 'dsh-provision: the extracted payload could not be placed' >&2; exit 99; }`,
      `  rm -rf '/opt/dsh helper/.dsh-provision/.partial-1234'`,
      'fi',
      `chmod 0755 '/opt/dsh helper/.dsh-provision/abc/dsh-ssh-helper/dsh-ssh-helper' || exit 100`,
      `ln -s '/opt/dsh helper/.dsh-provision/abc/dsh-ssh-helper/dsh-ssh-helper' '/opt/dsh helper/it'\\''s-here.new.1234' || exit 100`,
      `mv -f '/opt/dsh helper/it'\\''s-here.new.1234' '/opt/dsh helper/it'\\''s-here' || exit 100`,
      `rm -f '/opt/dsh helper/.dsh-provision-1234.tgz'`,
    ].join('\n'))
    expect(cleanupScript(placement)).toBe(`rm -rf '/opt/dsh helper/.dsh-provision/.partial-1234'\nrm -f '/opt/dsh helper/.dsh-provision-1234.tgz' '/opt/dsh helper/it'\\''s-here.new.1234'`)
  })

  it('names each payload directory by its digest and keeps the archive beside the entry', () => {
    const placement = createPlacement(HELPER, 'd'.repeat(64))
    expect(placement.directory).toBe('/opt/dsh-helper/.dsh-provision')
    expect(placement.content).toBe(`/opt/dsh-helper/.dsh-provision/${'d'.repeat(64)}`)
    expect(placement.payload).toBe(`/opt/dsh-helper/.dsh-provision/${'d'.repeat(64)}/dsh-ssh-helper`)
    expect(placement.entry).toBe(`/opt/dsh-helper/.dsh-provision/${'d'.repeat(64)}/dsh-ssh-helper/dsh-ssh-helper`)
    expect(placement.archive).toMatch(/^\/opt\/dsh-helper\/\.dsh-provision-[0-9a-f]{8}\.tgz$/u)
    expect(placement.staging).toMatch(/^\/opt\/dsh-helper\/\.dsh-provision\/\.partial-[0-9a-f]{8}$/u)
    expect(placement.link).toMatch(/^\/opt\/dsh-helper\/dsh-ssh-helper\.new\.[0-9a-f]{8}$/u)
  })

  it('reads the digest a probe printed', () => {
    expect(probeDigest(`${'e'.repeat(64)}  /opt/helper\n`)).toBe('e'.repeat(64))
    expect(probeDigest('')).toBeUndefined()
    expect(probeDigest('dsh-provision: the configured helper entry is absent')).toBeUndefined()
  })
})
