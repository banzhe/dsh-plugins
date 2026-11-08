import { describe, expect, it } from 'vitest'
import { containerCliEnv, runContainerCommand } from '../src/exec.ts'

describe('containerCliEnv', () => {
  it('keeps what a Docker CLI needs and drops the rest of the host environment', () => {
    expect(containerCliEnv({
      PATH: '/usr/local/bin:/usr/bin',
      HOME: '/home/dev',
      SYSTEMROOT: 'C:\\Windows',
      TEMP: 'C:\\Temp',
      LANG: 'C.UTF-8',
      DOCKER_HOST: 'tcp://docker:2375',
      XDG_CONFIG_HOME: '/home/dev/.config',
      AWS_CONFIG_FILE: '/home/dev/.aws/config',
      DEVCONTAINER_SESSION_FACT: 'host-only',
    })).toEqual({
      PATH: '/usr/local/bin:/usr/bin',
      HOME: '/home/dev',
      SYSTEMROOT: 'C:\\Windows',
      TEMP: 'C:\\Temp',
      LANG: 'C.UTF-8',
      DOCKER_HOST: 'tcp://docker:2375',
      XDG_CONFIG_HOME: '/home/dev/.config',
    })
  })

  it('drops a credential-shaped name even inside a family the CLI owns', () => {
    const env = containerCliEnv({
      PATH: '/usr/bin',
      DEEPSEEK_API_KEY: 'sk-live',
      GITHUB_TOKEN: 'ghp_x',
      DOCKER_PASSWORD: 'hunter2',
      DOCKER_HOST: 'unix:///var/run/docker.sock',
    })
    expect(Object.keys(env).sort()).toEqual(['DOCKER_HOST', 'PATH'])
  })

  it('matches names case-insensitively, as Windows does', () => {
    expect(containerCliEnv({ Path: '/usr/bin', SystemRoot: 'C:\\Windows', Home: '/home/dev' }))
      .toEqual({ Path: '/usr/bin', SystemRoot: 'C:\\Windows', Home: '/home/dev' })
  })

  it('returns an empty environment when the parent has nothing it needs', () => {
    expect(containerCliEnv({})).toEqual({})
  })
})

describe('runContainerCommand', () => {
  it('rejects a command with no program', async () => {
    await expect(runContainerCommand([])).rejects.toThrow('devcontainer: empty command')
  })

  it('starts the CLI with the scrubbed environment rather than the ambient one', async () => {
    process.env.DEVCONTAINER_TEST_HOST_ONLY = 'host-only'
    try {
      const script = [
        'const leaked = process.env.DEVCONTAINER_TEST_HOST_ONLY ?? "absent"',
        'const lookup = process.env.PATH === undefined ? "no-path" : "path"',
        'process.stdout.write(`${leaked}|${lookup}`)',
      ].join('; ')
      const result = await runContainerCommand([process.execPath, '-e', script])
      expect(result.stderr).toBe('')
      expect(result.exitCode).toBe(0)
      expect(result.stdout).toBe('absent|path')
    } finally {
      delete process.env.DEVCONTAINER_TEST_HOST_ONLY
    }
  })
})
