import { win32 } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  containerRemainder,
  defaultContainerWorkspaceFolder,
  isPathInsideContainer,
  isWindowsPath,
  normalizeHostRoot,
  relativeWithinHostRoot,
  toContainerPath,
  toHostPath,
} from '../src/paths.ts'
import type { RepoContainerSpec } from '../src/types.ts'

const HOST_ROOT = 'F:\\personal\\my-repo'
const CONTAINER_FOLDER = '/workspaces/my-repo'

const windowsSpec: RepoContainerSpec = {
  hostWorkspaceRoot: HOST_ROOT,
  containerWorkspaceFolder: CONTAINER_FOLDER,
  configPath: win32.join(HOST_ROOT, '.devcontainer', 'devcontainer.json'),
  shell: '/bin/bash',
  cli: 'auto',
  ensureUp: true,
  containerTimeoutMs: 1000,
}

const posixSpec: RepoContainerSpec = {
  hostWorkspaceRoot: '/home/me/my-repo',
  containerWorkspaceFolder: '/workspaces/my-repo',
  configPath: '/home/me/my-repo/.devcontainer/devcontainer.json',
  shell: '/bin/bash',
  cli: 'auto',
  ensureUp: true,
  containerTimeoutMs: 1000,
}

/** A Docker Sandbox mounts the host directory under its own absolute path. */
const sandboxSpec: RepoContainerSpec = {
  ...windowsSpec,
  containerWorkspaceFolder: HOST_ROOT,
  configPath: '',
  cli: 'sbx',
}

describe('a sandbox mount', () => {
  it('keeps the host spelling of the mount and everything under it', () => {
    expect(toContainerPath(HOST_ROOT, sandboxSpec)).toBe(HOST_ROOT)
    expect(toContainerPath(win32.join(HOST_ROOT, 'src'), sandboxSpec)).toBe(win32.join(HOST_ROOT, 'src'))
    expect(toContainerPath('F:/personal/my-repo/src', sandboxSpec)).toBe(win32.join(HOST_ROOT, 'src'))
  })

  it('resolves a relative path against the mount without mixing separators', () => {
    expect(toContainerPath('src/index.ts', sandboxSpec)).toBe(win32.join(HOST_ROOT, 'src', 'index.ts'))
  })

  it('maps back onto the same host directory', () => {
    expect(toHostPath(win32.join(HOST_ROOT, 'src'), sandboxSpec)).toBe(win32.join(HOST_ROOT, 'src'))
  })
})

describe('host path classification', () => {
  it('recognizes Windows drive and UNC paths', () => {
    expect(isWindowsPath('F:\\x')).toBe(true)
    expect(isWindowsPath('f:/x')).toBe(true)
    expect(isWindowsPath('\\\\server\\share')).toBe(true)
    expect(isWindowsPath('/workspaces/x')).toBe(false)
  })

  it('derives the default mount point from the repository directory name', () => {
    expect(defaultContainerWorkspaceFolder('F:\\personal\\my-repo')).toBe('/workspaces/my-repo')
    expect(defaultContainerWorkspaceFolder('/home/me/my-repo/')).toBe('/workspaces/my-repo')
  })

  it('normalizes a host root into its native spelling', () => {
    expect(normalizeHostRoot('F:/personal/my-repo/')).toBe(win32.join('F:\\personal', 'my-repo'))
  })
})

describe('containerRemainder', () => {
  it('matches the mount point and everything beneath it', () => {
    expect(containerRemainder('/workspaces/my-repo', CONTAINER_FOLDER)).toBe('')
    expect(containerRemainder('/workspaces/my-repo/src/a.ts', CONTAINER_FOLDER)).toBe('src/a.ts')
    expect(containerRemainder('/workspaces/my-repo/', '/workspaces/my-repo')).toBe('')
    expect(containerRemainder('/workspaces/my-repo-other/a.ts', CONTAINER_FOLDER)).toBeUndefined()
  })
})

describe('relativeWithinHostRoot', () => {
  it('folds case and separators for a Windows root', () => {
    expect(relativeWithinHostRoot('F:\\personal\\my-repo\\src\\a.ts', HOST_ROOT)).toBe('src/a.ts')
    expect(relativeWithinHostRoot('f:/PERSONAL/my-repo/src/a.ts', HOST_ROOT)).toBe('src/a.ts')
    expect(relativeWithinHostRoot(HOST_ROOT, HOST_ROOT)).toBe('')
    expect(relativeWithinHostRoot('F:\\personal\\other\\a.ts', HOST_ROOT)).toBeUndefined()
  })

  it('keeps POSIX comparisons case-sensitive', () => {
    expect(relativeWithinHostRoot('/home/me/my-repo/src/a.ts', '/home/me/my-repo')).toBe('src/a.ts')
    expect(relativeWithinHostRoot('/home/me/My-Repo/src/a.ts', '/home/me/my-repo')).toBeUndefined()
  })
})

describe('toContainerPath', () => {
  it('maps native host paths under the repository root', () => {
    expect(toContainerPath(win32.join(HOST_ROOT, 'src', 'index.ts'), windowsSpec)).toBe('/workspaces/my-repo/src/index.ts')
    expect(toContainerPath(HOST_ROOT, windowsSpec)).toBe(CONTAINER_FOLDER)
  })

  it('maps forward-slash and mixed-separator host paths', () => {
    expect(toContainerPath('F:/personal/my-repo/src/index.ts', windowsSpec)).toBe('/workspaces/my-repo/src/index.ts')
    expect(toContainerPath('F:\\personal\\my-repo\\src/utils', windowsSpec)).toBe('/workspaces/my-repo/src/utils')
  })

  it('folds drive-letter case', () => {
    expect(toContainerPath('f:\\PERSONAL\\my-repo\\src\\a.ts', windowsSpec)).toBe('/workspaces/my-repo/src/a.ts')
  })

  it('leaves container paths untouched', () => {
    expect(toContainerPath('/workspaces/my-repo/src/utils', windowsSpec)).toBe('/workspaces/my-repo/src/utils')
    expect(toContainerPath(CONTAINER_FOLDER, windowsSpec)).toBe(CONTAINER_FOLDER)
  })

  it('recovers a drive-mangled container path', () => {
    expect(toContainerPath('F:\\workspaces\\my-repo\\src\\a.ts', windowsSpec)).toBe('/workspaces/my-repo/src/a.ts')
  })

  it('resolves relative paths against the mount point', () => {
    expect(toContainerPath('src/utils', windowsSpec)).toBe('/workspaces/my-repo/src/utils')
    expect(toContainerPath('', windowsSpec)).toBe(CONTAINER_FOLDER)
  })

  it('returns a host path outside the repository slash-normalized', () => {
    expect(toContainerPath('C:\\other\\a.ts', windowsSpec)).toBe('C:/other/a.ts')
  })

  it('maps a POSIX host repository', () => {
    expect(toContainerPath('/home/me/my-repo/src/a.ts', posixSpec)).toBe('/workspaces/my-repo/src/a.ts')
    expect(toContainerPath('/home/me/elsewhere/a.ts', posixSpec)).toBe('/home/me/elsewhere/a.ts')
  })
})

describe('toHostPath', () => {
  it('maps container paths onto the host bind mount', () => {
    expect(toHostPath('/workspaces/my-repo/src/index.ts', windowsSpec))
      .toBe(win32.join(HOST_ROOT, 'src', 'index.ts'))
    expect(toHostPath(CONTAINER_FOLDER, windowsSpec)).toBe(win32.join(HOST_ROOT))
  })

  it('maps drive-mangled container paths onto the host', () => {
    expect(toHostPath('F:\\workspaces\\my-repo\\src\\index.ts', windowsSpec))
      .toBe(win32.join(HOST_ROOT, 'src', 'index.ts'))
    expect(toHostPath('f:/workspaces/my-repo/src/index.ts', windowsSpec))
      .toBe(win32.join(HOST_ROOT, 'src', 'index.ts'))
  })

  it('leaves relative, host, and foreign paths untouched', () => {
    expect(toHostPath('src/index.ts', windowsSpec)).toBe('src/index.ts')
    expect(toHostPath(win32.join(HOST_ROOT, 'src', 'index.ts'), windowsSpec))
      .toBe(win32.join(HOST_ROOT, 'src', 'index.ts'))
    expect(toHostPath('/workspaces/other-repo/a.ts', windowsSpec)).toBe('/workspaces/other-repo/a.ts')
    expect(toHostPath('C:\\elsewhere\\a.ts', windowsSpec)).toBe('C:\\elsewhere\\a.ts')
  })

  it('maps onto a POSIX host', () => {
    expect(toHostPath('/workspaces/my-repo/src/a.ts', posixSpec)).toBe('/home/me/my-repo/src/a.ts')
  })
})

describe('isPathInsideContainer', () => {
  it('accepts the mount point and its descendants only', () => {
    expect(isPathInsideContainer('/workspaces/my-repo/a.ts', windowsSpec)).toBe(true)
    expect(isPathInsideContainer('F:\\workspaces\\my-repo\\a.ts', windowsSpec)).toBe(true)
    expect(isPathInsideContainer('/workspaces/other/a.ts', windowsSpec)).toBe(false)
    expect(isPathInsideContainer(win32.join(HOST_ROOT, 'a.ts'), windowsSpec)).toBe(false)
  })
})
describe('relative traversal', () => {
  it('normalizes a relative path that stays inside the mount', () => {
    expect(toContainerPath('src/../lib/a.ts', windowsSpec)).toBe('/workspaces/my-repo/lib/a.ts')
    expect(toContainerPath('./src/a.ts', windowsSpec)).toBe('/workspaces/my-repo/src/a.ts')
  })

  it('returns a relative path that climbs out of the mount unchanged', () => {
    expect(toContainerPath('../../etc/passwd', windowsSpec)).toBe('../../etc/passwd')
  })

  it('normalizes a container path that walks through the mount', () => {
    expect(toContainerPath('/workspaces/my-repo/src/../lib/a.ts', windowsSpec)).toBe('/workspaces/my-repo/lib/a.ts')
    expect(toHostPath('/workspaces/my-repo/src/../lib/a.ts', windowsSpec)).toBe(win32.join(HOST_ROOT, 'lib', 'a.ts'))
  })

  it('does not map a container path that escapes the mount', () => {
    expect(toHostPath('/workspaces/my-repo/../../etc/passwd', windowsSpec)).toBe('/workspaces/my-repo/../../etc/passwd')
  })
})
describe('a mount reported beside the workspace', () => {
  const mounts = [{ host: 'C:\\Users\\me\\.dsh\\AGENTS.md', sandbox: '/d/agents.md' }]

  it('translates the host spelling into the path the mount has', () => {
    expect(toContainerPath('C:\\Users\\me\\.dsh\\AGENTS.md', sandboxSpec, mounts)).toBe('/d/agents.md')
    expect(toContainerPath('c:/users/me/.dsh/AGENTS.md', sandboxSpec, mounts)).toBe('/d/agents.md')
  })

  it('translates what the mount holds, and only that', () => {
    expect(toContainerPath('C:\\Users\\me\\.dsh\\other.md', sandboxSpec, mounts))
      .toBe('C:/Users/me/.dsh/other.md')
    expect(toContainerPath('src/a.ts', sandboxSpec, mounts)).toBe(win32.join(HOST_ROOT, 'src', 'a.ts'))
  })

  it('maps the sandbox spelling of the mount back onto its host path', () => {
    expect(toHostPath('/d/agents.md', sandboxSpec, mounts)).toBe('C:\\Users\\me\\.dsh\\AGENTS.md')
    expect(toHostPath('/workspaces/elsewhere', sandboxSpec, mounts)).toBe('/workspaces/elsewhere')
  })

  it('answers the declared host spelling however the sandbox path is cased', () => {
    // The sandbox spells a Windows drive in lowercase and stays case-sensitive
    // beyond it, so the fold belongs to the comparison: the answer is the mount's
    // own spelling, never the one the caller typed.
    const declared = [{ host: 'D:\\Users\\me\\.dsh\\AGENTS.md', sandbox: '/d/users/me/.dsh/agents.md' }]
    expect(toHostPath('/d/users/me/.dsh/agents.md', sandboxSpec, declared)).toBe('D:\\Users\\me\\.dsh\\AGENTS.md')
    expect(toHostPath('/D/Users/Me/.dsh/AGENTS.md', sandboxSpec, declared)).toBe('D:\\Users\\me\\.dsh\\AGENTS.md')
    expect(toHostPath('/d/users/me/.dsh/other.md', sandboxSpec, declared)).toBe('/d/users/me/.dsh/other.md')
  })

  it('answers the same mount however the host path inside it is spelled', () => {
    // A Windows host folds case on its own side of the translation, so the same
    // file written three ways lands on the one sandbox path, and the reverse
    // direction always answers the spelling the mount was declared with.
    for (const spelling of [
      'C:\\Users\\me\\.dsh\\AGENTS.md',
      'c:\\users\\me\\.dsh\\agents.md',
      'C:/Users/me/.dsh/AGENTS.md',
    ]) {
      const mounted = toContainerPath(spelling, sandboxSpec, mounts)
      expect(mounted).toBe('/d/agents.md')
      expect(toHostPath(mounted, sandboxSpec, mounts)).toBe('C:\\Users\\me\\.dsh\\AGENTS.md')
    }
  })
})
