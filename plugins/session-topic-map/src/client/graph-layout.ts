/**
 * Where every node box and link goes.
 *
 * The drawing runs top to bottom: depth — the longest path from a root over the
 * node's parents — is the box's y, and the boxes at one depth share that level's
 * x, ordered by where their parents already are. A child therefore sits under the
 * node it continues, siblings of one parent spread around it, and a reply that
 * rejoins two diverged topics lands between them, one level below the deeper of
 * the two, with both incoming links visible. The module is pure geometry over
 * {@link ProgressGraph} — no React, no DOM — so the panel renders what this
 * returns and a test can assert the arrangement directly.
 *
 * @module @banzhe/dsh-session-topic-map/src/client/graph-layout
 */

import type { ProgressGraph, ProgressNode } from '../progress-graph.ts'

/** Box and gap sizes; the panel passes nothing and takes these defaults. */
export interface LayoutOptions {
  readonly nodeWidth?: number
  readonly nodeHeight?: number
  readonly levelGap?: number
  readonly siblingGap?: number
}

/** One box, already positioned. */
export interface LaidOutNode {
  readonly id: string
  readonly seq: number
  readonly turn: number
  readonly topics: readonly string[]
  readonly depth: number
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

/** One link, already drawn as an SVG path. */
export interface LaidOutEdge {
  readonly from: string
  readonly to: string
  readonly kind: 'branch' | 'merge'
  readonly path: string
}

/** The whole drawing. */
export interface GraphLayout {
  readonly width: number
  readonly height: number
  readonly nodes: readonly LaidOutNode[]
  readonly edges: readonly LaidOutEdge[]
}

/** Box width; wide enough for a short topic list at 12px. */
export const NODE_WIDTH = 136

/** Box height; one topic row plus a meta row. */
export const NODE_HEIGHT = 46

/** Vertical gap between one depth level and the level below it. */
export const LEVEL_GAP = 48

/** Horizontal gap between boxes standing on the same level. */
export const SIBLING_GAP = 16

function depthsOf(graph: ProgressGraph): Map<string, number> {
  const parents = new Map<string, readonly string[]>(graph.nodes.map(node => [node.id, node.parents]))
  const depths = new Map<string, number>()
  const visiting = new Set<string>()
  const depthOf = (id: string): number => {
    const known = depths.get(id)
    if (known !== undefined) return known
    // A stored graph is a DAG; the guard keeps a hand-edited cycle from
    // recursing forever instead of drawing something finite.
    if (visiting.has(id)) return 0
    visiting.add(id)
    let depth = 0
    for (const parent of parents.get(id) ?? []) {
      depth = Math.max(depth, depthOf(parent) + 1)
    }
    visiting.delete(id)
    depths.set(id, depth)
    return depth
  }
  for (const node of graph.nodes) depthOf(node.id)
  return depths
}

/**
 * Mean centre x of a node's already-placed parents, or `null` for a root.
 *
 * This is what keeps a branch under the node it continues, and what puts a merge
 * between the two topics it rejoins.
 */
function parentCentreOf(node: ProgressNode, placed: ReadonlyMap<string, LaidOutNode>): number | null {
  let total = 0
  let found = 0
  for (const parent of node.parents) {
    const box = placed.get(parent)
    if (box === undefined) continue
    total += box.x + box.width / 2
    found += 1
  }
  return found === 0 ? null : total / found
}

/**
 * Lay a graph out top to bottom.
 * @param graph - the graph to draw.
 * @param options - size overrides; every field defaults to the exported constant.
 * @returns boxes, links, and the drawing's size, starting at `0 0`.
 */
export function layoutGraph(graph: ProgressGraph, options: LayoutOptions = {}): GraphLayout {
  const nodeWidth = options.nodeWidth ?? NODE_WIDTH
  const nodeHeight = options.nodeHeight ?? NODE_HEIGHT
  const levelGap = options.levelGap ?? LEVEL_GAP
  const siblingGap = options.siblingGap ?? SIBLING_GAP
  if (graph.nodes.length === 0) return { width: 0, height: 0, nodes: [], edges: [] }

  const depths = depthsOf(graph)
  const levels = new Map<number, ProgressNode[]>()
  for (const node of graph.nodes) {
    const depth = depths.get(node.id) ?? 0
    const level = levels.get(depth)
    if (level === undefined) levels.set(depth, [node])
    else level.push(node)
  }
  const byDepth = [...levels.keys()].sort((left, right) => left - right)
  const placed = new Map<string, LaidOutNode>()

  // Ascending depth, so every parent is already placed when a level is arranged.
  for (const depth of byDepth) {
    const level = levels.get(depth) ?? []
    const wanted = level
      .map((node, index) => ({ node, index, centre: parentCentreOf(node, placed) }))
      .sort((one, other) => ((one.centre ?? -Infinity) - (other.centre ?? -Infinity)) || (one.index - other.index))
    const spread = nodeWidth + siblingGap
    const centres: number[] = []
    let wantedTotal = 0
    let placedTotal = 0
    let right = -Infinity
    for (const [slot, entry] of wanted.entries()) {
      // A root has no parent to sit under, so a level of roots spreads around 0.
      const target = entry.centre ?? (slot - (wanted.length - 1) / 2) * spread
      // Left to right and never closer than one gap: this keeps the order above.
      const centre = Math.max(target, right + nodeWidth / 2)
      right = centre + nodeWidth / 2 + siblingGap
      centres.push(centre)
      wantedTotal += target
      placedTotal += centre
    }
    // Several children of one parent would all want its centre and pile up to its
    // right; shifting the finished level by that drift centres them under it.
    const drift = (wantedTotal - placedTotal) / centres.length
    const y = depth * (nodeHeight + levelGap)
    for (const [slot, entry] of wanted.entries()) {
      const node = entry.node
      placed.set(node.id, {
        id: node.id,
        seq: node.seq,
        turn: node.turn,
        topics: node.topics,
        depth,
        x: (centres[slot] ?? 0) + drift - nodeWidth / 2,
        y,
        width: nodeWidth,
        height: nodeHeight,
      })
    }
  }

  // One pass for the left edge and one for the shifted boxes, so no spread over
  // the whole graph is built just to take a minimum or a maximum.
  let leftmost = Infinity
  for (const box of placed.values()) {
    if (box.x < leftmost) leftmost = box.x
  }
  const nodes: LaidOutNode[] = []
  const drawn = new Map<string, LaidOutNode>()
  let width = 0
  let height = 0
  for (const node of graph.nodes) {
    const box = placed.get(node.id)
    if (box === undefined) continue
    const shifted: LaidOutNode = { ...box, x: box.x - leftmost }
    nodes.push(shifted)
    drawn.set(shifted.id, shifted)
    width = Math.max(width, shifted.x + shifted.width)
    height = Math.max(height, shifted.y + shifted.height)
  }
  const edges: LaidOutEdge[] = []
  for (const edge of graph.edges) {
    const from = drawn.get(edge.from)
    const to = drawn.get(edge.to)
    if (from === undefined || to === undefined) continue
    const x1 = from.x + from.width / 2
    const y1 = from.y + from.height
    const x2 = to.x + to.width / 2
    const y2 = to.y
    const bend = Math.max(16, (y2 - y1) / 2)
    edges.push({
      from: edge.from,
      to: edge.to,
      kind: edge.kind,
      path: ['M', x1, y1, 'C', x1, y1 + bend, x2, y2 - bend, x2, y2].join(' '),
    })
  }
  return { width, height, nodes, edges }
}
