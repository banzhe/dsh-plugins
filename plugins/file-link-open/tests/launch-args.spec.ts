/**
 * The argv this plugin adds to an official launch: the editor's line-selection
 * spelling and its window-reuse switch. Every assertion here pins a CLI spelling
 * substituted into the official launcher's argv, so a wrong flag is a red test
 * rather than an editor that opens at the top, or in a new window, or refuses to
 * launch at all.
 *
 * The ids come from the host half's own list, so adding an editor there without
 * deciding on its flags fails the sweeps below.
 */
import { describe, expect, it } from 'vitest'
import { EDITOR_IDS } from '../src/editors.ts'
import { lineArgsFor, reuseArgsFor, supportsLaunchArgs, withLaunchArgs } from '../src/launch-args.ts'

/** The placeholder the official catalog exports; every template must keep it. */
const TOKEN = '{path}'

describe('lineArgsFor', () => {
  it.each([
    ['vscode', ['--goto', `${TOKEN}:24`]],
    ['vscodeinsiders', ['--goto', `${TOKEN}:24`]],
    ['cursor', ['--goto', `${TOKEN}:24`]],
    ['windsurf', ['--goto', `${TOKEN}:24`]],
    ['zed', [`${TOKEN}:24`]],
    ['sublimetext', [`${TOKEN}:24`]],
    ['intellij', ['--line', '24', TOKEN]],
    ['pycharm', ['--line', '24', TOKEN]],
    ['webstorm', ['--line', '24', TOKEN]],
    ['phpstorm', ['--line', '24', TOKEN]],
    ['goland', ['--line', '24', TOKEN]],
    ['rider', ['--line', '24', TOKEN]],
    ['rustrover', ['--line', '24', TOKEN]],
  ])('builds %s line argv carrying the path token', (appId, expected) => {
    expect(lineArgsFor(appId, 24, TOKEN)).toEqual(expected)
  })

  it('names a line form for every launchable editor except Android Studio', () => {
    // Android Studio's launcher documents no line flag. A new id in `editors.ts`
    // must be added here and to the table deliberately, not silently open at the
    // top of the file.
    expect(EDITOR_IDS.filter(id => lineArgsFor(id, 24, TOKEN) === undefined)).toEqual(['androidstudio'])
  })

  it('has no line form for ids outside the editor set', () => {
    expect(lineArgsFor('finder', 24, TOKEN)).toBeUndefined()
    expect(lineArgsFor('explorer', 24, TOKEN)).toBeUndefined()
    expect(lineArgsFor('', 24, TOKEN)).toBeUndefined()
  })

  it('has no line form for an id that names an Object prototype member', () => {
    expect(lineArgsFor('toString', 24, TOKEN)).toBeUndefined()
  })

  it('keeps a line that is already the maximum safe integer', () => {
    expect(lineArgsFor('zed', Number.MAX_SAFE_INTEGER, TOKEN)).toEqual([`${TOKEN}:${Number.MAX_SAFE_INTEGER}`])
  })
})

describe('supportsLaunchArgs', () => {
  it('accepts an argv launcher that leaves the path to the official launcher', () => {
    expect(supportsLaunchArgs({ kind: 'argv', command: 'code', args: ['--new-window'] }, TOKEN)).toBe(true)
  })

  it('accepts an argv launcher with no arguments at all', () => {
    expect(supportsLaunchArgs({ kind: 'argv', command: 'idea64.exe', args: [] }, TOKEN)).toBe(true)
  })

  it('rejects an argv launcher whose args are simply absent', () => {
    expect(supportsLaunchArgs({ kind: 'argv', command: 'code' }, TOKEN)).toBe(false)
  })

  it.each([
    ['the macOS bundle shim, which would treat "a.ts:24" as a broken path', { kind: 'argv' as const, command: 'open', args: ['-a', 'Zed.app'] }],
    ['a launcher whose argv already positions the path', { kind: 'argv' as const, command: 'kitty', args: [`--directory=${TOKEN}`] }],
    ['a shell-open file manager, which takes a directory', { kind: 'shell-open' as const }],
  ])('rejects %s', (_why, launch) => {
    expect(supportsLaunchArgs(launch, TOKEN)).toBe(false)
  })

  it('ignores an unrelated argument that merely contains the token text', () => {
    expect(supportsLaunchArgs({ kind: 'argv', command: 'code', args: ['--title=my{path}project'] }, TOKEN)).toBe(false)
  })
})

describe('reuseArgsFor', () => {
  it.each([
    ['vscode', ['--reuse-window']],
    ['vscodeinsiders', ['--reuse-window']],
    ['cursor', ['--reuse-window']],
    // Zed spells it `--existing`: `-r/--reuse` would replace the workspace.
    ['zed', ['--existing']],
  ])('forces %s into its running window', (appId, expected) => {
    expect(reuseArgsFor(appId)).toEqual(expected)
  })

  it('names the reuse switch only where the editor documents one', () => {
    // Every other editor either reuses the running window by default (the
    // JetBrains launchers, `subl`) or documents no such switch (Windsurf,
    // Android Studio). A new id in `editors.ts` must be decided here.
    expect(EDITOR_IDS.filter(id => reuseArgsFor(id) === undefined)).toEqual([
      'windsurf', 'sublimetext', 'androidstudio', 'intellij', 'pycharm',
      'webstorm', 'phpstorm', 'goland', 'rider', 'rustrover',
    ])
  })

  it('has no reuse switch for an id outside the editor set', () => {
    expect(reuseArgsFor('finder')).toBeUndefined()
    expect(reuseArgsFor('toString')).toBeUndefined()
  })
})

describe('withLaunchArgs', () => {
  /** A VS Code-shaped resolution as the official resolver hands it over. */
  const resolved = {
    launch: { kind: 'argv' as const, command: 'Code.exe', args: ['--new-window'] },
    fallbackLaunch: { kind: 'argv' as const, command: 'code', args: [] },
    icon: { kind: 'executable', path: 'Code.exe' },
  }

  it('adds the reuse switch and the line form, keeping the resolution’s other fields', () => {
    expect(withLaunchArgs(resolved, 'vscode', 24, TOKEN)).toEqual({
      launch: {
        kind: 'argv',
        command: 'Code.exe',
        args: ['--new-window', '--reuse-window', '--goto', `${TOKEN}:24`],
      },
      fallbackLaunch: { kind: 'argv', command: 'code', args: [] },
      icon: { kind: 'executable', path: 'Code.exe' },
    })
  })

  it('adds the reuse switch even when the link named no line', () => {
    // The new-window default is not a line problem: a plain "open in VS Code"
    // also lands in a fresh window unless the switch rides along.
    expect(withLaunchArgs(resolved, 'vscode', undefined, TOKEN)).toEqual({
      launch: { kind: 'argv', command: 'Code.exe', args: ['--new-window', '--reuse-window'] },
      fallbackLaunch: { kind: 'argv', command: 'code', args: [] },
      icon: { kind: 'executable', path: 'Code.exe' },
    })
  })

  it.each([
    ['macOS bundle launch', { launch: { kind: 'argv' as const, command: 'open', args: ['-a', 'Zed.app'] } }],
    ['file manager shell-open', { launch: { kind: 'shell-open' as const } }],
  ])('leaves a %s to the official launch untouched', (_why, other) => {
    expect(withLaunchArgs(other, 'vscode', 24, TOKEN)).toBe(other)
  })

  it('leaves an editor that needs neither argument untouched', () => {
    // Android Studio documents no line flag and no window switch, so there is
    // nothing to add and the resolution must come back by identity.
    const androidStudio = { launch: { kind: 'argv' as const, command: 'studio64.exe', args: [] } }
    expect(withLaunchArgs(androidStudio, 'androidstudio', 24, TOKEN)).toBe(androidStudio)
  })

  it('still applies the line to an editor whose window it cannot force', () => {
    // The JetBrains launcher reuses the running IDE by itself, so only the line
    // argument is added.
    const idea = { launch: { kind: 'argv' as const, command: 'idea64.exe', args: [] } }
    expect(withLaunchArgs(idea, 'intellij', 7, TOKEN)).toEqual({
      launch: { kind: 'argv', command: 'idea64.exe', args: ['--line', '7', TOKEN] },
    })
  })

  it('does not mutate the resolution it is given', () => {
    const original = { launch: { kind: 'argv' as const, command: 'Code.exe', args: ['--new-window'] } }
    withLaunchArgs(original, 'vscode', 24, TOKEN)
    expect(original.launch.args).toEqual(['--new-window'])
  })

  it('applies both arguments to a re-resolved launcher after a stale resolution', () => {
    // The route re-resolves once on `missing`; that fresh resolution must still
    // carry the reuse switch and the line, or a stale-executable retry would
    // silently drop both.
    const fresh = { launch: { kind: 'argv' as const, command: 'Code.exe', args: [] } }
    expect(withLaunchArgs(fresh, 'vscode', 24, TOKEN)).toEqual({
      launch: { kind: 'argv', command: 'Code.exe', args: ['--reuse-window', '--goto', `${TOKEN}:24`] },
    })
  })
})
