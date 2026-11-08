/**
 * Shared fixtures: a temporary repository writer, a subprocess stand-in that
 * records spawns instead of starting them, and a CLI runner stand-in that
 * answers the Docker / Dev Container probes. Nothing here touches a real
 * container.
 */

import { spawn as spawnProcess } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, posix } from 'node:path'
import { PassThrough, Writable } from 'node:stream'
import PtcRuntime from '@deepseek-ai/dsh-ptc-runtime'
import type { PtcRunRequest, PtcRunResult, PtcRunSpec } from '@deepseek-ai/dsh-ptc-runtime'
import SubprocessRuntime from '@deepseek-ai/dsh-subprocess'
import type {
  SubprocessHandle,
  SubprocessOutputReader,
  SubprocessSpawnSpec,
  SubprocessTerminalEnvironment,
  SubprocessTerminalHandle,
  SubprocessTerminalSpawnSpec,
} from '@deepseek-ai/dsh-subprocess'
import type { ContainerCommandOptions, ContainerCommandResult, ContainerRun } from '../src/exec.ts'
import { containerRemainder, toPosixSlashes } from '../src/paths.ts'
import type { ContainerChildSpawn } from '../src/rpc/client.ts'
import { RpcOperationError } from '../src/rpc/errors.ts'
import type { ContainerOptions, RepoContainerSpec } from '../src/types.ts'

const roots: string[] = []

/** Create one temporary directory that the suite removes at the end. */
export function temporaryDirectory(): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-devcontainer-'))
  roots.push(root)
  return root
}

/** Materialize a repository tree from relative paths to contents. */
export function makeRepo(files: Record<string, string>): string {
  const root = temporaryDirectory()
  for (const [relative, content] of Object.entries(files)) {
    const absolute = join(root, ...relative.split('/'))
    mkdirSync(dirname(absolute), { recursive: true })
    writeFileSync(absolute, content, 'utf8')
  }
  return root
}

/** Remove every temporary directory this suite created. */
export function cleanupTemporaryDirectories(): void {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
}

/** A reader over a fixed body of text, offset-based like the real seam. */
export function fixedReader(text: string): SubprocessOutputReader {
  return {
    readFrom: (fromByte: number) => ({
      text: text.slice(fromByte),
      nextOffset: text.length,
      lossy: false,
    }),
  }
}

/** Subprocess stand-in: records the spawn spec and settles as a successful empty command. */
export class FakeSubprocess extends SubprocessRuntime {
  static inject: string[] = []

  /** Every spec the executor handed to the seam. */
  readonly spawns: SubprocessSpawnSpec[] = []

  /** Body returned on stdout for every spawn. */
  stdout = ''

  /** Body returned on stderr for every spawn. */
  stderr = ''

  /** Exit code every spawn reports. */
  exitCode = 0

  override resolveExecutable(command: string): Promise<string> {
    return Promise.resolve(command)
  }

  override terminalEnvironment(): Promise<SubprocessTerminalEnvironment> {
    return Promise.resolve({ platform: 'posix', defaultShell: '/bin/bash' })
  }

  override spawn(spec: SubprocessSpawnSpec): SubprocessHandle {
    this.spawns.push(spec)
    return {
      stdin: undefined,
      stdout: undefined,
      stderr: undefined,
      control: undefined,
      collected: { stdout: fixedReader(this.stdout), stderr: fixedReader(this.stderr) },
      done: Promise.resolve({ exitCode: this.exitCode, signal: null }),
      terminate: () => {},
      waitForExit: () => Promise.resolve(true),
    }
  }

  override spawnTerminal(_spec: SubprocessTerminalSpawnSpec): Promise<SubprocessTerminalHandle> {
    return Promise.reject(new Error('devcontainer never spawns a terminal'))
  }
}

/** PTC stand-in: records both entry points and reports an empty program. */
export class FakePtc extends PtcRuntime {
  static inject: string[] = []

  readonly language = 'typescript'

  readonly isolation = 'process'

  /** Every request the seam was asked to resolve, after the decoration saw it. */
  readonly requests: PtcRunRequest[] = []

  /** Every spec the seam was asked to run, after the decoration saw it. */
  readonly runs: PtcRunSpec[] = []

  /**
   * The directory used when a request names none, standing in for the sandbox
   * policy's workspace root — the container's own spelling of the repository.
   */
  defaultCwd = '/workspaces/demo'

  resolve(request: PtcRunRequest): PtcRunSpec {
    this.requests.push(request)
    return { ...request, cwd: request.cwd ?? this.defaultCwd, timeoutMs: request.timeoutMs ?? null }
  }

  run(spec: PtcRunSpec): Promise<PtcRunResult> {
    this.runs.push(spec)
    return Promise.resolve({ logs: [] })
  }
}

/** One recorded CLI call. */
export interface RecordedCommand {
  readonly argv: readonly string[]
  readonly options: ContainerCommandOptions | undefined
}

/** CLI stand-in: answers with prepared results and records every argv. */
export interface FakeRan {
  readonly calls: RecordedCommand[]
  readonly run: ContainerRun
}

/** Build a CLI runner whose answers are keyed by the program it is asked for. */
export function fakeRunner(answers: Record<string, Omit<ContainerCommandResult, 'exitCode'> & { exitCode?: number | null }> = {}): FakeRan {
  const calls: RecordedCommand[] = []
  const run: ContainerRun = (argv, options) => {
    calls.push({ argv, options })
    const answer = answers[argv[0] ?? '']
    if (answer === undefined) return Promise.resolve({ stdout: '', stderr: '', exitCode: 1 })
    return Promise.resolve({
      stdout: answer.stdout,
      stderr: answer.stderr,
      exitCode: answer.exitCode === undefined ? 0 : answer.exitCode,
    })
  }
  return { calls, run }
}

/** A specification matching {@link makeRepo}'s `my-repo` fixture. */
export function repoSpec(root: string, overrides: Partial<RepoContainerSpec> = {}): RepoContainerSpec {
  return {
    hostWorkspaceRoot: root,
    containerWorkspaceFolder: '/workspaces/demo',
    configPath: join(root, '.devcontainer', 'devcontainer.json'),
    shell: '/bin/bash',
    cli: 'auto',
    ensureUp: true,
    containerTimeoutMs: 5_000,
    ...overrides,
  }
}

/** The shared option defaults a test row is configured with. */
export const DEFAULT_OPTIONS: ContainerOptions = {
  shell: '/bin/bash',
  cli: 'auto',
  ensureUp: true,
  containerTimeoutMs: 5_000,
  requireContainer: false,
}
// --- Container stand-ins -----------------------------------------------------

/** The one container mount every remote fixture declares. */
export const CONTAINER_MOUNT = '/workspaces/demo'

/**
 * Materialize a repository that declares a container, plus the host directory
 * its mount maps to.
 * @param files - repository-relative paths to contents.
 * @param config - extra devcontainer.json fields.
 * @returns the host root and the container mount point.
 */
export function makeContainerRepo(
  files: Record<string, string> = {},
  config: Record<string, unknown> = {},
): { root: string; folder: string } {
  const root = temporaryDirectory()
  const declaration = JSON.stringify({ workspaceFolder: CONTAINER_MOUNT, ...config }, null, 2)
  const write = (relative: string, content: string): void => {
    const absolute = join(root, ...relative.split('/'))
    mkdirSync(dirname(absolute), { recursive: true })
    writeFileSync(absolute, content, 'utf8')
  }
  write('.devcontainer/devcontainer.json', declaration)
  for (const [relative, content] of Object.entries(files)) write(relative, content)
  return { root, folder: CONTAINER_MOUNT }
}

/** The subset of the helper program a harness drives directly. */
interface HelperModule {
  handle(method: string, params: unknown): Promise<unknown>
}

/** A channel-shaped double that runs the real helper program in this process. */
export interface HelperChannel {
  /** What the helper reported during the handshake. */
  readonly handshake: { readonly workspace: string; readonly workspaceReal: string }
  /** Answer one request, translating between the container mount and the host directory. */
  request<T>(method: string, params?: unknown, options?: { signal?: AbortSignal }): Promise<T>
}

let helperInstances = 0

/**
 * Drive the shipped helper program against a real host directory.
 *
 * The helper computes in container paths while the fixture lives somewhere on
 * this host, so every path-bearing field is translated at the harness edge —
 * the same translation the container's own mount performs for real.
 * @param mount - the container mount point the filesystem row reports.
 * @param host - the host directory that mount stands for.
 * @returns a channel-shaped object the filesystem row can use.
 */
export async function helperChannel(mount: string, host: string): Promise<HelperChannel> {
  helperInstances += 1
  const url = `../src/helper/main.mjs?v=${helperInstances}`
  const loaded: unknown = await import(/* @vite-ignore */ url)
  const helper = loaded as HelperModule
  const hostRoot = toPosixSlashes(realpathSync(host))
  const toHost = (value: string): string => {
    const remainder = containerRemainder(value, mount)
    if (remainder === undefined) return value
    return remainder === '' ? hostRoot : posix.join(hostRoot, remainder)
  }
  const toMount = (value: string): string => {
    const remainder = containerRemainder(value, hostRoot)
    if (remainder === undefined) return value
    return remainder === '' ? mount : posix.join(mount, remainder)
  }
  const target = (value: unknown): unknown => {
    const record = value as { targetKey: string; displayPath: string }
    return { targetKey: toHost(record.targetKey), displayPath: toHost(record.displayPath) }
  }
  // The helper computes in container paths, but it runs against real host
  // directories here, so it is handshaken with the root it can resolve — its own
  // read guard resolves a target to a realpath and measures it against that
  // root. The row still fences targets in the container spelling, which is what
  // the reported handshake carries.
  await helper.handle('hello', { protocol: 3, workspace: hostRoot })
  return {
    handshake: { workspace: mount, workspaceReal: mount },
    async request<T>(method: string, params: unknown = {}): Promise<T> {
      const input = { ...(params as Record<string, unknown>) }
      if (typeof input.path === 'string') input.path = toHost(input.path)
      if (typeof input.cwd === 'string') input.cwd = toHost(input.cwd)
      for (const name of ['target', 'source', 'destination']) {
        if (input[name] !== undefined) input[name] = target(input[name])
      }
      let answer: unknown
      try {
        answer = await helper.handle(method, input)
      } catch (error: unknown) {
        // The transport reports failures as error frames; this harness reports
        // them the same way so callers see one failure vocabulary.
        const detail = error as { message?: string, code?: string }
        throw new RpcOperationError(detail.message ?? String(error), detail.code)
      }
      if (method === 'fs.resolve') {
        const resolved = answer as { targetKey: string; displayPath: string }
        return { targetKey: toMount(resolved.targetKey), displayPath: toMount(resolved.displayPath) } as T
      }
      if (method === 'fs.list') {
        const entries = answer as { name: string; type: string; target: { targetKey: string; displayPath: string }, version?: string, size?: number }[]
        return entries.map(entry => ({
          ...entry,
          target: { targetKey: toMount(entry.target.targetKey), displayPath: toMount(entry.target.displayPath) },
        })) as T
      }
      if (method === 'fs.move') {
        const moved = answer as { destination: { version: string, before: string | null, after: string, operation: string } }
        return { ...moved, destination: { ...moved.destination } } as T
      }
      return answer as T
    },
  }
}

/** A stand-in for `docker exec` that runs each helper with this host's Node. */
export interface FakeContainer {
  /** The process starter the filesystem row and the channel pool are given. */
  readonly spawn: ContainerChildSpawn
  /** Every argv the row asked for, in order. */
  readonly spawns: string[][]
  /** Terminate every running helper, as a container restart would. */
  crash(): void
}

/**
 * Build a container stand-in.
 *
 * The staging exec is answered in process (it only carries the helper source);
 * the channel exec becomes a real `node <staged file>`, so the framing, the
 * handshake, and every filesystem operation run for real.
 * @returns the stand-in and its recorded calls.
 */
export function fakeContainer(): FakeContainer {
  const spawns: string[][] = []
  const running = new Set<{ kill(signal?: NodeJS.Signals): void }>()
  let staged = ''
  let directory: string | undefined
  const spawn: ContainerChildSpawn = (argv) => {
    spawns.push([...argv])
    // The staging exec runs `sh -c <script>` after the driver's own prefix
    // (`docker exec -i <container>` or `sbx exec -i <sandbox> --`); the channel
    // exec runs `node <helper>` instead.
    if (argv.includes('sh')) {
      const chunks: Buffer[] = []
      const stdin = new Writable({
        write(chunk: Buffer, _encoding, callback) {
          chunks.push(Buffer.from(chunk))
          callback()
        },
      })
      const exited = new Promise<{ code: number | null, signal: string | null }>((resolve) => {
        stdin.on('finish', () => {
          staged = Buffer.concat(chunks).toString('utf8')
          resolve({ code: 0, signal: null })
        })
      })
      return { stdin, stdout: new PassThrough(), stderr: new PassThrough(), exited, kill: () => {} }
    }
    directory ??= mkdtempSync(join(tmpdir(), 'dsh-devcontainer-helper-'))
    const script = join(directory, `helper-${spawns.length}.mjs`)
    writeFileSync(script, staged, 'utf8')
    const child = spawnProcess(process.execPath, [script], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })
    child.stdin.on('error', () => {})
    const handle = {
      stdin: child.stdin,
      stdout: child.stdout,
      stderr: child.stderr,
      exited: new Promise<{ code: number | null, signal: string | null }>((resolve) => {
        child.once('exit', (code, signal) => { resolve({ code, signal }) })
        child.once('error', () => { resolve({ code: null, signal: null }) })
      }),
      kill: (signal?: NodeJS.Signals) => { child.kill(signal) },
    }
    running.add(handle)
    void handle.exited.then(() => { running.delete(handle) })
    return handle
  }
  return {
    spawn,
    spawns,
    crash: () => {
      for (const child of running) child.kill('SIGKILL')
    },
  }
}
