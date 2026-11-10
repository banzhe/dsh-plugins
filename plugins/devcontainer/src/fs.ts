/**
 * `ctx.fs` for repositories that declare a Dev Container, or run in a Docker
 * Sandbox.
 *
 * A derived preset promises that nothing the session touches happens on the host. This backend keeps that promise at the filesystem seam instead of
 * fencing the host path by path: in a container-bound session every operation —
 * `resolve`, `lstat`, `stat`, reads, listings, writes, edits, patches, deletes,
 * and moves — is delegated over a persistent RPC pipe to a Node helper running
 * inside the Linux container (see `src/helper/main.mjs` and `src/rpc/`). The
 * container resolves the path, follows the symlink, and performs the I/O, so a
 * Windows drive letter is not merely refused but physically unreachable.
 *
 * Two cases keep their earlier behaviour on purpose:
 *
 * - An ordinary preset in the same repository keeps the host backend, mapped
 *   onto the bind mount, so a session that never entered the container sees the
 *   files exactly as before this row existed.
 * - A `(devContainer)` preset over a repository that declares no container still
 *   fails fast with `FS_PERMISSION_DENIED`: there is nowhere to delegate to, and
 *   quietly writing the host while the model believes it wrote Linux is the
 *   worst possible outcome.
 *
 * The runtime behind the pipe is either a Docker container or a Docker Sandbox
 * (`ChannelTarget`): the second one mounts the host workspace at its own absolute
 * path, so the delegated paths are the ones the model already writes, and the
 * helper still runs the sandbox's own Linux `node`.
 *
 * Containment inside the runtime is still enforced here — a request, and every
 * identity the runtime resolves, must stay inside the repository's mount, in any
 * spelling that mount has inside the runtime — so a session cannot wander off
 * into the container's own `/etc` either.
 * @module @banzhe/dsh-devcontainer/fs
 */

import { posix } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { FsError } from '@deepseek-ai/dsh-fs'
import type {
  FsDirEntry,
  FsEditOutcome,
  FsEditRequest,
  FsInfo,
  FsPathInfo,
  FsTarget,
  FsVersion,
  FsWriteIntent,
  FsWriteOutcome,
} from '@deepseek-ai/dsh-fs'
import type { Config as LocalFsConfig } from '@deepseek-ai/dsh-fs-local'
import { SandboxedFileSystem } from '@deepseek-ai/dsh-fs-sandbox'
import { resolveContainerTarget } from './container.ts'
import type { ContainerTarget } from './container.ts'
import { runContainerCommand } from './exec.ts'
import type { ContainerRun } from './exec.ts'
import { containerOptionFields, containerOptions } from './options.ts'
import {
  containerRemainder,
  hostPathStyle,
  isPathInsideContainer,
  isPosixAbsolute,
  isWindowsPath,
  joinHostRoot,
  relativeWithinHostRoot,
  toContainerPath,
  toHostPath,
  toPosixSlashes,
} from './paths.ts'
import { callingContainerPreset, fsEscapeRefusalText, fsRefusalText, presetKindOf } from './refusal.ts'
import { liveSandboxTemplate, repoRegistry } from './registry.ts'
import { asSbxSpec, bindSbxMount, sandboxHostPathFor, sandboxWorkspacePath, sbxSpecFor, sbxWorkspaceRootFor } from './sbx.ts'
import { ContainerRpcChannel, DEFAULT_RPC_TIMEOUT_MS, spawnContainerChild } from './rpc/client.ts'
import type { ChannelTarget, ContainerChildSpawn, RequestOptions } from './rpc/client.ts'
import { RpcOperationError, rpcFsError } from './rpc/errors.ts'
import { ContainerRpcPool } from './rpc/pool.ts'
import {
  toFsDeleteOutcome,
  toFsDirEntry,
  toFsEditOutcome,
  toFsInfo,
  toFsMoveOutcome,
  toFsPathInfo,
  toFsTarget,
  toFsWriteOutcome,
} from './rpc/wire.ts'
import type {
  ContainerDeleteOutcome,
  ContainerMoveOutcome,
  WireDeleteOutcome,
  WireDirEntry,
  WireEditOutcome,
  WireInfo,
  WireMoveOutcome,
  WirePathInfo,
  WireStreamId,
  WireStreamStep,
  WireTarget,
  WireWriteOutcome,
} from './rpc/wire.ts'
import type { ContainerOptions, RepoContainerSpec } from './types.ts'
import type { VariantKind } from './ids.ts'

/** Plugin name used by the Loader row. */
export const name = 'devcontainer-fs'

/** The local backend's knobs plus this Bundle's container options. */
export interface Config extends LocalFsConfig, ContainerOptions {
  /** Budget for one container filesystem request, in milliseconds. */
  rpcTimeoutMs?: number
}

/** The local backend's own overwrite-diff budget; the constructor validates it, so it must be defaulted here. */
const DEFAULT_DIFF_BASIS_MAX_BYTES = 10 * 1024 * 1024

/** How often a container-backed watch re-probes the target it follows. */
const REMOTE_WATCH_INTERVAL_MS = 1_000

/** Key separator for the per-repository container cache. */
const KEY_SEPARATOR = '\u0000'

/** Mirrors `@deepseek-ai/dsh-fs-local`'s schema plus the shared container options. */
const ConfigSchema = z.object({
  cwd: z.string().default(process.cwd()),
  diffBasisMaxBytes: z.number().default(DEFAULT_DIFF_BASIS_MAX_BYTES),
  rpcTimeoutMs: z.number().default(DEFAULT_RPC_TIMEOUT_MS),
  ...containerOptionFields(),
})

/** The row's schema, typed for callers; the loader reads the class's static copy. */
export const Config = ConfigSchema as unknown as z<Config>

/** A container-bound call: the repository that owns the path, and the preset that demanded it. */
interface RemoteRoute {
  /** The repository whose container performs the work. */
  readonly spec: RepoContainerSpec
  /** The `(devContainer)` preset that issued the call, when one is known. */
  readonly preset: string | undefined
}

/**
 * Target-taking mutation entry points a NEWER base backend declares.
 *
 * The installed `@deepseek-ai/dsh-fs-sandbox` fences only `writeText` and
 * `editText`, so `patchText`, `deleteFile`, and `moveFile` exist in no type this
 * build can `override`. They are still the way a caller holding a target reaches
 * a file, so each is installed as an own property: a container-bound call is
 * delegated over RPC, and an ordinary one runs the inherited implementation when
 * the base declares it.
 */
const INHERITED_MUTATIONS: readonly string[] = ['patchText', 'deleteFile', 'moveFile']

/**
 * The stdio endpoint one resolved runtime offers the helper.
 * @param target - the resolved runtime.
 * @param workspace - the mount point the helper treats as home.
 * @returns the channel target the pool keys and the helper is started against.
 * @throws Error when the runtime has no stdio endpoint at all.
 */
function channelTargetOf(target: ContainerTarget, workspace: string): ChannelTarget {
  switch (target.kind) {
    case 'docker': return { kind: 'docker', containerId: target.containerId, workspace }
    case 'sbx': return { kind: 'sbx', sandboxName: target.sandboxName, workspace }
    case 'devcontainer-cli':
      throw new Error('devcontainer: the Dev Container CLI offers no stdio channel for the filesystem helper')
  }
}

/** Serialize one target for the wire. */
function wireTargetOf(target: FsTarget): WireTarget {
  return { targetKey: String(target.targetKey), displayPath: target.displayPath }
}

/**
 * Every folder a container path this session may use starts in.
 *
 * The specification's own mount point comes first. A Docker Sandbox also spells
 * the same workspace the way its host convention does — a Windows drive
 * directory is mounted without the drive colon, so `F:\personal\asmr-manager` is
 * `/f/personal/asmr-manager` inside the sandbox — and a listing that reported no
 * mounts leaves that spelling as the only usable one. The container's realpath of
 * the mount point is a third, because a Dev Container feature may have moved it.
 * @param spec - the repository container specification the call runs under.
 * @param workspaceReal - the realpath the container reported for its handshake workspace, when known.
 * @returns the mount spellings a request and a resolved identity may start with.
 */
function containerMountsOf(spec: RepoContainerSpec, workspaceReal: string | undefined): string[] {
  const folders = [spec.containerWorkspaceFolder]
  if (spec.cli === 'sbx') {
    const sandbox = sandboxWorkspacePath(spec.hostWorkspaceRoot)
    if (sandbox !== undefined && sandbox !== spec.containerWorkspaceFolder) folders.push(sandbox)
  }
  if (workspaceReal !== undefined && !folders.includes(workspaceReal)) folders.push(workspaceReal)
  return folders
}

/**
 * The filesystem seam for container-bound sessions: host behaviour for ordinary
 * presets, full remote delegation for `(devContainer)` ones.
 */
export class DevcontainerFileSystem extends SandboxedFileSystem {
  /**
   * The schema the Loader resolves this row's config through; a static because
   * the module's `default` export is this class (see
   * `DevcontainerShellExecutor.Config` for the same reason).
   */
  static override Config = ConfigSchema

  /** Test seam: replaces the host CLI runner, the container process starter, and the channel. */
  containerInternals: {
    run?: ContainerRun
    spawn?: ContainerChildSpawn
    channel?: (target: ChannelTarget) => Promise<ContainerRpcChannel>
  } = {}

  /** The container options this row was configured with (the inherited `config` is typed by the local backend). */
  private readonly options: ContainerOptions

  /** Budget for one RPC round trip. */
  private readonly rpcTimeoutMs: number

  /** Whether the configured directory has been walked for a declaration yet. */
  private warmed = false

  /** Whether this composition has learned where its sandbox mounts the workspace. */
  private sbxProbed = false

  /** One channel per container, shared by every call of this composition. */
  private readonly pool: ContainerRpcPool

  /** One resolved runtime per repository, so a burst of calls probes the CLI once. */
  private readonly containers = new Map<string, Promise<ContainerTarget>>()

  constructor(ctx: Context, config: Config) {
    super(ctx, config)
    this.options = containerOptions(config)
    this.rpcTimeoutMs = config.rpcTimeoutMs ?? DEFAULT_RPC_TIMEOUT_MS
    this.pool = new ContainerRpcPool((argv, options) => (this.containerInternals.spawn ?? spawnContainerChild)(argv, options))
    this.installTargetMutations()
    ctx.effect(() => {
      const cache = repoRegistry(ctx)
      return () => { cache.reset() }
    })
    ctx.effect(() => () => this.pool.closeAll())
  }

  /**
   * Resolve a model-supplied path inside the container, or translate it onto the
   * host bind mount for an ordinary preset.
   * @param path - the path to resolve; relative paths resolve against `opts.cwd`.
   * @param opts - optional cwd override and cancellation signal.
   * @returns the stable target.
   * @throws FsError `FS_PERMISSION_DENIED` when the caller is container-bound and this path is outside the repository's mount.
   */
  override async resolve(path: string, opts?: { cwd?: string; signal?: AbortSignal }): Promise<FsTarget> {
    const route = await this.route(path, opts?.cwd)
    if (route === undefined) {
      const mapped = this.mapPath(path, opts?.cwd)
      const next: { cwd?: string; signal?: AbortSignal } = {}
      if (mapped.cwd !== undefined) next.cwd = mapped.cwd
      if (opts?.signal !== undefined) next.signal = opts.signal
      return await super.resolve(mapped.path, next)
    }
    const requested = this.remotePath(path, opts?.cwd, route)
    return await this.withChannel(route.spec, opts?.signal, async (channel) => {
      const answer = await this.request<WireTarget>(channel, 'fs.resolve', { path: requested }, opts?.signal)
      this.assertInsideMount(answer.targetKey, path, route, channel.handshake.workspaceReal)
      return toFsTarget(answer)
    })
  }

  /**
   * The host path a target stands for, when the container's spelling is not one.
   *
   * A container path names a directory inside the runtime. On a POSIX host that
   * namespace is still the host's own root, so the container spelling is a usable
   * host path and the inherited identity — the target key, which the wire also
   * carries — is the right answer. A Windows host has no such root: `/f/personal/repo`
   * is a drive-relative path there, and `path.resolve('/f/personal/repo', '.git')`
   * yields `F:\f\personal\repo\.git`, a directory no repository contains.
   *
   * Host-bound consumers read this value as a HOST path — `WorkingDirectoryService`
   * commits it as the Session directory, the project-root walk appends `.git` to
   * it, and `ctx.subprocess` starts a process in it — so a container spelling that
   * no host path module can resolve would fail them all. A Windows-rooted
   * repository therefore answers the host path of its mount; the container spelling
   * keeps the two jobs it owns, the argv a runtime is started with
   * (`buildExecArgv`) and the payload of an RPC request (`wireTargetOf`).
   * @param target - the resolved target.
   * @returns its host path, or the inherited identity outside a Windows-rooted repository.
   */
  override processPath(target: FsTarget): string {
    const spec = this.repositoryFor(target.displayPath, undefined, this.containerRequirement()?.kind)
    if (spec === undefined || hostPathStyle(spec.hostWorkspaceRoot) !== 'win32') return super.processPath(target)
    return toHostPath(String(target.targetKey), spec)
  }

  /**
   * Probe a path inside the container without following its final symlink.
   * @param path - the path to inspect.
   * @param opts - `cwd` overrides the base for relative paths.
   * @param signal - aborts the metadata round-trip.
   * @returns metadata only, or undefined when the path is absent.
   * @throws FsError `FS_PERMISSION_DENIED` when the caller is container-bound and this path is outside the repository's mount.
   */
  override async lstat(path: string, opts?: { cwd?: string }, signal?: AbortSignal): Promise<FsPathInfo | undefined> {
    const route = await this.route(path, opts?.cwd)
    if (route === undefined) {
      const mapped = this.mapPath(path, opts?.cwd)
      const next: { cwd?: string } = {}
      if (mapped.cwd !== undefined) next.cwd = mapped.cwd
      return await super.lstat(mapped.path, next, signal)
    }
    const requested = this.remotePath(path, opts?.cwd, route)
    return await this.withChannel(route.spec, signal, async (channel) => {
      const info = await this.request<WirePathInfo | null>(channel, 'fs.lstat', { path: requested }, signal)
      return info === null ? undefined : toFsPathInfo(info)
    })
  }

  /**
   * Read metadata of a resolved target.
   * @param target - the resolved target.
   * @param signal - aborts the metadata round-trip.
   * @returns metadata only, or undefined when the target is absent.
   * @throws FsError `FS_PERMISSION_DENIED` when the caller is container-bound and this target is not in a container repository.
   */
  override async stat(target: FsTarget, signal?: AbortSignal): Promise<FsInfo | undefined> {
    const route = await this.routeTarget(target)
    if (route === undefined) return await super.stat(this.fenced(target), signal)
    return await this.withChannel(route.spec, signal, async (channel) => {
      this.assertTargetInsideMount(target, route, channel)
      const value = await this.request<WireInfo | null>(channel, 'fs.stat', { target: wireTargetOf(target) }, signal)
      return value === null ? undefined : toFsInfo(value)
    })
  }

  /**
   * Read a whole text file inside the container.
   * @param target - the resolved target.
   * @param signal - aborts the read.
   * @returns the file's text.
   * @throws FsError `FS_PERMISSION_DENIED` when the caller is container-bound and this target is not in a container repository.
   */
  override async readText(target: FsTarget, signal?: AbortSignal): Promise<string> {
    const route = await this.routeTarget(target)
    if (route === undefined) return await super.readText(this.fenced(target), signal)
    return await this.withChannel(route.spec, signal, async (channel) => {
      this.assertTargetInsideMount(target, route, channel)
      return await this.request<string>(channel, 'fs.readText', { target: wireTargetOf(target) }, signal)
    })
  }

  /**
   * Stream a text file through the container helper's iterator.
   *
   * Only the refusal is decided here; the `fs.stream` request belongs to the
   * first iteration, so an iterator nobody reads holds no helper slot.
   * @param target - the resolved target.
   * @param signal - aborts the stream.
   * @returns the text stream.
   * @throws FsError `FS_PERMISSION_DENIED` when the caller is container-bound and this target is not in a container repository.
   */
  override async streamText(target: FsTarget, signal?: AbortSignal): Promise<AsyncIterable<string>> {
    const route = await this.routeTarget(target)
    if (route === undefined) return await super.streamText(this.fenced(target), signal)
    const channel = await this.remoteChannel(route.spec, signal)
    this.assertTargetInsideMount(target, route, channel)
    return this.iterate(channel, wireTargetOf(target), route.spec, signal)
  }

  /**
   * Read a file as bytes inside the container.
   * @param target - the resolved target.
   * @param signal - aborts the read.
   * @param maxBytes - the exclusive size limit.
   * @returns the file's bytes.
   * @throws FsError `FS_PERMISSION_DENIED` when the caller is container-bound and this target is not in a container repository.
   */
  override async readBytes(target: FsTarget, signal: AbortSignal | undefined, maxBytes: number): Promise<Uint8Array> {
    const route = await this.routeTarget(target)
    if (route === undefined) return await super.readBytes(this.fenced(target), signal, maxBytes)
    return await this.withChannel(route.spec, signal, async (channel) => {
      this.assertTargetInsideMount(target, route, channel)
      const encoded = await this.request<string>(
        channel, 'fs.readBytes', { target: wireTargetOf(target), maxBytes }, signal,
      )
      return Buffer.from(encoded, 'base64')
    })
  }

  /**
   * Read a bounded byte range inside the container.
   * @param target - the resolved target.
   * @param range - offset and length of the window.
   * @param signal - aborts the read.
   * @returns the bytes of that window.
   * @throws FsError `FS_PERMISSION_DENIED` when the caller is container-bound and this target is not in a container repository.
   */
  override async readByteRange(
    target: FsTarget, range: { offset: number; length: number }, signal?: AbortSignal,
  ): Promise<Uint8Array> {
    const route = await this.routeTarget(target)
    if (route === undefined) return await super.readByteRange(this.fenced(target), range, signal)
    return await this.withChannel(route.spec, signal, async (channel) => {
      this.assertTargetInsideMount(target, route, channel)
      const encoded = await this.request<string>(
        channel, 'fs.readRange', { target: wireTargetOf(target), offset: range.offset, length: range.length }, signal,
      )
      return Buffer.from(encoded, 'base64')
    })
  }

  /**
   * List one directory inside the container.
   * @param target - the resolved directory target.
   * @param signal - aborts the listing.
   * @returns the direct children with their resolved targets.
   * @throws FsError `FS_PERMISSION_DENIED` when the caller is container-bound and this target is not in a container repository.
   */
  override async listDir(target: FsTarget, signal?: AbortSignal): Promise<FsDirEntry[]> {
    const route = await this.routeTarget(target)
    if (route === undefined) return await super.listDir(this.fenced(target), signal)
    return await this.withChannel(route.spec, signal, async (channel) => {
      this.assertTargetInsideMount(target, route, channel)
      const entries = await this.request<WireDirEntry[]>(
        channel, 'fs.list', { target: wireTargetOf(target) }, signal,
      )
      return entries.map(toFsDirEntry)
    })
  }

  /**
   * Watch one target for the GUI.
   *
   * A host watcher would have to open a host path, which is exactly the
   * penetration this row exists to prevent, so a container-backed watcher
   * re-probes the target over RPC and reports a change when its version token
   * moves.
   * @param target - the resolved target to watch.
   * @param changed - reports each change, or a watcher failure.
   * @param signal - aborts the watch: aborting stops the polling even when the caller never calls the disposer.
   * @returns the disposer of the watcher.
   * @throws FsError `FS_PERMISSION_DENIED` when the caller is container-bound and this target is not in a container repository.
   */
  override async watch(
    target: FsTarget, changed: (error?: Error) => void, signal: AbortSignal,
  ): Promise<() => Promise<void>> {
    const route = await this.routeTarget(target)
    if (route === undefined) return await super.watch(this.fenced(target), changed, signal)
    signal.throwIfAborted()
    const channel = await this.remoteChannel(route.spec, signal)
    this.assertTargetInsideMount(target, route, channel)
    let version = await this.versionOf(channel, target)
    let busy = false
    let disposed = false
    const report = (error?: Error): void => {
      try {
        changed(error)
      } catch {
        // A reporter that throws must not take the poll loop down with it: the
        // watcher is the caller's only signal, and a change it dropped is still
        // visible on the next probe.
      }
    }
    const timer = setInterval(() => {
      if (busy || disposed) return
      busy = true
      void this.versionOf(channel, target).then((next) => {
        if (disposed || next === version) return
        version = next
        report()
      }, (error: unknown) => {
        // A dead container cannot heal by re-probing every interval: report it
        // once and let the caller re-resolve the target.
        stop()
        report(error instanceof Error ? error : new Error(String(error)))
      }).finally(() => { busy = false })
    }, REMOTE_WATCH_INTERVAL_MS)
    timer.unref()

    /** Stop polling, once; the caller's disposer and its signal both reach it. */
    const stop = (): void => {
      if (disposed) return
      disposed = true
      clearInterval(timer)
      signal.removeEventListener('abort', stop)
    }
    signal.addEventListener('abort', stop, { once: true })
    return () => {
      stop()
      return Promise.resolve()
    }
  }

  /**
   * Write a whole file inside the container.
   *
   * The per-call sandbox policy is deliberately not applied: it describes host
   * paths and a host mode, while the container is the confinement here.
   * @param target - the resolved target to write.
   * @param content - the full new file content.
   * @param expected - the write intent guarding the write; omit for unconditional.
   * @param signal - aborts before atomic publication takes effect.
   * @param _sandboxPolicy - the host policy, unused for a container target.
   * @returns the write outcome from the container helper.
   * @throws FsError `FS_PERMISSION_DENIED` when the caller is container-bound and this target is not in a container repository.
   */
  override async writeText(
    target: FsTarget, content: string, expected?: FsWriteIntent, signal?: AbortSignal,
    _sandboxPolicy?: Parameters<SandboxedFileSystem['writeText']>[4],
  ): Promise<FsWriteOutcome> {
    const route = await this.routeTarget(target)
    if (route === undefined) {
      return await super.writeText(this.fenced(target), content, expected, signal, _sandboxPolicy)
    }
    return await this.withChannel(route.spec, signal, async (channel) => {
      this.assertTargetInsideMount(target, route, channel)
      const outcome = await this.request<WireWriteOutcome>(
        channel, 'fs.write', { target: wireTargetOf(target), content, expected }, signal,
      )
      return toFsWriteOutcome(outcome)
    })
  }

  /**
   * Apply a literal edit inside the container.
   * @param target - the resolved target to edit.
   * @param edit - the literal search/replace request.
   * @param expected - the version guard; omit for an unconditional edit.
   * @param signal - aborts before atomic publication takes effect.
   * @param _sandboxPolicy - the host policy, unused for a container target.
   * @returns the edit outcome from the container helper.
   * @throws FsError `FS_PERMISSION_DENIED` when the caller is container-bound and this target is not in a container repository.
   */
  override async editText(
    target: FsTarget, edit: FsEditRequest, expected?: { version: FsVersion }, signal?: AbortSignal,
    _sandboxPolicy?: Parameters<SandboxedFileSystem['editText']>[4],
  ): Promise<FsEditOutcome> {
    const route = await this.routeTarget(target)
    if (route === undefined) {
      return await super.editText(this.fenced(target), edit, expected, signal, _sandboxPolicy)
    }
    return await this.withChannel(route.spec, signal, async (channel) => {
      this.assertTargetInsideMount(target, route, channel)
      const outcome = await this.request<WireEditOutcome>(
        channel, 'fs.edit', { target: wireTargetOf(target), edit, expected }, signal,
      )
      return toFsEditOutcome(outcome)
    })
  }

  /** The container channel for one route, translated into the seam's error vocabulary. */
  private async remoteChannel(spec: RepoContainerSpec, signal?: AbortSignal): Promise<ContainerRpcChannel> {
    signal?.throwIfAborted()
    const runtime = await this.runtimeTarget(spec, signal)
    // A sandbox may mount the workspace under a path of its own, which only its
    // listing reports: the helper starts in the folder that really exists there.
    const target = channelTargetOf(runtime, bindSbxMount(spec, runtime).containerWorkspaceFolder)
    const channel = this.containerInternals.channel
    if (channel !== undefined) return await channel(target)
    return await this.pool.channel(target, { timeoutMs: this.rpcTimeoutMs })
  }

  /**
   * Run one operation against a live channel, mapping its failures.
   * @param spec - the repository whose container is used.
   * @param signal - the caller's cancellation.
   * @param operation - the work to run with the channel.
   * @returns what the operation produced.
   * @throws FsError for every transport and remote failure.
   */
  private async withChannel<T>(
    spec: RepoContainerSpec,
    signal: AbortSignal | undefined,
    operation: (channel: ContainerRpcChannel) => Promise<T>,
  ): Promise<T> {
    try {
      const channel = await this.remoteChannel(spec, signal)
      return await operation(channel)
    } catch (error: unknown) {
      // A transport failure may mean the container was recreated, so the cached
      // id is no longer trustworthy and the next call probes again.
      if (!(error instanceof RpcOperationError)) this.forgetContainer(spec)
      throw rpcFsError(error, signal)
    }
  }

  /** Send one request with this row's budget. */
  private async request<T>(
    channel: ContainerRpcChannel, method: string, params: unknown, signal?: AbortSignal,
  ): Promise<T> {
    const options: RequestOptions = signal === undefined
      ? { timeoutMs: this.rpcTimeoutMs }
      : { timeoutMs: this.rpcTimeoutMs, signal }
    return await channel.request<T>(method, params, options)
  }

  /**
   * One text stream, opened by its first iteration and closed however it ends.
   *
   * Opening inside the generator is what makes the lifecycle airtight: an
   * iterator the caller drops without reading never sends `fs.stream`, and
   * every way an iteration can stop — completion, `break`, a throw, a cancelled
   * scope — runs the `finally` that sends `fs.streamClose`. The helper holds 64
   * streams at most, so a leaked slot is a permanent loss for the session.
   * A broken pipe drops the cached container too.
   * @param channel - the live container channel.
   * @param target - the target to stream, as the helper names it.
   * @param spec - the repository whose container is used.
   * @param signal - aborts the stream.
   * @returns the text stream.
   */
  private iterate(
    channel: ContainerRpcChannel, target: WireTarget, spec: RepoContainerSpec, signal?: AbortSignal,
  ): AsyncIterable<string> {
    const request = async <T>(method: string, params: unknown, scope?: AbortSignal): Promise<T> => {
      try {
        return await this.request<T>(channel, method, params, scope)
      } catch (error: unknown) {
        if (!(error instanceof RpcOperationError)) this.forgetContainer(spec)
        throw rpcFsError(error, scope)
      }
    }
    return (async function* stream(): AsyncIterable<string> {
      let opened: string | undefined
      let ended = false
      try {
        signal?.throwIfAborted()
        opened = (await request<WireStreamId>('fs.stream', { target }, signal)).id
        const id = opened
        while (!ended) {
          signal?.throwIfAborted()
          const step = await request<WireStreamStep>('fs.next', { id }, signal)
          ended = step.done
          if (!ended && step.value.length > 0) yield step.value
        }
      } finally {
        const id = opened
        if (id !== undefined && !ended) await request<null>('fs.streamClose', { id }).catch(() => {})
      }
    })()
  }

  /** The version token of one target, for the polling watcher. */
  private async versionOf(channel: ContainerRpcChannel, target: FsTarget): Promise<string> {
    const info = await this.request<WireInfo | null>(channel, 'fs.stat', { target: wireTargetOf(target) })
    return info === null ? 'absent' : info.version
  }

  /**
   * The runtime filesystem calls are delegated to.
   * @param spec - the repository container specification.
   * @param signal - cancels the Docker / sandbox probe.
   * @returns the resolved target the channel speaks to.
   * @throws FsError `FS_IO_ERROR` when the runtime has no stdio endpoint for the helper.
   */
  private runtimeTarget(spec: RepoContainerSpec, signal?: AbortSignal): Promise<ContainerTarget> {
    const key = this.containerKey(spec)
    const cached = this.containers.get(key)
    if (cached !== undefined) return cached
    const pending = this.probeContainer(spec, signal)
    this.containers.set(key, pending)
    pending.catch(() => {
      // A failed probe must not cache its failure; the next call retries.
      if (this.containers.get(key) === pending) this.containers.delete(key)
    })
    return pending
  }

  /** The cache key of one repository's container. */
  private containerKey(spec: RepoContainerSpec): string {
    return [
      spec.hostWorkspaceRoot, spec.cli, spec.container ?? '', spec.sandbox ?? '', String(spec.ensureUp),
    ].join(KEY_SEPARATOR)
  }

  /** Drop one cached runtime, so the next call probes again. */
  private forgetContainer(spec: RepoContainerSpec): void {
    this.containers.delete(this.containerKey(spec))
  }

  /** Probe where the repository's container is, requiring an endpoint the helper can be started in. */
  private async probeContainer(spec: RepoContainerSpec, signal?: AbortSignal): Promise<ContainerTarget> {
    const target = await resolveContainerTarget(spec, this.containerInternals.run ?? runContainerCommand, signal)
    if (target.kind === 'devcontainer-cli') {
      // `devcontainer exec` allocates a process of its own and offers no stdio
      // channel, so there is no pipe to run the helper over.
      throw new FsError(
        'devcontainer: "' + spec.configPath + '": the filesystem bridge needs a running Docker container for "'
        + spec.hostWorkspaceRoot + '", but none was found; set "container" or "containerName", or let the '
        + 'Dev Container CLI start one with "cli: auto" and "ensureUp: true".',
        'FS_IO_ERROR',
      )
    }
    return target
  }

  /** Translate one path for a container-bound call, refusing anything outside the mount. */
  private remotePath(path: string, cwd: string | undefined, route: RemoteRoute): string {
    const base = toContainerPath(cwd ?? this.config.cwd, route.spec)
    const absolute = isWindowsPath(path) || isPosixAbsolute(path)
      ? toContainerPath(path, route.spec)
      : posix.resolve(base, toPosixSlashes(path))
    this.assertInsideMount(absolute, path, route)
    return absolute
  }

  /** Refuse a container path that leaves every spelling of the repository's mount. */
  private assertInsideMount(
    containerPath: string, displayPath: string, route: RemoteRoute, workspaceReal?: string,
  ): void {
    for (const folder of containerMountsOf(route.spec, workspaceReal)) {
      if (containerRemainder(containerPath, folder) !== undefined) return
    }
    throw new FsError(fsEscapeRefusalText(displayPath, containerPath, route.preset), 'FS_PERMISSION_DENIED')
  }

  /** Refuse an already-resolved target that leaves the repository's mount. */
  private assertTargetInsideMount(target: FsTarget, route: RemoteRoute, channel: ContainerRpcChannel): void {
    this.assertInsideMount(String(target.targetKey), target.displayPath, route, channel.handshake.workspaceReal)
  }

  /**
   * Install the target-taking mutations this build's base class may not declare.
   *
   * An own property shadows the inherited method, so the wrapper is what every
   * caller reaches: a container-bound call becomes an RPC, and an ordinary one
   * still runs the inherited implementation — read from the prototype it was
   * reached through — or reports a typed failure when this backend has none.
   */
  private installTargetMutations(): void {
    const backend = this as unknown as Record<string, unknown>
    for (const method of INHERITED_MUTATIONS) {
      const inherited = backend[method]
      Object.defineProperty(this, method, {
        configurable: true,
        writable: true,
        // Async so a refusal rejects like the inherited method, instead of
        // throwing out of a call the seam contracts to answer with a promise.
        value: async (...args: unknown[]): Promise<unknown> => {
          const target = args[0] as FsTarget | undefined
          const route = target === undefined ? undefined : await this.routeTarget(target)
          if (route === undefined) {
            if (typeof inherited !== 'function') {
              throw new FsError(method + ' is not supported by this filesystem backend', 'FS_IO_ERROR')
            }
            return await (inherited as (...rest: unknown[]) => Promise<unknown>).apply(this, args)
          }
          return await this.remoteMutation(method, route, args)
        },
      })
    }
  }

  /** Run one installed mutation over RPC. */
  private async remoteMutation(method: string, route: RemoteRoute, args: unknown[]): Promise<unknown> {
    if (method === 'patchText') {
      const [target, hunks, expected, signal] = args as [
        FsTarget, readonly unknown[], { version: FsVersion } | undefined, AbortSignal | undefined,
      ]
      return await this.withChannel(route.spec, signal, async (channel) => {
        this.assertTargetInsideMount(target, route, channel)
        const outcome = await this.request<WireEditOutcome>(
          channel, 'fs.patch', { target: wireTargetOf(target), hunks, expected }, signal,
        )
        const edited: FsEditOutcome = toFsEditOutcome(outcome)
        return edited
      })
    }
    if (method === 'deleteFile') {
      const [target, expected, signal] = args as [
        FsTarget, { version: FsVersion } | undefined, AbortSignal | undefined,
      ]
      return await this.withChannel(route.spec, signal, async (channel) => {
        this.assertTargetInsideMount(target, route, channel)
        const outcome = await this.request<WireDeleteOutcome>(
          channel, 'fs.delete', { target: wireTargetOf(target), expected },
        )
        const deleted: ContainerDeleteOutcome = toFsDeleteOutcome(outcome)
        return deleted
      })
    }
    const [source, destination, options, signal] = args as [
      FsTarget,
      FsTarget,
      {
        hunks?: readonly unknown[]
        expectedSource?: { version: FsVersion }
        expectedDestination?: FsWriteIntent
      } | undefined,
      AbortSignal | undefined,
    ]
    const destinationRoute = await this.routeTarget(destination)
    if (destinationRoute === undefined) {
      throw new FsError('devcontainer: the move destination is outside every container repository', 'FS_PERMISSION_DENIED')
    }
    return await this.withChannel(route.spec, signal, async (channel) => {
      this.assertTargetInsideMount(source, route, channel)
      this.assertTargetInsideMount(destination, destinationRoute, channel)
      const outcome = await this.request<WireMoveOutcome>(
        channel, 'fs.move', { source: wireTargetOf(source), destination: wireTargetOf(destination), options },
      )
      const moved: ContainerMoveOutcome = toFsMoveOutcome(outcome)
      return moved
    })
  }

  /**
   * Route one path-taking call.
   * @param path - the path the caller named.
   * @param cwd - the directory relative paths resolve against.
   * @returns the container route, or undefined when this call keeps the host backend.
   * @throws FsError `FS_PERMISSION_DENIED` when the caller is container-bound and nothing declares a container for the path.
   */
  private async route(path: string, cwd: string | undefined): Promise<RemoteRoute | undefined> {
    const requirement = this.containerRequirement()
    await this.prepareSbxMount(requirement?.kind, cwd ?? this.config.cwd)
    const spec = this.repositoryFor(path, cwd, requirement?.kind)
    if (spec === undefined) {
      this.refuseHostAccess(path)
      return undefined
    }
    if (requirement === undefined) return undefined
    return { spec, preset: requirement.preset }
  }

  /**
   * Route one already-resolved call.
   * @param target - the target the caller holds.
   * @returns the container route, or undefined when this call keeps the host backend.
   * @throws FsError `FS_PERMISSION_DENIED` when the caller is container-bound and this target is not in a container repository.
   */
  private async routeTarget(target: FsTarget): Promise<RemoteRoute | undefined> {
    const requirement = this.containerRequirement()
    if (requirement === undefined) return undefined
    await this.prepareSbxMount(requirement.kind, this.config.cwd)
    const spec = this.repositoryFor(target.displayPath, undefined, requirement.kind)
    if (spec === undefined) {
      this.refuseHostAccess(target.displayPath)
      return undefined
    }
    return { spec, preset: requirement.preset }
  }

  /** Translate one path and its base directory onto the host, refusing a host-only call when the caller is container-bound. */
  private mapPath(path: string, cwd: string | undefined): { path: string; cwd: string | undefined } {
    const repository = this.repositoryFor(path, cwd, this.containerRequirement()?.kind)
    if (repository === undefined) {
      this.refuseHostAccess(path)
      return { path, cwd }
    }
    return {
      path: toHostPath(path, repository),
      cwd: cwd === undefined ? undefined : toHostPath(cwd, repository),
    }
  }

  /**
   * The repository whose container governs one path.
   * @param path - a host path, a container path, a sandbox path, or a relative path.
   * @param cwd - the directory relative paths resolve against; the row's configured one when absent.
   * @returns the governing specification, or undefined when the path belongs to no Dev Container repository.
   */
  private repositoryFor(
    path: string, cwd: string | undefined, kind: VariantKind | undefined,
  ): RepoContainerSpec | undefined {
    const base = cwd ?? this.config.cwd
    const options = { ...this.options, cwd: base }
    const registry = repoRegistry(this.ctx)
    const adopt = (spec: RepoContainerSpec): RepoContainerSpec => (kind === 'sbx' ? asSbxSpec(spec) : spec)
    if (!this.warmed) {
      // One walk of the configured directory, so a first call that already speaks
      // in container paths can still be attributed to its repository.
      this.warmed = true
      registry.discover(this.config.cwd, { ...this.options, cwd: this.config.cwd })
    }
    const governing = registry.locate(path, options)
    if (governing !== undefined) return adopt(governing)
    // A container-side base resolves to no host ancestry of its own, so the row's
    // configured cwd is the second chance at naming the repository it belongs to.
    // That chance is conditional: a host path somewhere else on the machine must
    // not inherit this repository's container.
    //
    // Ownership is judged in the spelling the call will run under: a `(sbx)`
    // session names the path its sandbox mounts the repository at, which is not
    // the host spelling the declaration carries, so the specification is adopted
    // first and only then asked whether the path is inside it.
    const fallback = registry.locate(base, { ...this.options, cwd: this.config.cwd })
    if (fallback !== undefined) {
      const adopted = adopt(fallback)
      if (this.belongsTo(path, base, adopted)) return adopted
    }
    if (kind !== 'sbx') return undefined
    // A Docker Sandbox needs no declaration, but the path such a session names is
    // not a host path: it is the workspace's sandbox spelling, which has no host
    // ancestry to walk and, on a host serving several workspaces, no way to reach
    // the configured directory either.
    const attributed = this.specForSandboxPath(path, adopt)
    if (attributed !== undefined) return attributed
    const root = sbxWorkspaceRootFor(path, base, undefined)
    return root === undefined
      ? undefined
      : sbxSpecFor(root, { ...this.options, sbxTemplate: liveSandboxTemplate(this.ctx) }, undefined)
  }

  /**
   * The specification a sandbox-spelled path names, reversed onto the host.
   *
   * A path a sandbox mounts is attributed from the mount itself: the host
   * directory it reported, and the workspace root that directory names — enough
   * even for a workspace that declares no container, which is exactly what a
   * `(sbx)` session mounts. The drive convention names no workspace root, only the
   * spelling this host gives such a path, so it decides only when a repository
   * declares a container above the directory it spells: `/f/…` cannot claim
   * whatever host path it happens to name, and a sandbox path outside every mount
   * stays refused locally.
   * @param path - the path the call named.
   * @param adopt - the calling track's view of a declared specification.
   * @returns the governing specification, or undefined when nothing attributes the path.
   */
  private specForSandboxPath(
    path: string, adopt: (spec: RepoContainerSpec) => RepoContainerSpec,
  ): RepoContainerSpec | undefined {
    const attributed = sandboxHostPathFor(path)
    if (attributed === undefined) return undefined
    const declared = repoRegistry(this.ctx).locate(attributed.host, { ...this.options, cwd: attributed.host })
    if (declared !== undefined) return adopt(declared)
    if (attributed.workspaceRoot === undefined) return undefined
    return sbxSpecFor(
      attributed.workspaceRoot,
      { ...this.options, sbxTemplate: liveSandboxTemplate(this.ctx) },
      undefined,
    )
  }

  /**
   * Whether the fallback repository may claim one path.
   *
   * A container path of that repository, a host path under its root, or a
   * relative path that resolves — against the same base the fallback names —
   * to somewhere inside it. Anything else is a host path the repository does
   * not own: `..` traversal and absolute paths elsewhere on the machine
   * included.
   * @param path - the path the call named.
   * @param base - the directory relative paths resolve against.
   * @param spec - the fallback repository specification.
   * @returns true when that repository owns the path.
   */
  private belongsTo(path: string, base: string, spec: RepoContainerSpec): boolean {
    if (isPathInsideContainer(path, spec)) return true
    if (relativeWithinHostRoot(path, spec.hostWorkspaceRoot) !== undefined) return true
    if (isWindowsPath(path) || isPosixAbsolute(path)) return false
    // A relative path resolves against a host directory: the bind mount when the
    // base is container-side, the base itself otherwise.
    const hostBase = toHostPath(base, spec)
    if (!isWindowsPath(hostBase) && !isPosixAbsolute(hostBase)) return true
    return relativeWithinHostRoot(joinHostRoot(hostBase, path), spec.hostWorkspaceRoot) !== undefined
  }

  /**
   * Learn where the sandbox really mounts this workspace, before a path is
   * attributed to it.
   *
   * A `(sbx)` session names paths in its sandbox's spelling, while a
   * specification built from a host directory carries the host spelling until a
   * listing reports the mount. Routing therefore asks the runtime once — the same
   * probe the first call would run anyway — so `/f/personal/repo` is measured
   * against the folder the sandbox reports instead of the drive path the host
   * named. A probe that fails is not reported here: the call that needs the
   * container reports it with the runtime's own diagnostic.
   * @param kind - the runtime the calling preset selects, when one does.
   * @param base - the directory this call resolves relative paths against.
   */
  private async prepareSbxMount(kind: VariantKind | undefined, base: string): Promise<void> {
    if (kind !== 'sbx' || this.sbxProbed) return
    this.sbxProbed = true
    const registry = repoRegistry(this.ctx)
    const declared = registry.locate(base, { ...this.options, cwd: this.config.cwd })
    const root = declared?.hostWorkspaceRoot ?? base
    if (root === '') return
    const spec = sbxSpecFor(root, { ...this.options, sbxTemplate: liveSandboxTemplate(this.ctx) }, declared)
    await this.runtimeTarget(spec).catch(() => {})
  }

  /**
   * The container requirement governing this call.
   *
   * A `(devContainer)` preset promises container execution, so its filesystem
   * calls must not reach the host either; `requireContainer` asks for the same
   * guarantee from every preset. Both are read per call, so switching presets
   * mid-session needs no reload.
   * @returns the requirement and the preset that states it, or undefined when this call may use the host.
   */
  private containerRequirement(): { preset: string | undefined, kind: VariantKind | undefined } | undefined {
    const preset = callingContainerPreset(this.ctx)
    if (preset !== undefined) return { preset, kind: presetKindOf(preset) }
    return this.options.requireContainer ? { preset: undefined, kind: undefined } : undefined
  }

  /**
   * Refuse a call that would leave the container's repository.
   * @param path - the path the call names, for the diagnostic.
   * @param resolved - the resolved path the helper would use for I/O, when it differs from `path`.
   * @throws FsError `FS_PERMISSION_DENIED` when nothing in that path's ancestry declares a container.
   */
  private refuseHostAccess(path: string, resolved?: string): void {
    const requirement = this.containerRequirement()
    if (requirement === undefined) return
    const text = resolved === undefined
      ? fsRefusalText(path, requirement.preset)
      : fsEscapeRefusalText(path, resolved, requirement.preset)
    throw new FsError(text, 'FS_PERMISSION_DENIED')
  }

  /**
   * Fence one already-resolved target for a host call.
   *
   * A target can outlive the state it was resolved under — a preset switched
   * between the read and the write, a declaration deleted mid-session — so the
   * requirement is re-read here rather than trusted from the ingress check. Both
   * spellings a target carries are fenced, because they answer different
   * questions: `displayPath` is the path the caller named, while `targetKey` is
   * the realpath the backend actually opens.
   * @param target - the target the operation would use.
   * @returns the same target, so callers fence in place.
   * @throws FsError `FS_PERMISSION_DENIED` when the caller is container-bound and either spelling belongs to no container repository.
   */
  private fenced(target: FsTarget): FsTarget {
    // Reading the requirement first is what keeps an ordinary session cheap: it
    // is an in-memory lookup, while each `repositoryFor` below may walk the
    // target's ancestors, and neither check can refuse anything when the
    // requirement is absent.
    const requirement = this.containerRequirement()
    if (requirement === undefined) return target
    if (this.repositoryFor(target.displayPath, undefined, requirement.kind) === undefined) {
      this.refuseHostAccess(target.displayPath)
      return target
    }
    const resolved = String(target.targetKey)
    if (this.repositoryFor(resolved, undefined, requirement.kind) === undefined) {
      this.refuseHostAccess(target.displayPath, resolved)
    }
    return target
  }
}

export default DevcontainerFileSystem
