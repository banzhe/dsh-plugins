import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import {
  containerMountArgsOf,
  containerPathOf,
  devcontainerMountsOf,
  hostMountReadAllowed,
} from '../src/container-mounts.ts'
import { hostMountPlan } from '../src/host-mounts.ts'
import { sbxSpecFor } from '../src/sbx.ts'
import type { HostMountsConfig, RepoContainerSpec } from '../src/types.ts'
import { DEFAULT_OPTIONS, cleanupTemporaryDirectories, temporaryDirectory } from './support.ts'

afterAll(cleanupTemporaryDirectories)

/** The two user roots the default set is read from, standing in for this host's own. */
const HOMES = { dshHome: 'C:\\Users\\me\\.dsh', agentsHome: 'C:\\Users\\me\\.agents' }

/**
 * A Dev Container specification carrying one configured `hostMounts` value.
 * @param value - the Host row's value.
 * @returns the specification a `(devContainer)` session runs under.
 */
function containerSpec(value: HostMountsConfig): RepoContainerSpec {
  return {
    hostWorkspaceRoot: 'F:\\personal\\my-repo',
    containerWorkspaceFolder: '/workspaces/my-repo',
    configPath: 'F:\\personal\\my-repo\\.devcontainer\\devcontainer.json',
    shell: '/bin/bash',
    cli: 'auto',
    ensureUp: true,
    containerTimeoutMs: 5_000,
    hostMounts: hostMountPlan(value, HOMES),
  }
}

describe('the extra mounts a Dev Container carries', () => {
  it('is the same host plan a Docker Sandbox is created with', () => {
    const declared = ['D:\\data\\AGENTS.md:ro', 'E:\\team\\skills']
    const sandbox = sbxSpecFor('F:\\personal\\my-repo', { ...DEFAULT_OPTIONS, hostMounts: declared })
    const container = containerSpec(declared)

    // One plan, two runtime argv forms: the host paths and their order cannot drift.
    expect(container.hostMounts).toEqual(sandbox.hostMounts)
    expect(devcontainerMountsOf(container).map(mount => mount.host))
      .toEqual(sandbox.hostMounts?.map(mount => mount.host) ?? [])
  })

  it('places every default mount at the path the sandbox convention gives it', () => {
    expect(devcontainerMountsOf(containerSpec('auto'))).toEqual([
      { host: 'C:\\Users\\me\\.dsh\\AGENTS.md', sandbox: '/c/Users/me/.dsh/AGENTS.md' },
      { host: 'C:\\Users\\me\\.agents\\AGENTS.md', sandbox: '/c/Users/me/.agents/AGENTS.md' },
      { host: 'C:\\Users\\me\\.dsh\\skills', sandbox: '/c/Users/me/.dsh/skills' },
      { host: 'C:\\Users\\me\\.agents\\skills', sandbox: '/c/Users/me/.agents/skills' },
    ])
  })

  it('answers nothing for a Docker Sandbox specification', () => {
    expect(devcontainerMountsOf({ ...containerSpec('auto'), cli: 'sbx' })).toEqual([])
  })

  it('keeps a declared target, and drops a host path no convention can name', () => {
    expect(devcontainerMountsOf(containerSpec(['C:/a/b.md:/mnt/b.md:ro']))).toEqual([
      // A target is resolved against its own host root, so a drive path stays native.
      { host: 'C:\\a\\b.md', sandbox: '/mnt/b.md' },
    ])
    expect(containerPathOf('\\\\server\\share\\AGENTS.md')).toBeUndefined()
  })
})

describe('what a session may read out of a mounted skills tree', () => {
  const mounts = devcontainerMountsOf(containerSpec(['C:\\Users\\me\\.agents\\skills']))
  const root = '/c/Users/me/.agents/skills'

  it('admits the skill description and the references tree', () => {
    for (const path of [
      `${root}/demo/SKILL.md`,
      `${root}/demo/references/api.md`,
      `${root}/demo/references/deep/nested.md`,
    ]) {
      expect(hostMountReadAllowed(path, mounts)).toBe(true)
    }
  })

  it('refuses every other file, including a script the skill would run', () => {
    for (const path of [
      `${root}/demo/scripts/run.sh`,
      `${root}/demo/templates/blank.md`,
      `${root}/demo/notes.md`,
      `${root}/demo/SKILL.md.bak`,
      `${root}/demo`,
      `${root}/README.md`,
    ]) {
      expect(hostMountReadAllowed(path, mounts)).toBe(false)
    }
  })

  it('leaves the workspace and a mounted single file alone', () => {
    const withFile = devcontainerMountsOf(containerSpec('auto'))
    // The workspace has its own fence; a mounted file is readable as that file.
    expect(hostMountReadAllowed('/workspaces/my-repo/src/a.ts', withFile)).toBe(true)
    expect(hostMountReadAllowed('/c/Users/me/.dsh/AGENTS.md', withFile)).toBe(true)
  })
})

describe('the mount arguments a create carries', () => {
  it('passes an existing source as one bind mount', async () => {
    const home = temporaryDirectory()
    const agents = join(home, 'AGENTS.md')
    writeFileSync(agents, '# agents\n', 'utf8')
    const spec: RepoContainerSpec = { ...containerSpec('off'), hostMounts: [{ host: agents }] }

    expect(await containerMountArgsOf(spec)).toEqual([
      '--mount', `type=bind,source=${agents},target=${containerPathOf(agents)}`,
    ])
  })

  it('skips a source that is not there, and says so', async () => {
    const home = temporaryDirectory()
    const gone = join(home, 'missing.md')
    const warnings: string[] = []
    const spec: RepoContainerSpec = { ...containerSpec('off'), hostMounts: [{ host: gone }] }

    expect(await containerMountArgsOf(spec, message => { warnings.push(message) })).toEqual([])
    expect(warnings[0]).toContain(gone)
  })

  it('skips a path the argument format cannot carry', async () => {
    const home = temporaryDirectory()
    const awkward = join(home, 'a,b.md')
    writeFileSync(awkward, '# agents\n', 'utf8')
    const warnings: string[] = []
    const spec: RepoContainerSpec = { ...containerSpec('off'), hostMounts: [{ host: awkward }] }

    expect(await containerMountArgsOf(spec, message => { warnings.push(message) })).toEqual([])
    expect(warnings[0]).toContain('comma')
  })
})
