import { describe, expect, it } from 'vitest'
import {
  CONTAINER_FOLDER_LABEL,
  findRunningContainer,
  parseUpOutput,
  resolveContainerTarget,
  startContainer,
} from '../src/container.ts'
import type { ContainerCommandResult } from '../src/exec.ts'
import { sandboxNameFor } from '../src/sbx.ts'
import { fakeRunner } from './support.ts'
import type { RepoContainerSpec } from '../src/types.ts'

const spec: RepoContainerSpec = {
  hostWorkspaceRoot: 'F:\\personal\\my-repo',
  containerWorkspaceFolder: '/workspaces/my-repo',
  configPath: 'F:\\personal\\my-repo\\.devcontainer\\devcontainer.json',
  shell: '/bin/bash',
  cli: 'auto',
  ensureUp: true,
  containerTimeoutMs: 1000,
}

function psOutput(...lines: string[]): Omit<ContainerCommandResult, 'exitCode'> {
  return { stdout: lines.join('\n'), stderr: '' }
}

describe('findRunningContainer', () => {
  it('matches the labelled folder regardless of case and separators', async () => {
    const ran = fakeRunner({
      docker: psOutput('other\tC:\\elsewhere\\repo', 'abc123\tf:/personal/MY-REPO'),
    })
    expect(await findRunningContainer(spec, ran.run)).toBe('abc123')
    expect(ran.calls[0]?.argv).toEqual([
      'docker', 'ps', '--filter', `label=${CONTAINER_FOLDER_LABEL}`, '--format',
      '{{.ID}}\t{{.Label "devcontainer.local_folder"}}',
    ])
  })

  it('ignores malformed lines and unrelated repositories', async () => {
    const ran = fakeRunner({ docker: psOutput('abc123', '\tF:\\personal\\my-repo', 'abc999\tC:\\other') })
    expect(await findRunningContainer(spec, ran.run)).toBeUndefined()
  })

  it('reports no container when Docker is unavailable', async () => {
    const ran = fakeRunner({ docker: { stdout: '', stderr: 'docker: not found', exitCode: null } })
    expect(await findRunningContainer(spec, ran.run)).toBeUndefined()
  })
})

describe('parseUpOutput', () => {
  it('reads the last JSON envelope', () => {
    expect(parseUpOutput([
      '[+] Building 1.2s',
      '{"outcome":"success","containerId":"first"}',
      '{"outcome":"success","containerId":"second"}',
    ].join('\n'))).toBe('second')
  })

  it('ignores non-JSON progress lines and envelopes without an id', () => {
    expect(parseUpOutput('downloading base image')).toBeUndefined()
    expect(parseUpOutput('{"outcome":"success"}')).toBeUndefined()
    expect(parseUpOutput('{"broken')).toBeUndefined()
  })
})

describe('startContainer', () => {
  it('returns the container id the CLI produced', async () => {
    const ran = fakeRunner({ devcontainer: { stdout: '{"outcome":"success","containerId":"abc123"}', stderr: '' } })
    const started = await startContainer(spec, ran.run)
    expect(started.containerId).toBe('abc123')
    expect(ran.calls[0]?.argv).toEqual(['devcontainer', 'up', '--workspace-folder', spec.hostWorkspaceRoot])
  })

  it('reports the last lines of a failed start', async () => {
    const ran = fakeRunner({ devcontainer: { stdout: '', stderr: 'line one\nline two\nboom: no daemon', exitCode: 1 } })
    await expect(startContainer(spec, ran.run)).rejects.toThrow(/devcontainer up failed.*boom: no daemon/)
  })

  it('accepts a non-zero exit that still reported a container', async () => {
    const ran = fakeRunner({ devcontainer: { stdout: '{"containerId":"abc"}', stderr: 'warning', exitCode: 1 } })
    await expect(startContainer(spec, ran.run)).resolves.toEqual({
      containerId: 'abc',
      workspaceFolder: spec.hostWorkspaceRoot,
    })
  })
})

describe('resolveContainerTarget', () => {
  it('prefers an explicit container', async () => {
    const ran = fakeRunner()
    await expect(resolveContainerTarget({ ...spec, container: 'acme-dev' }, ran.run)).resolves.toEqual({
      kind: 'docker',
      containerId: 'acme-dev',
      workspaceFolder: spec.containerWorkspaceFolder,
    })
    expect(ran.calls).toHaveLength(0)
  })

  it('reuses the running container on the auto path', async () => {
    const ran = fakeRunner({ docker: psOutput('abc123\tf:\\personal\\my-repo') })
    await expect(resolveContainerTarget(spec, ran.run)).resolves.toEqual({ kind: 'docker', containerId: 'abc123', workspaceFolder: spec.containerWorkspaceFolder })
    expect(ran.calls.map(call => call.argv[0])).toEqual(['docker'])
  })

  it('builds the container when nothing is running', async () => {
    const ran = fakeRunner({
      docker: psOutput(),
      devcontainer: { stdout: '{"containerId":"built"}', stderr: '' },
    })
    await expect(resolveContainerTarget(spec, ran.run)).resolves.toEqual({ kind: 'docker', containerId: 'built', workspaceFolder: spec.containerWorkspaceFolder })
    expect(ran.calls.map(call => call.argv[0])).toEqual(['docker', 'devcontainer'])
  })

  it('refuses when the configuration demands an already-running container', async () => {
    const ran = fakeRunner({ docker: psOutput() })
    await expect(resolveContainerTarget({ ...spec, cli: 'docker' }, ran.run))
      .rejects.toThrow(/cli is "docker" but no running container/)
  })

  it('falls back to the CLI target when starting is disabled', async () => {
    const ran = fakeRunner({ devcontainer: { stdout: '{"outcome":"success"}', stderr: '' } })
    await expect(resolveContainerTarget({ ...spec, cli: 'devcontainer', ensureUp: false }, ran.run))
      .resolves.toEqual({ kind: 'devcontainer-cli', workspaceFolder: spec.hostWorkspaceRoot })
  })

  it('falls back to the CLI target when the build reports no container id', async () => {
    const ran = fakeRunner({ devcontainer: { stdout: '{"outcome":"success"}', stderr: '' } })
    await expect(resolveContainerTarget(spec, ran.run))
      .resolves.toEqual({ kind: 'devcontainer-cli', workspaceFolder: spec.hostWorkspaceRoot })
  })
})

describe('resolveContainerTarget for a Docker Sandbox', () => {
  const sandboxSpec: RepoContainerSpec = { ...spec, cli: 'sbx' }
  const name = sandboxNameFor(spec.hostWorkspaceRoot)
  const sandboxTarget = { kind: 'sbx', sandboxName: name, workspaceFolder: spec.containerWorkspaceFolder }

  it('uses a sandbox the listing reports as running, after checking it has node', async () => {
    const ran = fakeRunner({ sbx: { stdout: JSON.stringify([{ name, status: 'running' }]), stderr: '' } })
    await expect(resolveContainerTarget(sandboxSpec, ran.run)).resolves.toEqual(sandboxTarget)
    expect(ran.calls.map(call => call.argv.join(' '))).toEqual([
      'sbx ls --json',
      `sbx exec ${name} -- which node`,
    ])
  })

  it('creates a missing sandbox and starts it detached', async () => {
    const ran = fakeRunner({ sbx: { stdout: '[]', stderr: '' } })
    await expect(resolveContainerTarget(sandboxSpec, ran.run)).resolves.toEqual(sandboxTarget)
    expect(ran.calls.map(call => call.argv)).toEqual([
      ['sbx', 'ls', '--json'],
      ['sbx', 'create', '--name', name, 'shell', spec.hostWorkspaceRoot],
      ['sbx', 'run', '--detach', '--name', name],
      ['sbx', 'exec', name, '--', 'which', 'node'],
    ])
  })

  it('starts a sandbox that exists but is not running, without recreating it', async () => {
    const ran = fakeRunner({ sbx: { stdout: JSON.stringify([{ name, status: 'stopped' }]), stderr: '' } })
    await expect(resolveContainerTarget(sandboxSpec, ran.run)).resolves.toEqual(sandboxTarget)
    expect(ran.calls.map(call => call.argv[1])).toEqual(['ls', 'run', 'exec'])
  })

  it('reports a missing CLI instead of pretending the sandbox is unavailable', async () => {
    const ran = fakeRunner({ sbx: { stdout: '', stderr: 'not found', exitCode: null } })
    await expect(resolveContainerTarget(sandboxSpec, ran.run))
      .rejects.toThrow(/^sbx: Install the Docker Sandbox CLI/)
    expect(ran.calls).toHaveLength(1)
  })

  it('reports the state instead of changing it when ensureUp is off', async () => {
    const absent = fakeRunner({ sbx: { stdout: '[]', stderr: '' } })
    await expect(resolveContainerTarget({ ...sandboxSpec, ensureUp: false }, absent.run))
      .rejects.toThrow(/^sbx: no Docker Sandbox named .* exists/)
    const stopped = fakeRunner({ sbx: { stdout: JSON.stringify([{ name, status: 'stopped' }]), stderr: '' } })
    await expect(resolveContainerTarget({ ...sandboxSpec, ensureUp: false }, stopped.run))
      .rejects.toThrow(/^sbx: Docker Sandbox .* is not running/)
  })

  it('reports the last lines of a failed creation', async () => {
    const ran = fakeRunner({
      sbx: { stdout: '', stderr: 'pull access denied\nimage unavailable', exitCode: 1 },
    })
    await expect(resolveContainerTarget(sandboxSpec, ran.run))
      .rejects.toThrow(/^sbx: "sbx create" failed .*image unavailable/)
  })
})
