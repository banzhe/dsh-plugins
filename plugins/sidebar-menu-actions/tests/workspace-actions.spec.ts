// @vitest-environment jsdom
/**
 * `buildWorkspaceActions`' decision table: row order, which rows exist for a
 * host app catalog, the icon keys and labels, and that a row reads the
 * workspace path when it is clicked rather than when the menu is built.
 */
import { describe, expect, it, vi } from 'vitest'
import {
  CONTRIBUTION_ID,
  CONTRIBUTION_ORDER,
  buildWorkspaceActions,
  type WorkspaceMenuAction,
  type WorkspaceMenuDeps,
  type WorkspaceMenuId,
  type WorkspaceMenuTarget,
} from '../src/client/workspace-actions.ts'
import { translateEn } from './translate.ts'

const TARGET: WorkspaceMenuTarget = { workspaceId: 'w1' }

interface HarnessOptions {
  readonly apps?: readonly string[] | undefined
  readonly path?: string | undefined
}

function harness(options: HarnessOptions = {}) {
  let current = 'path' in options ? options.path : '/repo/one'
  const launch = vi.fn(async (_app: 'vscode' | 'explorer', _path: string) => {})
  const copy = vi.fn(async (_path: string) => {})
  const pathAt = vi.fn((_id: string) => current)
  const deps: WorkspaceMenuDeps = {
    t: translateEn,
    apps: new Set(options.apps ?? ['vscode', 'explorer']),
    pathAt,
    launch,
    copy,
  }
  return {
    deps,
    launch,
    copy,
    pathAt,
    setPath: (path: string | undefined) => { current = path },
  }
}

type Harness = ReturnType<typeof harness>

function ids(harnessed: Harness): string[] {
  return buildWorkspaceActions(TARGET, harnessed.deps).map(action => action.id)
}

function actionOf(actions: readonly WorkspaceMenuAction[], id: WorkspaceMenuId): WorkspaceMenuAction {
  const found = actions.find(action => action.id === id)
  if (found === undefined) throw new Error('no row ' + id + ' among ' + actions.map(action => action.id).join(', '))
  return found
}

describe('buildWorkspaceActions', () => {
  it('publishes the workspace contribution identity', () => {
    expect(CONTRIBUTION_ID).toBe('sidebar-menu-actions.workspace')
    expect(CONTRIBUTION_ORDER).toBe(110)
  })

  it('orders the rows vscode, explorer, copy-path', () => {
    expect(ids(harness())).toEqual(['vscode', 'explorer', 'copy-path'])
  })

  it('keys every row icon for the contextMenu.icon slot', () => {
    expect(buildWorkspaceActions(TARGET, harness().deps).map(action => action.icon.key)).toEqual([
      'sidebar-menu-actions.vscode',
      'sidebar-menu-actions.explorer',
      'sidebar-menu-actions.copy-path',
    ])
  })

  it('labels the rows from the menu-actions dictionary', () => {
    expect(buildWorkspaceActions(TARGET, harness().deps).map(action => action.label)).toEqual([
      translateEn('menu.openInVscode'),
      translateEn('menu.openInFileBrowser'),
      translateEn('menu.copyWorkspacePath'),
    ])
  })

  it('keeps only the launch rows whose app the host lists, and always keeps copy', () => {
    expect(ids(harness({ apps: ['vscode', 'explorer'] }))).toEqual(['vscode', 'explorer', 'copy-path'])
    expect(ids(harness({ apps: ['vscode'] }))).toEqual(['vscode', 'copy-path'])
    expect(ids(harness({ apps: ['explorer'] }))).toEqual(['explorer', 'copy-path'])
    expect(ids(harness({ apps: ['cursor'] }))).toEqual(['copy-path'])
    expect(ids(harness({ apps: [] }))).toEqual(['copy-path'])
  })

  it('launches VS Code with the workspace path when the row runs', async () => {
    const harnessed = harness({ apps: ['vscode'] })
    const action = actionOf(buildWorkspaceActions(TARGET, harnessed.deps), 'vscode')
    expect(harnessed.launch).not.toHaveBeenCalled()
    await action.run()
    expect(harnessed.launch).toHaveBeenCalledWith('vscode', '/repo/one')
    expect(harnessed.copy).not.toHaveBeenCalled()
  })

  it('launches the file browser when the explorer row runs', async () => {
    const harnessed = harness({ apps: ['explorer'] })
    await actionOf(buildWorkspaceActions(TARGET, harnessed.deps), 'explorer').run()
    expect(harnessed.launch).toHaveBeenCalledWith('explorer', '/repo/one')
  })

  it('copies the workspace path when the copy row runs', async () => {
    const harnessed = harness()
    await actionOf(buildWorkspaceActions(TARGET, harnessed.deps), 'copy-path').run()
    expect(harnessed.copy).toHaveBeenCalledWith('/repo/one')
    expect(harnessed.launch).not.toHaveBeenCalled()
  })

  it('reads the workspace path when the row runs, not when the menu is built', async () => {
    const harnessed = harness({ path: '/repo/first' })
    const actions = buildWorkspaceActions(TARGET, harnessed.deps)
    expect(harnessed.pathAt).not.toHaveBeenCalled()
    harnessed.setPath('/repo/second')
    await actionOf(actions, 'vscode').run()
    expect(harnessed.pathAt).toHaveBeenCalledWith('w1')
    expect(harnessed.launch).toHaveBeenCalledWith('vscode', '/repo/second')
  })

  it('does nothing for any row when the workspace has no path', async () => {
    const harnessed = harness({ path: undefined })
    for (const action of buildWorkspaceActions(TARGET, harnessed.deps)) await action.run()
    expect(harnessed.pathAt).toHaveBeenCalledTimes(3)
    expect(harnessed.launch).not.toHaveBeenCalled()
    expect(harnessed.copy).not.toHaveBeenCalled()
  })

  it('asks for the path of the workspace its target names', async () => {
    const harnessed = harness({ apps: ['vscode'] })
    await actionOf(buildWorkspaceActions({ workspaceId: 'w9' }, harnessed.deps), 'vscode').run()
    expect(harnessed.pathAt).toHaveBeenCalledWith('w9')
  })
})
