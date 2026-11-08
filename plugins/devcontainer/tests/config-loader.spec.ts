import { afterAll, describe, expect, it } from 'vitest'
import { mkdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  buildSpec,
  CONFIG_CANDIDATES,
  findConfigFile,
  RepoContainerRegistry,
} from '../src/config-loader.ts'
import type { ReadTextFile } from '../src/config-loader.ts'
import { cleanupTemporaryDirectories, makeRepo } from './support.ts'

afterAll(cleanupTemporaryDirectories)

describe('CONFIG_CANDIDATES', () => {
  it('probes the lightweight forms before the Dev Container specification', () => {
    expect(CONFIG_CANDIDATES.map(candidate => candidate.relativePath)).toEqual([
      '.dsh/devcontainer.json',
      '.dsh/docker.json',
      '.devcontainer/devcontainer.json',
      '.devcontainer.json',
    ])
  })
})

describe('findConfigFile', () => {
  it('walks up from a nested file to the repository declaration', () => {
    const root = makeRepo({
      '.devcontainer/devcontainer.json': '{ "image": "ubuntu" }',
      'src/deep/nested/file.ts': '',
    })
    const found = findConfigFile(join(root, 'src', 'deep', 'nested'))
    expect(found?.hostRoot).toBe(root)
    expect(found?.configPath).toBe(join(root, '.devcontainer', 'devcontainer.json'))
  })

  it('honours the documented priority inside one directory', () => {
    const root = makeRepo({
      '.devcontainer/devcontainer.json': '{ "image": "from-devcontainer-dir" }',
      '.dsh/docker.json': '{ "container": "already-running" }',
    })
    expect(findConfigFile(root)?.configPath).toBe(join(root, '.dsh', 'docker.json'))
  })

  it('finds the single-file variant', () => {
    const root = makeRepo({ '.devcontainer.json': '{ "image": "ubuntu" }' })
    expect(findConfigFile(root)?.configPath).toBe(join(root, '.devcontainer.json'))
  })

  it('returns undefined outside any Dev Container repository', () => {
    const root = makeRepo({ 'README.md': 'nothing here' })
    expect(findConfigFile(root)).toBeUndefined()
  })
})

describe('buildSpec', () => {
  it('applies the Dev Container defaults', () => {
    const spec = buildSpec({
      hostRoot: join('F:', 'personal', 'my-repo'),
      configPath: join('F:', 'personal', 'my-repo', '.devcontainer', 'devcontainer.json'),
      text: '{ "image": "ubuntu" }',
    })
    expect(spec.containerWorkspaceFolder).toBe('/workspaces/my-repo')
    expect(spec.shell).toBe('/bin/bash')
    expect(spec.cli).toBe('auto')
    expect(spec.ensureUp).toBe(true)
    expect(spec.container).toBeUndefined()
  })

  it('reads every supported field, including the lightweight aliases', () => {
    const spec = buildSpec({
      hostRoot: 'F:\\personal\\my-repo',
      configPath: 'F:\\personal\\my-repo\\.dsh\\docker.json',
      text: `{
  // an existing container wins over anything the CLI would build
  "containerName": "acme-dev",
  "service": "app",
  "remoteUser": "node",
  "remoteEnv": { "NODE_ENV": "test", "RETRIES": 3 },
  "shell": "/bin/sh",
  "cli": "docker",
  "ensureUp": false,
}`,
    })
    expect(spec.container).toBe('acme-dev')
    expect(spec.composeService).toBe('app')
    expect(spec.remoteUser).toBe('node')
    expect(spec.remoteEnv).toEqual({ NODE_ENV: 'test', RETRIES: '3' })
    expect(spec.shell).toBe('/bin/sh')
    expect(spec.cli).toBe('docker')
    expect(spec.ensureUp).toBe(false)
  })

  it('honours an explicit workspaceFolder and normalizes its trailing slash', () => {
    const spec = buildSpec({
      hostRoot: '/home/me/repo',
      configPath: '/home/me/repo/.devcontainer.json',
      text: '{ "workspaceFolder": "/app/", "container": "acme" }',
    })
    expect(spec.containerWorkspaceFolder).toBe('/app')
    expect(spec.container).toBe('acme')
  })

  it('rejects an unusable workspaceFolder', () => {
    expect(() => buildSpec({
      hostRoot: '/home/me/repo',
      configPath: '/home/me/repo/.devcontainer.json',
      text: '{ "workspaceFolder": "C:\\\\repo" }',
    })).toThrow(/workspaceFolder must be an absolute POSIX path/)
  })

  it('reports the file that cannot be parsed', () => {
    expect(() => buildSpec({
      hostRoot: '/home/me/repo',
      configPath: '/home/me/repo/.devcontainer.json',
      text: '{ "workspaceFolder": }',
    })).toThrow(/cannot parse \/home\/me\/repo\/\.devcontainer\.json/)
  })
})

describe('RepoContainerRegistry', () => {
  it('locates the specification governing a nested file', () => {
    const root = makeRepo({
      '.devcontainer/devcontainer.json': '{ "workspaceFolder": "/workspaces/demo" }',
      'src/a.ts': '',
    })
    const registry = new RepoContainerRegistry()
    const spec = registry.locate(join(root, 'src', 'a.ts'))
    expect(spec?.hostWorkspaceRoot).toBe(root)
    expect(spec?.containerWorkspaceFolder).toBe('/workspaces/demo')
  })

  it('memoizes both the ancestor walk and the parsed specification', () => {
    const root = makeRepo({ '.devcontainer/devcontainer.json': '{ "image": "ubuntu" }', 'src/a.ts': '' })
    const registry = new RepoContainerRegistry()
    const first = registry.locate(join(root, 'src', 'a.ts'))
    const second = registry.locate(join(root, 'src', 'a.ts'))
    expect(second).toBe(first)
    expect(registry.knownSpecs()).toHaveLength(1)
  })

  it('resolves a container path through the cwd repository', () => {
    const root = makeRepo({ '.devcontainer/devcontainer.json': '{ "workspaceFolder": "/workspaces/demo" }' })
    const registry = new RepoContainerRegistry()
    const spec = registry.locate('/workspaces/demo/src/a.ts', { cwd: root })
    expect(spec?.hostWorkspaceRoot).toBe(root)
  })

  it('keeps an unrelated absolute path on the host', () => {
    const root = makeRepo({ '.devcontainer/devcontainer.json': '{ "image": "ubuntu" }' })
    const registry = new RepoContainerRegistry()
    expect(registry.locate('C:\\other\\a.ts', { cwd: root })).toBeUndefined()
  })

  it('returns undefined when nothing declares a container', () => {
    const root = makeRepo({ 'a.txt': '' })
    expect(new RepoContainerRegistry().locate(root)).toBeUndefined()
    expect(new RepoContainerRegistry().locate(undefined)).toBeUndefined()
  })

  it('discovers through an injected reader instead of the filesystem', () => {
    const root = join('F:', 'injected-repo')
    const files = new Map<string, string>([
      [join(root, '.dsh', 'devcontainer.json'), '{ "container": "injected" }'],
    ])
    const read: ReadTextFile = path => files.get(path)
    const spec = new RepoContainerRegistry(read).locate(join(root, 'src', 'a.ts'))
    expect(spec?.container).toBe('injected')
    expect(spec?.hostWorkspaceRoot).toBe(root)
  })

  it('keeps one specification per option signature', () => {
    const root = makeRepo({ '.devcontainer/devcontainer.json': '{ "image": "ubuntu" }' })
    const registry = new RepoContainerRegistry()
    const automatic = registry.locate(root)
    const dockerOnly = registry.locate(root, { cli: 'docker' })
    expect(automatic?.cli).toBe('auto')
    expect(dockerOnly?.cli).toBe('docker')
    expect(registry.knownSpecs()).toHaveLength(2)
  })

  it('forgets everything on reset', () => {
    const root = makeRepo({ '.devcontainer/devcontainer.json': '{ "image": "ubuntu" }' })
    const registry = new RepoContainerRegistry()
    registry.locate(root)
    registry.reset()
    expect(registry.knownSpecs()).toHaveLength(0)
  })
})
describe('RepoContainerRegistry cache invalidation', () => {
  it('picks up a declaration that appears after a miss', () => {
    const root = makeRepo({ 'src/a.ts': '' })
    const registry = new RepoContainerRegistry()
    expect(registry.locate(join(root, 'src', 'a.ts'))).toBeUndefined()
    mkdirSync(join(root, '.dsh'), { recursive: true })
    writeFileSync(join(root, '.dsh', 'docker.json'), '{ "container": "late" }', 'utf8')
    expect(registry.locate(join(root, 'src', 'a.ts'))?.container).toBe('late')
  })

  it('re-reads an edited declaration', () => {
    const root = makeRepo({ '.devcontainer/devcontainer.json': '{ "workspaceFolder": "/workspaces/one" }' })
    const registry = new RepoContainerRegistry()
    expect(registry.locate(root)?.containerWorkspaceFolder).toBe('/workspaces/one')
    const configPath = join(root, '.devcontainer', 'devcontainer.json')
    writeFileSync(configPath, '{ "workspaceFolder": "/workspaces/two" }', 'utf8')
    utimesSync(configPath, new Date(), new Date(Date.now() + 5_000))
    expect(registry.locate(root)?.containerWorkspaceFolder).toBe('/workspaces/two')
  })

  it('forgets a declaration that was deleted', () => {
    const root = makeRepo({ '.devcontainer/devcontainer.json': '{ "image": "ubuntu" }' })
    const registry = new RepoContainerRegistry()
    expect(registry.locate(root)).toBeDefined()
    rmSync(join(root, '.devcontainer'), { recursive: true, force: true })
    expect(registry.locate(root)).toBeUndefined()
    expect(registry.knownSpecs()).toHaveLength(0)
  })

  it('stops trusting a cached container path once its file is gone', () => {
    const root = makeRepo({ '.devcontainer/devcontainer.json': '{ "workspaceFolder": "/workspaces/app" }' })
    const registry = new RepoContainerRegistry()
    expect(registry.locate('/workspaces/app/src/a.ts', { cwd: root })).toBeDefined()
    rmSync(join(root, '.devcontainer'), { recursive: true, force: true })
    expect(registry.locate('/workspaces/app/src/a.ts')).toBeUndefined()
  })

  it('answers a container path from the cwd repository, not from a same-named one', () => {
    const first = makeRepo({ '.devcontainer/devcontainer.json': '{ "workspaceFolder": "/workspaces/app" }' })
    const second = makeRepo({ '.devcontainer/devcontainer.json': '{ "workspaceFolder": "/workspaces/app" }' })
    const registry = new RepoContainerRegistry()
    // Warm the index with the FIRST repository, then ask from the second one.
    expect(registry.locate(join(first, 'src'), { cwd: first })?.hostWorkspaceRoot).toBe(first)
    expect(registry.locate('/workspaces/app/src/a.ts', { cwd: second })?.hostWorkspaceRoot).toBe(second)
  })

  it('resolves a container path on the very first call, with nothing discovered yet', () => {
    const root = makeRepo({ '.devcontainer/devcontainer.json': '{ "workspaceFolder": "/workspaces/cold" }' })
    const registry = new RepoContainerRegistry()
    expect(registry.knownSpecs()).toHaveLength(0)
    expect(registry.locate('/workspaces/cold/index.ts', { cwd: root })?.hostWorkspaceRoot).toBe(root)
  })

  it('bounds the container-path index', () => {
    const read: ReadTextFile = path => (path.endsWith('devcontainer.json') ? '{ "workspaceFolder": "/workspaces/x" }' : undefined)
    const registry = new RepoContainerRegistry(read)
    for (let index = 0; index < 80; index += 1) registry.locate(join('F:', `repo-${index}`, 'src'))
    expect(registry.knownSpecs().length).toBeLessThanOrEqual(64)
  })
})
