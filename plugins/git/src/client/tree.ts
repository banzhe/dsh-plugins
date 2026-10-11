import type { GitChange, GitChangeStatus } from '../shared.ts'

/** One directory level of the change tree. */
export interface ChangeNode {
  readonly name: string
  /** Directories first, then files; both by name. */
  readonly children: readonly ChangeNode[]
  /** Present only on a file row. */
  readonly status?: GitChangeStatus
}

/** A directory being filled. Children stay mutable until the level is frozen. */
interface MutableNode {
  name: string
  children: MutableNode[]
  status?: GitChangeStatus
}

/**
 * Fold a flat change list into a directory tree.
 *
 * A path's directories are created as it is inserted, so a file nested three
 * levels deep still shows its folders. Two changes claiming one path keep the
 * first: porcelain lists each path once, and a repeated row would be a bug to
 * surface rather than a second file to render.
 */
export function buildChangeTree(changes: readonly GitChange[]): ChangeNode[] {
  const roots: MutableNode[] = []
  for (const change of changes) {
    const segments = change.path.split('/').filter((segment) => segment !== '')
    if (segments.length === 0) continue
    let level = roots
    for (const [index, segment] of segments.entries()) {
      const leaf = index === segments.length - 1
      let node = level.find((candidate) => candidate.name === segment)
      if (node === undefined) {
        node = { name: segment, children: [] }
        level.push(node)
      }
      if (leaf) node.status = node.status ?? change.status
      level = node.children
    }
  }
  return roots.map(freeze).sort(byName)
}

/** Freeze one level and order it: directories, then files, each by name. */
function freeze(node: MutableNode): ChangeNode {
  const children = node.children.map(freeze).sort(byKindThenName)
  return node.status === undefined
    ? { name: node.name, children }
    : { name: node.name, children, status: node.status }
}

function byKindThenName(left: ChangeNode, right: ChangeNode): number {
  const kind = Number(left.status !== undefined) - Number(right.status !== undefined)
  return kind === 0 ? byName(left, right) : kind
}

function byName(left: ChangeNode, right: ChangeNode): number {
  return left.name.localeCompare(right.name)
}
