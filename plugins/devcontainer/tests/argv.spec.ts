import { describe, expect, it } from 'vitest'
import { buildExecArgv, containerEnv, BASE_CONTAINER_ENV } from '../src/argv.ts'
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

describe('containerEnv', () => {
  it('forwards base facts, remoteEnv, the caller env, and the managed snapshot, in that order', () => {
    const env = containerEnv(
      { ...spec, remoteEnv: { GREETING: 'from-config', SHARED: 'config' } },
      { SHARED: 'caller', TERM: 'xterm' },
      { DSH_WEB_URL: 'http://127.0.0.1:1/' },
    )
    expect(env).toEqual({
      ...BASE_CONTAINER_ENV,
      GREETING: 'from-config',
      SHARED: 'caller',
      TERM: 'xterm',
      DSH_WEB_URL: 'http://127.0.0.1:1/',
    })
  })

  it('never includes ambient host entries', () => {
    const env = containerEnv(spec)
    expect(env).toEqual(BASE_CONTAINER_ENV)
    expect(Object.keys(env)).not.toContain('PATH')
    expect(Object.keys(env)).not.toContain('SystemRoot')
  })
})

describe('buildExecArgv for a known container id', () => {
  it('assembles docker exec with workdir, user, and sorted env flags', () => {
    const argv = buildExecArgv({
      spec: { ...spec, remoteUser: 'node' },
      target: { kind: 'docker', containerId: 'abc123', workspaceFolder: '/workspaces/my-repo' },
      containerWorkdir: '/workspaces/my-repo/src',
      command: 'npm test',
      env: { BETA: '2', ALPHA: '1' },
    })
    expect(argv).toEqual([
      'docker', 'exec', '-i', '-w', '/workspaces/my-repo/src',
      '-u', 'node',
      '-e', 'ALPHA=1',
      '-e', 'BETA=2',
      'abc123',
      '/bin/bash', '-c', 'npm test',
    ])
  })

  it('omits the user flag when the configuration names none', () => {
    const argv = buildExecArgv({
      spec,
      target: { kind: 'docker', containerId: 'abc123', workspaceFolder: '/workspaces/my-repo' },
      containerWorkdir: '/workspaces/my-repo',
      command: 'ls',
      env: {},
    })
    expect(argv).not.toContain('-u')
    expect(argv.slice(0, 5)).toEqual(['docker', 'exec', '-i', '-w', '/workspaces/my-repo'])
  })
})

describe('buildExecArgv through the Dev Container CLI', () => {
  it('wraps the command so a subdirectory workdir applies', () => {
    const argv = buildExecArgv({
      spec: { ...spec, remoteUser: 'node' },
      target: { kind: 'devcontainer-cli', workspaceFolder: 'F:\\personal\\my-repo' },
      containerWorkdir: '/workspaces/my-repo/src',
      command: 'npm test',
      env: { TERM: 'dumb' },
    })
    expect(argv).toEqual([
      'devcontainer', 'exec', '--workspace-folder', 'F:\\personal\\my-repo',
      '--remote-user', 'node',
      '--remote-env', 'TERM=dumb',
      '--', '/bin/sh', '-c',
      "cd -- '/workspaces/my-repo/src' && exec '/bin/bash' -c 'npm test'",
    ])
  })

  it('escapes single quotes so the command survives the wrapper', () => {
    const argv = buildExecArgv({
      spec,
      target: { kind: 'devcontainer-cli', workspaceFolder: '/workspaces/my-repo' },
      containerWorkdir: '/workspaces/my-repo',
      command: "printf '%s' ok",
      env: {},
    })
    expect(argv.at(-1)).toBe("cd -- '/workspaces/my-repo' && exec '/bin/bash' -c 'printf '\\''%s'\\'' ok'")
  })
})
describe('containerEnv scheduling markers', () => {
  it('never forwards the host-side preset markers into the container', () => {
    const env = containerEnv(spec, {}, {
      DSH_DEVCONTAINER: '1',
      DSH_DEVCONTAINER_PRESET: 'standard-devcontainer',
      DSH_SESSION_ID: 's-1',
    })
    expect(Object.keys(env)).not.toContain('DSH_DEVCONTAINER')
    expect(Object.keys(env)).not.toContain('DSH_DEVCONTAINER_PRESET')
    expect(env.DSH_SESSION_ID).toBe('s-1')
  })
})

describe('a shell configured with fixed arguments', () => {
  const target = { kind: 'docker' as const, containerId: 'abc123', workspaceFolder: '/workspaces/my-repo' }

  it('passes them to docker exec as separate words', () => {
    const argv = buildExecArgv({
      spec: { ...spec, shell: '/bin/bash -l' },
      target,
      containerWorkdir: '/workspaces/my-repo',
      command: 'pwd',
      env: {},
    })
    expect(argv.slice(-4)).toEqual(['/bin/bash', '-l', '-c', 'pwd'])
  })

  it('quotes them inside the devcontainer wrapper', () => {
    const argv = buildExecArgv({
      spec: { ...spec, shell: '/bin/bash --noprofile' },
      target: { ...target, kind: 'devcontainer-cli' },
      containerWorkdir: '/workspaces/my-repo/src',
      command: 'pwd',
      env: {},
    })
    expect(argv.at(-1)).toContain("exec '/bin/bash' '--noprofile' -c 'pwd'")
  })
})

describe('buildExecArgv inside a Docker Sandbox', () => {
  const sandbox = { kind: 'sbx' as const, sandboxName: 'dsh-my-repo-1a2b3c4d', workspaceFolder: '/workspaces/my-repo' }

  it('runs the command through sbx exec, entering the workdir with a POSIX wrapper', () => {
    const argv = buildExecArgv({
      spec,
      target: sandbox,
      containerWorkdir: '/workspaces/my-repo/src',
      command: 'npm test',
      env: {},
    })
    expect(argv).toEqual([
      'sbx', 'exec', 'dsh-my-repo-1a2b3c4d', '--', '/bin/sh', '-c',
      "cd -- '/workspaces/my-repo/src' && exec '/bin/bash' -c 'npm test'",
    ])
  })

  it('forwards the environment through an env prefix instead of CLI flags', () => {
    const argv = buildExecArgv({
      spec,
      target: sandbox,
      containerWorkdir: '/workspaces/my-repo',
      command: 'pwd',
      env: { BETA: '2', ALPHA: '1' },
    })
    expect(argv.slice(0, 6)).toEqual(['sbx', 'exec', 'dsh-my-repo-1a2b3c4d', '--', '/bin/sh', '-c'])
    expect(argv.at(-1)).toBe("cd -- '/workspaces/my-repo' && exec env 'ALPHA=1' 'BETA=2' '/bin/bash' -c 'pwd'")
  })

  it('quotes a shell configured with fixed arguments', () => {
    const argv = buildExecArgv({
      spec: { ...spec, shell: '/bin/bash -l' },
      target: sandbox,
      containerWorkdir: '/workspaces/my-repo',
      command: 'pwd',
      env: {},
    })
    expect(argv.at(-1)).toBe("cd -- '/workspaces/my-repo' && exec '/bin/bash' '-l' -c 'pwd'")
  })
})

describe('the sandbox scheduling markers', () => {
  it('never forwards either pair into the sandbox', () => {
    const env = containerEnv(spec, {}, {
      DSH_SBX: '1',
      DSH_SBX_PRESET: 'standard-sbx',
      DSH_DEVCONTAINER: '1',
      DSH_DEVCONTAINER_PRESET: 'standard-devcontainer',
      DSH_SESSION_ID: 's-1',
    })
    expect(Object.keys(env).sort()).toEqual([...Object.keys(BASE_CONTAINER_ENV), 'DSH_SESSION_ID'].sort())
  })
})
