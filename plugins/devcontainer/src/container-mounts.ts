/**
 * The host paths a Dev Container mounts beside its workspace, and what a session
 * may read under them.
 *
 * A `(devContainer)` session's filesystem fence ends at the workspace mount, so
 * the host's global agent configuration — its `AGENTS.md` and its skill trees —
 * would be invisible from inside. `devcontainer up` accepts further bind mounts
 * (`--mount type=bind,source=…,target=…`), which is the one place they can be
 * added, and the list it adds is the Host row's own `hostMounts` plan
 * (`./host-mounts.ts`), the same one a Docker Sandbox is created with. There
 * is no second list: this module only says where on the container side each
 * planned host path lands, and how a session reads it once it is there.
 *
 * The container path follows the convention a sandbox already uses — the drive
 * letter becomes the first path segment, so `C:\Users\me\.dsh\AGENTS.md` is
 * `/c/Users/me/.dsh/AGENTS.md` — which is what lets the translation, the fence,
 * and the helper's own read guard be one implementation on both tracks.
 *
 * This CLI's `--mount` form carries no read-only token, so the bind itself is
 * read-write. Read-only is therefore kept by the fence in `./fs.ts`: a mounted
 * skills tree may be listed, and read only as `<skill>/SKILL.md` and
 * `<skill>/references/**`; a mounted file may be read as that file; and this seam
 * refuses every write under any of these mounts.
 * @module @banzhe/dsh-devcontainer/container-mounts
 */

import { posix } from 'node:path'
import { hostMountSourceExists } from './host-mounts.ts'
import { containerRemainder, normalizeHostRoot, toPosixSlashes } from './paths.ts'
import type { ExtraMount } from './paths.ts'
import { sandboxWorkspacePath } from './sbx.ts'
import type { RepoContainerSpec } from './types.ts'

/** The directory name a planned mount is a skills tree by. */
const SKILLS_DIRECTORY = 'skills'

/** The file every skill carries its instructions in. */
const SKILL_FILE = 'SKILL.md'

/** The directory under a skill whose contents a session may read. */
const REFERENCES_DIRECTORY = 'references'

/**
 * The container path one host path takes inside a Dev Container.
 * @param host - the absolute host path the row declared.
 * @param target - the container path the row named, when it named one.
 * @returns the absolute POSIX path, or undefined when no convention can name it (a UNC share).
 */
export function containerPathOf(host: string, target?: string): string | undefined {
  if (target !== undefined) return posix.normalize(toPosixSlashes(target))
  const convention = sandboxWorkspacePath(host)
  return convention === undefined ? undefined : posix.normalize(convention)
}

/**
 * The extra mounts a Dev Container carries beside its workspace.
 *
 * A Docker Sandbox specification answers nothing here: its mounts are the ones
 * its own listing reported, and `sbxExtraMountsOf` owns those.
 * @param spec - the repository container specification.
 * @returns one host path and container path per declared mount, in declaration order.
 */
export function devcontainerMountsOf(spec: RepoContainerSpec): readonly ExtraMount[] {
  if (spec.cli === 'sbx') return []
  const mounts: ExtraMount[] = []
  for (const declared of spec.hostMounts ?? []) {
    const host = normalizeHostRoot(declared.host)
    const sandbox = containerPathOf(host, declared.target)
    if (sandbox === undefined) continue
    mounts.push({ host, sandbox })
  }
  return mounts
}

/** The sentence one mount that cannot travel as a `--mount` argument is reported with. */
function unusableArgumentText(spec: RepoContainerSpec, mount: ExtraMount): string {
  return 'devcontainer: "' + spec.configPath + '": the host path "' + mount.host
    + '" cannot be passed as one "--mount" argument (the form splits on commas), so it is not mounted'
}

/** The sentence one mount whose source is gone is reported with. */
function missingSourceText(spec: RepoContainerSpec, mount: ExtraMount): string {
  return 'devcontainer: "' + spec.configPath + '": the host path "' + mount.host
    + '" does not exist, so it is not mounted at "' + mount.sandbox + '"; create it or remove it from "hostMounts"'
}

/**
 * The `devcontainer up` arguments that add the declared mounts to a new container.
 *
 * Only sources that exist right now are passed: the CLI rejects a bind mount whose
 * source is missing, which would fail the whole create, and nothing here may
 * create a host path the session was only given to read.
 * @param spec - the repository container specification.
 * @param warn - reports each declaration that is skipped, and why.
 * @returns `--mount` followed by its value, once per mount that can be passed.
 */
export async function containerMountArgsOf(
  spec: RepoContainerSpec,
  warn?: (message: string) => void,
): Promise<string[]> {
  const args: string[] = []
  for (const mount of devcontainerMountsOf(spec)) {
    if (mount.host.includes(',') || mount.sandbox.includes(',')) {
      warn?.(unusableArgumentText(spec, mount))
      continue
    }
    if (!(await hostMountSourceExists(mount))) {
      warn?.(missingSourceText(spec, mount))
      continue
    }
    args.push('--mount', 'type=bind,source=' + mount.host + ',target=' + mount.sandbox)
  }
  return args
}

/**
 * Whether one mount is a skills tree, by the directory name it was declared under.
 *
 * The plan's skills entries are exactly `<dshHome>/skills` and
 * `<agentsHome>/skills`; every other declaration — the two `AGENTS.md` files, and
 * any path a row lists itself — is read as the path it names.
 * @param mount - one declared mount.
 * @returns true when the host path is a skills directory.
 */
function isSkillsTree(mount: ExtraMount): boolean {
  return posix.basename(toPosixSlashes(normalizeHostRoot(mount.host))).toLowerCase() === SKILLS_DIRECTORY
}

/**
 * The mount a container path sits in, preferring the deepest one.
 * @param containerPath - an absolute container path.
 * @param mounts - the mounts this session may name.
 * @returns the covering mount, or undefined when the path belongs to the workspace.
 */
export function hostMountCovering(
  containerPath: string, mounts: readonly ExtraMount[],
): ExtraMount | undefined {
  let found: ExtraMount | undefined
  for (const mount of mounts) {
    if (containerRemainder(containerPath, mount.sandbox) === undefined) continue
    if (found !== undefined && found.sandbox.length >= mount.sandbox.length) continue
    found = mount
  }
  return found
}

/**
 * Whether one skill path may be read out of a skills tree.
 * @param remainder - the POSIX path below the skills root.
 * @returns true for `<skill>/SKILL.md` and `<skill>/references/**`.
 */
function skillFileReadable(remainder: string): boolean {
  const segments = remainder.split('/').filter(segment => segment !== '')
  if (segments.length < 2) return false
  const skill = segments[0]
  // The remainder is normalized before it gets here, so a climbing segment can only
  // appear if a caller wrote one; refusing it keeps the rule independent of that.
  if (skill === undefined || skill === '.' || skill === '..') return false
  if (segments.length === 2) return segments[1] === SKILL_FILE
  return segments[1] === REFERENCES_DIRECTORY
}

/**
 * Whether a read of one container path may go ahead.
 *
 * Everything outside the declared mounts is the workspace, which has its own
 * fence. Inside a mount, a path that is not a skills tree is readable as a whole;
 * a skills tree admits only its `SKILL.md`, its `references/` tree, and listing
 * (a listing is a directory call, not a read).
 * @param containerPath - the container path the read would open.
 * @param mounts - the mounts this session may name.
 * @returns true when the read is allowed.
 */
export function hostMountReadAllowed(containerPath: string, mounts: readonly ExtraMount[]): boolean {
  const mount = hostMountCovering(containerPath, mounts)
  if (mount === undefined || !isSkillsTree(mount)) return true
  const remainder = containerRemainder(containerPath, mount.sandbox) ?? ''
  return skillFileReadable(remainder)
}
