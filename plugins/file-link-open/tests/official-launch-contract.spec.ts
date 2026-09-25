/**
 * The contract this plugin's launch arguments depend on, exercised against the
 * INSTALLED official resolver.
 *
 * `src/launch-args.ts` extends a resolution's argv so that its added arguments
 * carry the catalog's `{path}` placeholder, and — for a plain open — so that the
 * window-reuse switch survives to the spawn. That only reaches the editor
 * correctly because the official launcher substitutes the placeholder:
 * `launchArgs` in the resolver replaces it in an argv that carries it, and
 * appends the path to one that does not. If an official patch changes that rule,
 * every line launch would silently spawn `--goto <file>:24 <file>` (a flagship
 * "wrong launch"), so the rule is pinned here rather than in prose.
 *
 * `launchResolved` takes its launcher as an injectable hook, so the real
 * substitution runs with a recording stand-in instead of a spawned process.
 */
import { describe, expect, it } from 'vitest'
import { loadOfficialOpenInApp } from '../src/index.ts'
import { withLaunchArgs } from '../src/launch-args.ts'

/** The path the route would hand the launcher. */
const ABSOLUTE = '/abs/a.ts'

/** One spawn the official launcher was asked to perform. */
interface Spawn {
  readonly command: string
  readonly args: readonly string[]
}

/** Run one resolution through the real `launchResolved` with a recording launcher. */
async function launchAndRecord(resolved: unknown, path: string) {
  const { resolver } = await loadOfficialOpenInApp()
  const spawns: Spawn[] = []
  const outcome = await resolver.launchResolved(resolved, path, 5, {
    launch: async (command: string, args: readonly string[]) => { spawns.push({ command, args }) },
    resolveExecutable: async () => null,
  })
  return { outcome, spawns }
}

/** A VS Code-shaped resolution: the catalog's own argv carries no path token. */
const vsCode = { launch: { kind: 'argv' as const, command: 'Code.exe', args: ['--new-window'] } }

describe('installed official launcher contract', () => {
  it('substitutes the path into the line-bearing argv instead of appending it', async () => {
    const { pathToken } = await loadOfficialOpenInApp()
    const { outcome, spawns } = await launchAndRecord(
      withLaunchArgs(vsCode, 'vscode', 24, pathToken), ABSOLUTE,
    )
    expect(outcome).toBe('launched')
    // One argv element: a separate appended path here would mean the editor was
    // asked to open a file named "a.ts:24".
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
    // This is the actual fix for "it keeps opening a new window": without the
    // switch, VS Code's CLI default is a fresh window.
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
