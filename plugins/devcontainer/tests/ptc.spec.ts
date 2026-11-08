import { afterAll, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { PtcRunRequest, PtcRunResult, PtcRunSpec } from '@deepseek-ai/dsh-ptc-runtime'
import { apply, Config } from '../src/index.ts'
import { joinHostRoot } from '../src/paths.ts'
import { installPtcCwdMapping, mapPtcCwd } from '../src/ptc.ts'
import type { PtcSeam } from '../src/ptc.ts'
import {
  cleanupTemporaryDirectories,
  CONTAINER_MOUNT,
  FakePtc,
  makeContainerRepo,
  repoSpec,
  temporaryDirectory,
} from './support.ts'

afterAll(cleanupTemporaryDirectories)

/** One program request, as the `run_code` tool writes it. */
function request(cwd?: string): PtcRunRequest {
  return { program: 'return 1', bindings: [], ...cwd === undefined ? {} : { cwd } }
}

/** One resolved spec, as a provider returns it. */
function resolvedSpec(cwd: string): PtcRunSpec {
  return { ...request(), cwd, timeoutMs: null }
}

/**
 * A seam stand-in that records both entry points without starting anything.
 * Its methods live on the prototype, as a Cordis service's do: undoing the
 * decoration has to bring them back, not leave the seam without a method.
 */
class RecordingSeam implements PtcSeam {
  readonly resolved: PtcRunRequest[] = []

  readonly ran: PtcRunSpec[] = []

  constructor(private readonly defaultCwd: string = CONTAINER_MOUNT) {}

  resolve(asked: PtcRunRequest): PtcRunSpec {
    this.resolved.push(asked)
    return { ...asked, cwd: asked.cwd ?? this.defaultCwd, timeoutMs: asked.timeoutMs ?? null }
  }

  run(spec: PtcRunSpec): Promise<PtcRunResult> {
    this.ran.push(spec)
    return Promise.resolve({ logs: [] })
  }
}

/**
 * Build one recording seam.
 * @param defaultCwd - the directory the provider substitutes when a request names none.
 * @returns the seam and its two recorded logs.
 */
function recordingSeam(defaultCwd: string = CONTAINER_MOUNT): {
  seam: RecordingSeam
  resolved: PtcRunRequest[]
  ran: PtcRunSpec[]
} {
  const seam = new RecordingSeam(defaultCwd)
  return { seam, resolved: seam.resolved, ran: seam.ran }
}

describe('mapPtcCwd', () => {
  it('translates the mount point and everything under it onto the host root', () => {
    const root = makeContainerRepo().root
    const repository = repoSpec(root)
    expect(mapPtcCwd(CONTAINER_MOUNT, repository)).toBe(root)
    expect(mapPtcCwd(`${CONTAINER_MOUNT}/src/main.ts`, repository)).toBe(joinHostRoot(root, 'src/main.ts'))
    // The spelling a Windows model produces after win32 resolved the leading
    // slash names the same directory.
    expect(mapPtcCwd(`${CONTAINER_MOUNT}\\src`, repository)).toBe(joinHostRoot(root, 'src'))
  })

  it('leaves a host path, a foreign container path, and a relative path alone', () => {
    const root = makeContainerRepo().root
    const repository = repoSpec(root)
    expect(mapPtcCwd(root, repository)).toBe(root)
    expect(mapPtcCwd('/workspaces/another-repository/src', repository)).toBe('/workspaces/another-repository/src')
    expect(mapPtcCwd('src', repository)).toBe('src')
  })

  it('leaves every path alone when no declaration owns it', () => {
    expect(mapPtcCwd(CONTAINER_MOUNT, undefined)).toBe(CONTAINER_MOUNT)
  })
})

describe('installPtcCwdMapping', () => {
  it('hands the provider the host directory in place of the container one', async () => {
    const root = makeContainerRepo().root
    const repository = repoSpec(root)
    const { seam, resolved, ran } = recordingSeam()
    installPtcCwdMapping(seam, () => repository)

    expect(seam.resolve(request(`${CONTAINER_MOUNT}/src`)).cwd).toBe(joinHostRoot(root, 'src'))
    expect(resolved[0]?.cwd).toBe(joinHostRoot(root, 'src'))
    await seam.run(resolvedSpec(`${CONTAINER_MOUNT}/src`))
    expect(ran[0]?.cwd).toBe(joinHostRoot(root, 'src'))
    // Only the directory moves: the rest of the request is the caller's.
    expect(ran[0]?.program).toBe('return 1')
    expect(ran[0]?.timeoutMs).toBeNull()
  })

  it('maps the directory a provider substitutes when the request names none', async () => {
    const root = makeContainerRepo().root
    const { seam, resolved } = recordingSeam()
    installPtcCwdMapping(seam, () => repoSpec(root))

    const spec = seam.resolve(request())
    expect(resolved[0]?.cwd).toBeUndefined()
    expect(spec.cwd).toBe(root)
  })

  it('passes an unmapped request and spec through as the caller wrote them', async () => {
    const root = makeContainerRepo().root
    const outside = temporaryDirectory()
    const { seam, resolved, ran } = recordingSeam()
    installPtcCwdMapping(seam, () => repoSpec(root))

    const untouched = request(outside)
    seam.resolve(untouched)
    expect(resolved[0]).toBe(untouched)
    const spec = resolvedSpec('/workspaces/another-repository/src')
    await seam.run(spec)
    expect(ran[0]).toBe(spec)
  })

  it('leaves a method another decoration installed after it in place', () => {
    const { seam } = recordingSeam()
    const dispose = installPtcCwdMapping(seam, () => undefined)
    const later = (): PtcRunSpec => resolvedSpec('/workspaces/demo')
    Object.defineProperty(seam, 'resolve', { configurable: true, writable: true, value: later })

    dispose()
    expect(Object.getOwnPropertyDescriptor(seam, 'resolve')?.value).toBe(later)
    expect(Object.hasOwn(seam, 'run')).toBe(false)
  })

  it('gives the provider its own methods back when the decoration unloads', async () => {
    const root = makeContainerRepo().root
    const { seam, ran } = recordingSeam()
    const dispose = installPtcCwdMapping(seam, () => repoSpec(root))
    expect(Object.hasOwn(seam, 'resolve')).toBe(true)

    dispose()
    expect(Object.hasOwn(seam, 'resolve')).toBe(false)
    expect(Object.hasOwn(seam, 'run')).toBe(false)
    expect(seam.resolve(request(CONTAINER_MOUNT)).cwd).toBe(CONTAINER_MOUNT)
    await seam.run(resolvedSpec(CONTAINER_MOUNT))
    expect(ran[0]?.cwd).toBe(CONTAINER_MOUNT)
  })
})

/** One composition with the host row mounted over a PTC provider. */
interface Mounted {
  readonly ctx: Context
  readonly ptc: FakePtc
}

/**
 * Mount the host row the way the Loader does.
 * @param project - the host directory the session started in, or undefined for a composition with no initiator.
 * @returns the context and the recording provider.
 */
async function mounted(project: string | undefined): Promise<Mounted> {
  const ctx = new Context()
  await ctx.plugin(FakePtc)
  if (project !== undefined) {
    ctx.provide('workingDirectory', { get: () => project })
    ctx.provide('agents', {
      currentInitiator: () => ({ session: { header: { cwd: project } } }),
    })
  }
  apply(ctx, Config({ presets: { win32Only: false } }))
  const ptc = ctx.ptcRuntime as FakePtc
  // `ctx.inject` resolves its callback on a later tick; an unpatched seam would
  // make every assertion below pass vacuously against a container path.
  await vi.waitFor(() => { expect(Object.hasOwn(ptc, 'resolve')).toBe(true) })
  return { ctx, ptc }
}

describe('a container-bound session\'s PTC working directory', () => {
  it('resolves the program directory onto the host repository root', async () => {
    const root = makeContainerRepo().root
    const { ptc } = await mounted(root)
    expect(ptc.resolve(request(`${CONTAINER_MOUNT}/src`)).cwd).toBe(joinHostRoot(root, 'src'))
    expect(ptc.resolve(request(CONTAINER_MOUNT)).cwd).toBe(root)
  })

  it('resolves the workspace root a request without a directory would inherit', async () => {
    const root = makeContainerRepo().root
    const { ptc } = await mounted(root)
    const spec = ptc.resolve(request())
    expect(ptc.requests[0]?.cwd).toBeUndefined()
    expect(spec.cwd).toBe(root)
  })

  it('runs the program in the host directory instead of the container mount', async () => {
    const root = makeContainerRepo().root
    const { ptc } = await mounted(root)
    await ptc.run(resolvedSpec(`${CONTAINER_MOUNT}/src`))
    expect(ptc.runs[0]?.cwd).toBe(joinHostRoot(root, 'src'))
    expect(ptc.runs[0]?.program).toBe('return 1')
  })

  it('leaves a run outside every container repository exactly as it was', async () => {
    const root = makeContainerRepo().root
    const outside = temporaryDirectory()
    const { ptc } = await mounted(root)
    await ptc.run(resolvedSpec(outside))
    await ptc.run(resolvedSpec('/workspaces/another-repository/src'))
    await ptc.run(resolvedSpec(`${CONTAINER_MOUNT}-not-this-one/src`))
    expect(ptc.runs.map(ran => ran.cwd)).toEqual([
      outside,
      '/workspaces/another-repository/src',
      `${CONTAINER_MOUNT}-not-this-one/src`,
    ])
  })

  it('gives the provider its own methods back when the row unloads', async () => {
    const root = makeContainerRepo().root
    const { ctx, ptc } = await mounted(root)
    await ctx.fiber.dispose()
    await expect.poll(() => Object.hasOwn(ptc, 'resolve')).toBe(false)
    expect(ptc.resolve(request(`${CONTAINER_MOUNT}/src`)).cwd).toBe(`${CONTAINER_MOUNT}/src`)
  })
})
