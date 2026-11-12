import { describe, expect, it } from 'vitest'
import { EMPTY_PROGRESS_GRAPH, applyAnalysis, type AnalysisBatch, type ProgressGraph } from '../src/progress-graph.ts'
import {
  LEVEL_GAP,
  NODE_HEIGHT,
  NODE_WIDTH,
  SIBLING_GAP,
  layoutGraph,
} from '../src/client/graph-layout.ts'

function batch(fromSeq: number, toSeq: number, contributions: AnalysisBatch['contributions']): AnalysisBatch {
  return { fromSeq, toSeq, turn: 1, contributions }
}

function build(steps: readonly (readonly { seq: number; topics: readonly string[] }[])[]): ProgressGraph {
  let graph = EMPTY_PROGRESS_GRAPH
  for (const step of steps) {
    const seqs = step.map((item) => item.seq)
    const last = Math.max(...seqs)
    graph = applyAnalysis(graph, batch(last - 1, last, step.map((item) => ({ seq: item.seq, turn: 1, topics: item.topics }))))
  }
  return graph
}

function nodeOf(layout: ReturnType<typeof layoutGraph>, id: string) {
  const node = layout.nodes.find((candidate) => candidate.id === id)
  if (!node) throw new Error('missing laid out node ' + id)
  return node
}

function centreOf(node: { readonly x: number; readonly width: number }): number {
  return node.x + node.width / 2
}

function numbersOf(path: string): number[] {
  return (path.match(/-?\d+(\.\d+)?/g) ?? []).map(Number)
}

describe('graph layout', () => {
  it('lays out an empty graph as nothing', () => {
    expect(layoutGraph(EMPTY_PROGRESS_GRAPH)).toEqual({ width: 0, height: 0, nodes: [], edges: [] })
  })

  it('places a single node at the origin using the exported defaults', () => {
    const layout = layoutGraph(build([[{ seq: 1, topics: ['a'] }]]))

    expect(layout.nodes).toHaveLength(1)
    expect(layout.nodes[0]).toMatchObject({ id: 'n-1', seq: 1, turn: 1, topics: ['a'], depth: 0, x: 0, y: 0, width: NODE_WIDTH, height: NODE_HEIGHT })
    expect(layout.edges).toEqual([])
    expect(layout.width).toBe(NODE_WIDTH)
    expect(layout.height).toBe(NODE_HEIGHT)
  })

  it('exports the documented default metrics', () => {
    expect(NODE_WIDTH).toBe(136)
    expect(NODE_HEIGHT).toBe(46)
    expect(LEVEL_GAP).toBe(48)
    expect(SIBLING_GAP).toBe(16)
  })

  it('puts depth on y, so siblings that share a parent-less depth sit side by side on one level in node order', () => {
    const layout = layoutGraph(build([
      [{ seq: 1, topics: ['a'] }],
      [{ seq: 2, topics: ['b'] }],
    ]))

    const first = nodeOf(layout, 'n-1')
    const second = nodeOf(layout, 'n-2')
    expect(first.depth).toBe(0)
    expect(second.depth).toBe(0)
    expect(second.y).toBe(first.y)
    expect(second.x - first.x).toBe(NODE_WIDTH + SIBLING_GAP)
    expect(layout.height).toBe(NODE_HEIGHT)
  })

  it('places a child one level below its parent, with the edge leaving the parent bottom-middle', () => {
    const layout = layoutGraph(build([
      [{ seq: 1, topics: ['a'] }],
      [{ seq: 2, topics: ['a'] }],
    ]))

    const parent = nodeOf(layout, 'n-1')
    const child = nodeOf(layout, 'n-2')
    expect(child.depth).toBe(parent.depth + 1)
    expect(child.y - parent.y).toBe(NODE_HEIGHT + LEVEL_GAP)
    expect(child.x).toBe(parent.x)

    expect(layout.edges).toHaveLength(1)
    const edge = layout.edges[0]
    expect(edge).toMatchObject({ from: 'n-1', to: 'n-2', kind: 'branch' })
    const numbers = numbersOf(edge?.path ?? '')
    expect(numbers[0]).toBe(centreOf(parent))
    expect(numbers[1]).toBe(parent.y + parent.height)
    expect(numbers[6]).toBe(centreOf(child))
    expect(numbers[7]).toBe(child.y)
    expect(layout.height).toBe(child.y + NODE_HEIGHT)
  })

  it('places a merge node one level below its deeper parent, between the two topics it rejoins', () => {
    const layout = layoutGraph(build([
      [{ seq: 1, topics: ['a'] }],
      [{ seq: 2, topics: ['a'] }],
      [{ seq: 3, topics: ['b'] }],
      [{ seq: 4, topics: ['a', 'b'] }],
    ]))

    const deepParent = nodeOf(layout, 'n-2')
    const shallowParent = nodeOf(layout, 'n-3')
    const merged = nodeOf(layout, 'n-4')
    expect(deepParent.depth).toBe(1)
    expect(shallowParent.depth).toBe(0)
    expect(merged.depth).toBe(deepParent.depth + 1)
    expect(merged.y).toBe(2 * (NODE_HEIGHT + LEVEL_GAP))
    expect(merged.y).toBeGreaterThan(Math.max(deepParent.y, shallowParent.y))
    expect(layout.edges.filter((edge) => edge.to === 'n-4').map((edge) => edge.kind)).toEqual(['merge', 'merge'])
  })

  it('lands a merge between the boxes it rejoins', () => {
    const layout = layoutGraph(build([
      [{ seq: 1, topics: ['a'] }],
      [{ seq: 2, topics: ['a'] }],
      [{ seq: 3, topics: ['b'] }],
      [{ seq: 4, topics: ['b'] }],
      [{ seq: 5, topics: ['a', 'b'] }],
    ]))

    const first = centreOf(nodeOf(layout, 'n-2'))
    const second = centreOf(nodeOf(layout, 'n-4'))
    const merged = centreOf(nodeOf(layout, 'n-5'))
    expect(first).toBeLessThan(second)
    expect(merged).toBeGreaterThan(first)
    expect(merged).toBeLessThan(second)
    expect(nodeOf(layout, 'n-5').y).toBe(2 * (NODE_HEIGHT + LEVEL_GAP))
  })

  it('spreads a level of roots and keeps a lone child under the root it continues', () => {
    const layout = layoutGraph(build([
      [{ seq: 1, topics: ['a'] }],
      [{ seq: 2, topics: ['b'] }],
      [{ seq: 3, topics: ['c'] }],
      [{ seq: 4, topics: ['a'] }],
    ]))

    const rootLevel = layout.nodes.filter((node) => node.depth === 0)
    expect(rootLevel.map((node) => node.id)).toEqual(['n-1', 'n-2', 'n-3'])
    expect(rootLevel.map((node) => node.y)).toEqual([0, 0, 0])
    expect(rootLevel.map((node) => node.x)).toEqual([
      0,
      NODE_WIDTH + SIBLING_GAP,
      2 * (NODE_WIDTH + SIBLING_GAP),
    ])
    expect(layout.width).toBe(3 * NODE_WIDTH + 2 * SIBLING_GAP)

    const child = nodeOf(layout, 'n-4')
    expect(child.depth).toBe(1)
    expect(child.y).toBe(NODE_HEIGHT + LEVEL_GAP)
    expect(centreOf(child)).toBe(centreOf(nodeOf(layout, 'n-1')))
  })

  it('centres the siblings of one parent on that parent', () => {
    const layout = layoutGraph(build([
      [{ seq: 1, topics: ['a', 'b', 'c'] }],
      [{ seq: 2, topics: ['a'] }, { seq: 3, topics: ['b'] }, { seq: 4, topics: ['c'] }],
    ]))

    const parent = nodeOf(layout, 'n-1')
    expect(parent.depth).toBe(0)
    const children = layout.nodes.filter((node) => node.depth === 1)
    expect(children.map((node) => node.id)).toEqual(['n-2', 'n-3', 'n-4'])
    expect(children.map((node) => node.x)).toEqual([
      0,
      NODE_WIDTH + SIBLING_GAP,
      2 * (NODE_WIDTH + SIBLING_GAP),
    ])
    expect(centreOf(parent)).toBe(centreOf(nodeOf(layout, 'n-3')))
    expect(layout.width).toBe(3 * NODE_WIDTH + 2 * SIBLING_GAP)
  })

  it('keeps each branch under the parent it continues, not in seq order', () => {
    const layout = layoutGraph(build([
      [{ seq: 1, topics: ['a'] }],
      [{ seq: 2, topics: ['b'] }],
      [{ seq: 3, topics: ['b'] }],
      [{ seq: 4, topics: ['a'] }],
    ]))

    const leftRoot = nodeOf(layout, 'n-1')
    const rightRoot = nodeOf(layout, 'n-2')
    expect(centreOf(leftRoot)).toBeLessThan(centreOf(rightRoot))
    expect(nodeOf(layout, 'n-4').x).toBe(leftRoot.x)
    expect(nodeOf(layout, 'n-3').x).toBe(rightRoot.x)
  })

  it('honours size overrides for node dimensions and gaps', () => {
    const graph = build([
      [{ seq: 1, topics: ['a'] }],
      [{ seq: 2, topics: ['a'] }],
    ])
    const layout = layoutGraph(graph, { nodeWidth: 100, nodeHeight: 30, levelGap: 10, siblingGap: 4 })

    const parent = nodeOf(layout, 'n-1')
    const child = nodeOf(layout, 'n-2')
    expect(parent.width).toBe(100)
    expect(parent.height).toBe(30)
    expect(child.y - parent.y).toBe(40)
    expect(layout.width).toBe(100)
    expect(layout.height).toBe(70)
  })
})
