/**
 * The row set this plugin hands the official file menu: which applications
 * appear, which rows carry the separators, what each row executes, and how a
 * destination resolves against the clicked Session's workspace root.
 *
 * These are pure functions of the clicked target, the two app probes and the
 * supplied callbacks, so the spec drives them directly — no Cordis, no DOM.
 */
import { describe, expect, it, vi } from 'vitest'
import {
  APP_ICON_KEY, buildFileActions, editorIds, relativeToCwd, resolveAgainstCwd,
  type AppProbes, type FileMenuAction, type FileMenuDeps, type FileMenuId, type FileTarget,
} from '../src/client/actions.ts'
import { en, NS, zh } from '../src/client/locales.ts'
import { LocaleDouble } from './locale-double.ts'

/** The shipped dictionaries behind the real translator, so a key typo surfaces as a label mismatch. */
const locale = new LocaleDouble()
locale.register(NS, { zh, en })

const t: FileMenuDeps['t'] = locale.bind(NS)

const SESSION = 'sess-1'
const CWD = '/work/demo'

function deps(overrides: Partial<FileMenuDeps> = {}): FileMenuDeps {
  return {
    t,
    cwdOf: () => CWD,
    icon: appId => ({ key: APP_ICON_KEY, src: 'open-in-app/icon/' + appId }),
    launch: vi.fn(async () => {}),
    copy: vi.fn(async () => {}),
    ...overrides,
  }
}

function target(path: string, line?: number): FileTarget {
  return line === undefined ? { sessionId: SESSION, path } : { sessionId: SESSION, path, line }
}

/** Both probes confirmed this Host's editors; the file managers ride the official probe alone. */
const confirmed: AppProbes = {
  officialApps: ['vscode', 'cursor', 'explorer', 'finder'],
  info: { available: ['vscode', 'cursor'] },
}

const ids = (rows: readonly FileMenuAction[]): FileMenuId[] => rows.map(row => row.id)
const separators = (rows: readonly FileMenuAction[]): boolean[] => rows.map(row => row.separatorBefore === true)

describe('editor selection', () => {
  it('offers an editor only where both probes agree', () => {
    expect(editorIds(confirmed)).toEqual(['vscode', 'cursor'])
  })

  it('keeps the official intersection alone for a host that answered without a list', () => {
    expect(editorIds({ officialApps: ['vscode', 'cursor', 'zed'], info: {} })).toEqual(['vscode', 'cursor', 'zed'])
    expect(editorIds({ officialApps: ['vscode', 'cursor', 'zed'], info: { available: null } })).toEqual(['vscode', 'cursor', 'zed'])
  })

  it('drops editors this host could not resolve', () => {
    expect(editorIds({ officialApps: ['vscode', 'cursor', 'zed'], info: { available: ['zed'] } })).toEqual(['zed'])
    expect(editorIds({ officialApps: ['vscode'], info: { available: [] } })).toEqual([])
  })

  it('offers no editor before this plugin answered its own probe', () => {
    expect(editorIds({ officialApps: ['vscode'], info: null })).toEqual([])
  })

  it('offers no editor for a host whose official probe answered nothing', () => {
    expect(editorIds({ officialApps: null, info: { available: ['vscode'] } })).toEqual([])
  })

  it('never offers a file manager: the official menu already reveals the directory', () => {
    expect(editorIds({ officialApps: ['explorer', 'finder', 'filemanager'], info: {} })).toEqual([])
  })
})

describe('row set', () => {
  it('leads with the line heading and groups the editor rows above the copy row', () => {
    const rows = buildFileActions(confirmed, target('src/a.ts', 24), deps())
    expect(ids(rows)).toEqual(['line', 'app:vscode', 'app:cursor', 'copy-rel'])
    expect(rows[0]).toMatchObject({ label: 'Line 24', disabled: true, separatorBefore: true })
    expect(separators(rows)).toEqual([true, false, false, true])
    expect(rows[1]).toMatchObject({
      label: 'VS Code',
      icon: { key: APP_ICON_KEY, src: 'open-in-app/icon/vscode' },
      failureLabel: 'Could not open the file',
    })
    expect(rows[3]?.label).toBe('Copy relative path')
    expect(rows[3]?.failureLabel).toBe('Could not copy the path')
  })

  it('separates the editor group from the official rows when the target named no line', () => {
    const rows = buildFileActions(confirmed, target('src/a.ts'), deps())
    expect(separators(rows)).toEqual([true, false, true])
  })

  it('offers the copy row alone when neither probe answered', () => {
    const rows = buildFileActions({ officialApps: null, info: null }, target('src/a.ts'), deps())
    expect(ids(rows)).toEqual(['copy-rel'])
    // The shared menu's official rows sit above this one, so it still starts a group.
    expect(separators(rows)).toEqual([true])
  })

  it('keeps the line heading when no editor is known', () => {
    const rows = buildFileActions({ officialApps: null, info: null }, target('src/a.ts', 7), deps())
    expect(ids(rows)).toEqual(['line', 'copy-rel'])
    expect(separators(rows)).toEqual([true, true])
  })

  it('never repeats a row the official file menu already owns', () => {
    const official = ['reveal', 'copyPath', 'open', 'sidebar', 'float']
    for (const rows of [
      buildFileActions(confirmed, target('src/a.ts', 24), deps()),
      buildFileActions(confirmed, target('src/a.ts'), deps()),
      buildFileActions({ officialApps: null, info: null }, target('src/a.ts'), deps()),
    ]) {
      for (const row of rows) expect(official).not.toContain(row.id)
      expect(ids(rows).filter(id => id.startsWith('fm:'))).toEqual([])
      expect(ids(rows)).not.toContain('copy-abs')
    }
  })

  it('reads each destination against its own Session workspace root', () => {
    const launch = vi.fn(async () => {})
    const roots: Record<string, string> = { 'sess-a': '/work/alpha', 'sess-b': '/work/beta' }
    const twoPanes = deps({ launch, cwdOf: sessionId => roots[sessionId] })

    const first = buildFileActions(confirmed, { sessionId: 'sess-a', path: 'src/a.ts', line: 3 }, twoPanes)
    const second = buildFileActions(confirmed, { sessionId: 'sess-b', path: 'src/a.ts' }, twoPanes)

    void first.find(candidate => candidate.id === 'app:vscode')?.run?.()
    void second.find(candidate => candidate.id === 'app:vscode')?.run?.()
    expect(launch.mock.calls).toEqual([
      ['vscode', '/work/alpha/src/a.ts', 3],
      ['vscode', '/work/beta/src/a.ts', null],
    ])
  })

  it('leaves the destination alone for a Session whose root the host has not reported', () => {
    const copy = vi.fn(async () => {})
    const rows = buildFileActions(confirmed, target('src/a.ts'), deps({ copy, cwdOf: () => undefined }))
    const row = rows.find(candidate => candidate.id === 'copy-rel')
    if (row?.run === undefined) throw new Error('no copy row')
    void row.run()
    expect(copy).toHaveBeenCalledWith('src/a.ts')
  })
})

describe('what each row executes', () => {
  it('launches an editor with the absolute path and the named line', async () => {
    const launch = vi.fn(async () => {})
    const rows = buildFileActions(confirmed, target('src/a.ts', 24), deps({ launch }))
    const row = rows.find(candidate => candidate.id === 'app:vscode')
    if (row?.run === undefined) throw new Error('no editor row')
    await row.run()
    expect(launch).toHaveBeenCalledWith('vscode', '/work/demo/src/a.ts', 24)
  })

  it('launches an editor at the top of the file when the link named no line', async () => {
    const launch = vi.fn(async () => {})
    const rows = buildFileActions(confirmed, target('src/a.ts'), deps({ launch }))
    const row = rows.find(candidate => candidate.id === 'app:cursor')
    if (row?.run === undefined) throw new Error('no editor row')
    await row.run()
    expect(launch).toHaveBeenCalledWith('cursor', '/work/demo/src/a.ts', null)
  })

  it('copies the workspace-relative path, keeping the line out of it', async () => {
    const copy = vi.fn(async () => {})
    const rows = buildFileActions(confirmed, target('/work/demo/src/a.ts', 24), deps({ copy }))
    const row = rows.find(candidate => candidate.id === 'copy-rel')
    if (row?.run === undefined) throw new Error('no copy row')
    await row.run()
    expect(copy).toHaveBeenCalledWith('src/a.ts')
  })
})

/**
 * The official `relativizeToCwd` body as shipped in
 * `@deepseek-ai/dsh-util-workspace-path` 0.2.2-rc.2, reproduced so the spec can
 * show which cases this plugin's copy deliberately answers differently
 * (same-separator-spelling comparison; no normalization).
 */
function officialRelativizeToCwd(text: string, cwd: string): string {
  const root = cwd.replace(/[/\\]+$/, '')
  if (text.startsWith(`${root}/`) || text.startsWith(`${root}\\`)) return text.slice(root.length + 1)
  return text
}

describe('path helpers', () => {
  it('resolves a relative destination against the workspace root, in its own separator spelling', () => {
    expect(resolveAgainstCwd('/work/demo', 'src/a.ts')).toBe('/work/demo/src/a.ts')
    expect(resolveAgainstCwd('/work/demo/', 'src/a.ts')).toBe('/work/demo/src/a.ts')
    expect(resolveAgainstCwd('C:\\work\\demo', 'src\\a.ts')).toBe('C:\\work\\demo\\src\\a.ts')
    expect(resolveAgainstCwd('/work/demo', './src/a.ts')).toBe('/work/demo/src/a.ts')
  })

  it('spells the whole resolved path in the root own separator, both directions', () => {
    // Windows root + slash-authored link: the mixed spelling would reach launch argv.
    expect(resolveAgainstCwd('C:\\work\\demo', 'src/deep/a.ts')).toBe('C:\\work\\demo\\src\\deep\\a.ts')
    // POSIX root + backslash-authored link.
    expect(resolveAgainstCwd('/work/demo', 'src\\deep\\a.ts')).toBe('/work/demo/src/deep/a.ts')
    // A drive root spelled with forward slashes keeps the separator it already uses.
    expect(resolveAgainstCwd('C:/work/demo', 'src\\a.ts')).toBe('C:/work/demo/src/a.ts')
  })

  it('leaves an already-absolute destination alone', () => {
    expect(resolveAgainstCwd('/work/demo', '/elsewhere/a.ts')).toBe('/elsewhere/a.ts')
    expect(resolveAgainstCwd('/work/demo', 'C:/elsewhere/a.ts')).toBe('C:/elsewhere/a.ts')
    expect(resolveAgainstCwd('/work/demo', '\\\\srv\\share\\a.ts')).toBe('\\\\srv\\share\\a.ts')
  })

  it('leaves a destination alone while no workspace root is known', () => {
    expect(resolveAgainstCwd(null, 'src/a.ts')).toBe('src/a.ts')
    expect(resolveAgainstCwd(undefined, 'src/a.ts')).toBe('src/a.ts')
    expect(resolveAgainstCwd('', 'src/a.ts')).toBe('src/a.ts')
  })

  it('strips the workspace root off an absolute path', () => {
    expect(relativeToCwd('/work/demo/src/a.ts', '/work/demo')).toBe('src/a.ts')
    expect(relativeToCwd('C:\\work\\demo\\src\\a.ts', 'C:\\work\\demo')).toBe('src\\a.ts')
    expect(relativeToCwd('/other/a.ts', '/work/demo')).toBe('/other/a.ts')
    expect(relativeToCwd('src/a.ts', null)).toBe('src/a.ts')
    expect(relativeToCwd('src/a.ts', undefined)).toBe('src/a.ts')
    expect(relativeToCwd('src/a.ts', '')).toBe('src/a.ts')
  })

  it('answers paths whose separators disagree where the official helper gives up', () => {
    const mixedText = '/work\\demo\\src\\a.ts'
    expect(officialRelativizeToCwd(mixedText, '/work/demo')).toBe(mixedText)
    expect(relativeToCwd(mixedText, '/work/demo')).toBe('src\\a.ts')

    const slashText = 'C:/work/demo/src/a.ts'
    const backslashRoot = 'C:\\work\\demo'
    expect(officialRelativizeToCwd(slashText, backslashRoot)).toBe(slashText)
    expect(relativeToCwd(slashText, backslashRoot)).toBe('src/a.ts')
  })

  it('keeps the original spelling of the remainder and ignores trailing root separators', () => {
    expect(relativeToCwd('C:\\work\\demo/src/a.ts', 'C:\\work\\demo')).toBe('src/a.ts')
    expect(relativeToCwd('C:\\work\\demo\\src\\a.ts', 'C:\\work\\demo\\')).toBe('src\\a.ts')
  })

  it('does not fold case or drive letters', () => {
    expect(relativeToCwd('c:\\work\\demo\\a.ts', 'C:\\work\\demo')).toBe('c:\\work\\demo\\a.ts')
    expect(relativeToCwd('/Work/Demo/a.ts', '/work/demo')).toBe('/Work/Demo/a.ts')
  })

  it('keeps a sibling that merely shares a prefix out of the relative form', () => {
    expect(relativeToCwd('/work/demo-other/a.ts', '/work/demo')).toBe('/work/demo-other/a.ts')
    expect(relativeToCwd('/work/demo', '/work/demo')).toBe('/work/demo')
  })
})
