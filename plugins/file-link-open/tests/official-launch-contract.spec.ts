/**
 * The contract this plugin's launch arguments depend on, exercised against the
 * INSTALLED official resolver. Its `launchArgs` replaces `{path}` in an argv
 * that carries the token and appends the path to one that does not; if an
 * official patch changes that rule, every line launch would silently spawn
 * `--goto <file>:24 <file>`, so the rule is pinned here rather than in prose.
 *
 * `launchResolved` takes its launcher as an injectable hook, so the real
 * substitution runs with a recording stand-in instead of a spawned process.
 */
import { describe, expect, it } from 'vitest'
import { loadOfficialOpenInApp } from '../src/index.ts'
import { withLaunchArgs, type ResolvedLaunch } from '../src/launch-args.ts'

const ABSOLUTE = '/abs/a.ts'

interface Spawn {
  readonly command: string
  readonly args: readonly string[]
}

/** Runs the real `launchResolved`, capturing spawns instead of spawning. */
async function launchAndRecord(resolved: ResolvedLaunch, path: string) {
  const { resolver } = await loadOfficialOpenInApp()
  const spawns: Spawn[] = []
  const outcome = await resolver.launchResolved(resolved, path, 5, {
    launch: async (command: string, args: readonly string[]) => { spawns.push({ command, args }) },
    resolveExecutable: async () => null,
  })
  return { outcome, spawns }
}

const vsCode = { launch: { kind: 'argv' as const, command: 'Code.exe', args: ['--new-window'] } }

describe('installed official launcher contract', () => {
  it('substitutes the path into the line-bearing argv instead of appending it', async () => {
    const { pathToken } = await loadOfficialOpenInApp()
    const { outcome, spawns } = await launchAndRecord(
      withLaunchArgs(vsCode, 'vscode', 24, pathToken), ABSOLUTE,
    )
    expect(outcome).toBe('launched')
    // One argv element: an appended path here would ask the editor to open a
    // file named "a.ts:24".
    expect(spawns).toEqual([{
      command: 'Code.exe',
      args: ['--new-window', '--reuse-window', '--goto', `${ABSOLUTE}:24`],
    }])
  })

  it('carries the window-reuse switch through to the spawn on a plain open', async () => {
    const { pathToken } = await loadOfficialOpenInApp()
    const { outcome, spawns } = await launchAndRecord(
      withLaunchArgs(vsCode, 'vscode', undefined, pathToken), ABSOLUTE,
    )
    expect(outcome).toBe('launched')
    // The actual fix for "it keeps opening a new window": without the switch,
    // VS Code's CLI default is a fresh window.
    expect(spawns).toEqual([{ command: 'Code.exe', args: ['--new-window', '--reuse-window', ABSOLUTE] }])
  })

  it('substitutes the path ahead of the line number for an IntelliJ platform IDE', async () => {
    const { pathToken } = await loadOfficialOpenInApp()
    const idea = { launch: { kind: 'argv' as const, command: 'idea64.exe', args: [] } }
    const { spawns } = await launchAndRecord(withLaunchArgs(idea, 'intellij', 7, pathToken), ABSOLUTE)
    // The JetBrains launcher reuses the running IDE itself, so no switch here.
    expect(spawns).toEqual([{ command: 'idea64.exe', args: ['--line', '7', ABSOLUTE] }])
  })

  it('appends the bare path for a macOS bundle launch, so it opens at the top', async () => {
    const { pathToken } = await loadOfficialOpenInApp()
    const macOS = { launch: { kind: 'argv' as const, command: 'open', args: ['-a', 'Zed.app'] } }
    const { spawns } = await launchAndRecord(withLaunchArgs(macOS, 'zed', 24, pathToken), ABSOLUTE)
    // `open -a Zed.app /abs/a.ts` — no ":24" in a path that has to name a file,
    // and macOS already routes the document to the running app.
    expect(spawns).toEqual([{ command: 'open', args: ['-a', 'Zed.app', ABSOLUTE] }])
  })

  it('leaves an argv that already positions the path to the official substitution', async () => {
    const { pathToken } = await loadOfficialOpenInApp()
    const terminal = { launch: { kind: 'argv' as const, command: 'kitty', args: [`--directory=${pathToken}`] } }
    const { spawns } = await launchAndRecord(withLaunchArgs(terminal, 'vscode', 24, pathToken), ABSOLUTE)
    expect(spawns).toEqual([{ command: 'kitty', args: [`--directory=${ABSOLUTE}`] }])
  })
})
