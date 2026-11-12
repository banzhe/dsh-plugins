import { describe, expect, it } from 'vitest'
import type { PromptPresentation } from '@deepseek-ai/dsh-system-prompt'
import {
  applyContainerContext,
  containerContextText,
  containerLabel,
  hostDirectoryFromContext,
  WORKING_DIRECTORY_CONTEXT,
} from '../src/prompt.ts'
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

function assembly(text = 'Current working directory: "F:\\\\personal\\\\my-repo".'): PromptPresentation {
  return {
    sections: [],
    contexts: [{ name: WORKING_DIRECTORY_CONTEXT, text, interpolate: false }],
    variables: {},
  }
}

describe('containerLabel', () => {
  it('names the container, its compose service, or the repository', () => {
    expect(containerLabel({ ...spec, container: 'acme-dev' })).toBe('acme-dev')
    expect(containerLabel({ ...spec, composeService: 'app' })).toBe('service app')
    expect(containerLabel(spec)).toBe('my-repo')
  })
})

describe('containerContextText', () => {
  it('states the Linux container runtime and the POSIX rule', () => {
    expect(containerContextText('/workspaces/my-repo/src', spec, spec.hostWorkspaceRoot)).toBe(
      'Current working directory: "/workspaces/my-repo/src".\n'
      + 'Runtime environment: Linux Docker container (my-repo) mounted from host directory "F:\\personal\\my-repo". '
      + 'The active shell is Linux bash (/bin/bash). Always write POSIX/Linux commands and never PowerShell commands.',
    )
  })
})

describe('applyContainerContext', () => {
  it('replaces the working-directory context the service contributed', () => {
    const target = assembly()
    expect(applyContainerContext(target, 'rewritten')).toBe(true)
    expect(target.contexts[0]).toEqual({ name: WORKING_DIRECTORY_CONTEXT, text: 'rewritten', interpolate: false })
  })

  it('adds the context when the assembly carries none', () => {
    const target: PromptPresentation = { sections: [], contexts: [], variables: {} }
    expect(applyContainerContext(target, 'rewritten')).toBe(true)
    expect(target.contexts).toHaveLength(1)
  })
})

describe('hostDirectoryFromContext', () => {
  it('reads the JSON-quoted directory back out', () => {
    expect(hostDirectoryFromContext(assembly())).toBe('F:\\personal\\my-repo')
  })

  it('returns undefined without the context or without a readable path', () => {
    expect(hostDirectoryFromContext({ sections: [], contexts: [], variables: {} })).toBeUndefined()
    expect(hostDirectoryFromContext(assembly('nothing useful here'))).toBeUndefined()
    expect(hostDirectoryFromContext(assembly('Current working directory: "unterminated.'))).toBeUndefined()
  })
})
