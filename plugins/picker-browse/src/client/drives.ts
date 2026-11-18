/**
 * Drive letters for the dialog's header row: which roots to ask the Host for,
 * which drive a listed path sits on, and the parallel probe that keeps only the
 * roots a Host can list. Pure functions plus one bounded fan-out — the dialog
 * owns when to run it and what a picked root means.
 */

/** Every candidate Windows drive root, in the order the row renders them. */
export const DRIVE_ROOTS: readonly string[] = Object.freeze(
  Array.from({ length: 24 }, (_unused, index) => `${String.fromCharCode(67 + index)}:\\`),
)

/**
 * The row label of one root: the letter and its colon, without the separator.
 * @param root - a root as {@link DRIVE_ROOTS} spells it (`C:\`).
 * @returns the label a button shows (`C:`).
 */
export function driveLabel(root: string): string {
  return root.endsWith('\\') ? root.slice(0, -1) : root
}

/**
 * The drive a listed path sits on.
 * @param path - an absolute path the Host reported, in either separator style.
 * @returns `C:`-style drive label, or null for a path with no drive (POSIX, relative).
 */
export function driveOfPath(path: string): string | null {
  const match = /^([A-Za-z]):(?:[\\/]|$)/.exec(path)
  return match === null ? null : `${(match[1] ?? '').toUpperCase()}:`
}

/** The listing call the probe fans out over: one Host level listing. */
export type ListLevel = (path: string, signal: AbortSignal) => Promise<unknown>

/**
 * Ask the Host for every candidate root at once and keep the ones that answer.
 * A root that does not exist, is unreadable, or is refused rejects like any
 * other unreadable directory; the row only ever offers roots that listed, so a
 * failure is silent here and the operator sees no broken button.
 * @param list - the Host listing call (its rejection is the absence signal).
 * @param signal - the probe's lifetime; a superseded probe answers nothing.
 * @returns the listed roots in {@link DRIVE_ROOTS} order.
 */
export async function probeDrives(list: ListLevel, signal: AbortSignal): Promise<readonly string[]> {
  const answers = await Promise.all(DRIVE_ROOTS.map(async (root): Promise<string | null> => {
    try {
      await list(root, signal)
      return root
    } catch {
      return null
    }
  }))
  return answers.filter((root): root is string => root !== null)
}
