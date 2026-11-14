/**
 * Where every node box and link goes.
 *
 * The drawing runs top to bottom in a lane grid: each distinct `seq` in
 * ascending order occupies a row (`y`), and each topic in {@link topicsOf}
 * first-appearance order occupies a fixed horizontal lane (`x`). Nodes sharing
 * a reply `seq` sit side by side on the same row, each topic stays in its own
 * lane as it progresses downward, and links only follow same-topic `branch`
 * continuations. The module is pure geometry over {@link ProgressGraph} — no
 * React, no DOM — so the panel renders what this returns and a test can assert
 * the arrangement directly.
 *
 * @module @banzhe/dsh-session-topic-map/src/client/graph-layout
 */

import { topicsOf, type ProgressGraph } from '../progress-graph.ts'

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
  readonly topic: string
  readonly topics: readonly string[]
  readonly row: number
  readonly lane: number
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
  readonly kind: 'branch'
  readonly path: string
}

/** The whole drawing. */
export interface GraphLayout {
  readonly width: number
  readonly height: number
  readonly nodes: readonly LaidOutNode[]
  readonly edges: readonly LaidOutEdge[]
}

/** Box width; wide enough for a short topic label at 12px. */
export const NODE_WIDTH = 136

/** Box height; one topic row plus a meta row. */
export const NODE_HEIGHT = 46

/** Vertical gap between one seq row and the row below it. */
export const LEVEL_GAP = 48

/** Horizontal gap between adjacent topic lanes. */
export const SIBLING_GAP = 16

/**
 * Lay a graph out top to bottom by seq row and topic lane.
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

  const seqs = [...new Set(graph.nodes.map(node => node.seq))].sort((left, right) => left - right)
  const rowBySeq = new Map<number, number>(seqs.map((seq, row) => [seq, row]))
  const laneByTopic = new Map<string, number>(topicsOf(graph).map((topic, lane) => [topic, lane]))

  const nodes: LaidOutNode[] = []
  const drawn = new Map<string, LaidOutNode>()
  let width = 0
  let height = 0

  for (const node of graph.nodes) {
    const row = rowBySeq.get(node.seq) ?? 0
    const lane = laneByTopic.get(node.topic) ?? 0
    const x = lane * (nodeWidth + siblingGap)
    const y = row * (nodeHeight + levelGap)
    const placed: LaidOutNode = {
      id: node.id,
      seq: node.seq,
      turn: node.turn,
      topic: node.topic,
      topics: [node.topic],
      row,
      lane,
      depth: row,
      x,
      y,
      width: nodeWidth,
      height: nodeHeight,
    }
    nodes.push(placed)
    drawn.set(placed.id, placed)
    width = Math.max(width, x + nodeWidth)
    height = Math.max(height, y + nodeHeight)
  }

  const edges: LaidOutEdge[] = []
  for (const edge of graph.edges) {
    const from = drawn.get(edge.from)
    const to = drawn.get(edge.to)
    if (from === undefined || to === undefined) continue
    if (from.topic !== to.topic) continue
    const x1 = from.x + from.width / 2
    const y1 = from.y + from.height
    const x2 = to.x + to.width / 2
    const y2 = to.y
    const bend = Math.max(16, (y2 - y1) / 2)
    edges.push({
      from: edge.from,
      to: edge.to,
      kind: 'branch',
      path: ['M', x1, y1, 'C', x1, y1 + bend, x2, y2 - bend, x2, y2].join(' '),
    })
  }

  return { width, height, nodes, edges }
}
