import { describe, expect, it } from 'vitest'
import {
  EMPTY_PROGRESS_GRAPH,
  applyAnalysis,
  topicsOf,
  type AnalysisBatch,
  type ProgressGraph,
} from '../src/progress-graph.ts'
import {
  LEVEL_GAP,
  NODE_HEIGHT,
  NODE_WIDTH,
  SIBLING_GAP,
  layoutGraph,
  type GraphLayout,
  type LaidOutNode,
} from '../src/client/graph-layout.ts'

type Step = readonly { readonly seq: number; readonly topics: readonly string[] }[]

// 每一步代表一次回复（一个 batch），同一步内的多条 contribution 共享同一回复。
function build(steps: readonly Step[]): ProgressGraph {
  let graph = EMPTY_PROGRESS_GRAPH
  for (const step of steps) {
    const toSeq = Math.max(...step.map((item) => item.seq))
    const batch: AnalysisBatch = {
      fromSeq: graph.checkpoint + 1,
      toSeq,
      turn: toSeq,
      contributions: step.map((item) => ({ seq: item.seq, turn: item.seq, topics: item.topics })),
    }
    graph = applyAnalysis(graph, batch)
  }
  return graph
}

function nodeOf(layout: GraphLayout, id: string): LaidOutNode {
  const node = layout.nodes.find((candidate) => candidate.id === id)
  if (!node) throw new Error(`missing laid out node ${id}`)
  return node
}

function edgeKeys(layout: GraphLayout): string[] {
  return layout.edges.map((edge) => `${edge.from}->${edge.to}`).sort()
}

const ROW_STEP = NODE_HEIGHT + LEVEL_GAP
const LANE_STEP = NODE_WIDTH + SIBLING_GAP

describe('graph layout: 空图与默认常量', () => {
  it('空图返回零尺寸、无节点、无边', () => {
    expect(layoutGraph(EMPTY_PROGRESS_GRAPH)).toEqual({ width: 0, height: 0, nodes: [], edges: [] })
  })

  it('导出的默认几何常量为 136 / 46 / 48 / 16', () => {
    expect(NODE_WIDTH).toBe(136)
    expect(NODE_HEIGHT).toBe(46)
    expect(LEVEL_GAP).toBe(48)
    expect(SIBLING_GAP).toBe(16)
  })
})

describe('graph layout: 单节点', () => {
  it('单节点位于原点且字段完整', () => {
    const layout = layoutGraph(build([[{ seq: 1, topics: ['a'] }]]))

    expect(layout.nodes).toHaveLength(1)
    expect(layout.nodes[0]).toMatchObject({
      id: 'n-1#a',
      seq: 1,
      topic: 'a',
      topics: ['a'],
      row: 0,
      lane: 0,
      depth: 0,
      x: 0,
      y: 0,
      width: NODE_WIDTH,
      height: NODE_HEIGHT,
    })
    expect(layout.edges).toEqual([])
    expect(layout.width).toBe(NODE_WIDTH)
    expect(layout.height).toBe(NODE_HEIGHT)
  })

  it('节点的 turn 与图中节点一致', () => {
    const graph = build([[{ seq: 3, topics: ['a'] }]])
    const layout = layoutGraph(graph)
    expect(layout.nodes[0]?.turn).toBe(graph.nodes[0]?.turn)
  })
})

describe('graph layout: 行映射', () => {
  it('非连续 seq 去重升序映射到连续 row，不留空行', () => {
    const layout = layoutGraph(build([
      [{ seq: 1, topics: ['a'] }],
      [{ seq: 5, topics: ['a'] }],
      [{ seq: 9, topics: ['b'] }],
    ]))

    expect(nodeOf(layout, 'n-1#a')).toMatchObject({ row: 0, depth: 0, y: 0 })
    expect(nodeOf(layout, 'n-5#a')).toMatchObject({ row: 1, depth: 1, y: ROW_STEP })
    expect(nodeOf(layout, 'n-9#b')).toMatchObject({ row: 2, depth: 2, y: 2 * ROW_STEP })
    expect(layout.height).toBe(3 * NODE_HEIGHT + 2 * LEVEL_GAP)
  })

  it('同一 seq 的多个节点共享 row 与 y', () => {
    const layout = layoutGraph(build([
      [{ seq: 1, topics: ['a'] }],
      [{ seq: 4, topics: ['a', 'b', 'c'] }],
    ]))

    const rowNodes = layout.nodes.filter((node) => node.seq === 4)
    expect(rowNodes.map((node) => node.row)).toEqual([1, 1, 1])
    expect(rowNodes.map((node) => node.y)).toEqual([ROW_STEP, ROW_STEP, ROW_STEP])
  })
})

describe('graph layout: 同一回复内的多主题', () => {
  it('同一 seq 推进多个主题时位于同一行、按 topicsOf 顺序占据不同固定 lane', () => {
    const graph = build([
      [{ seq: 1, topics: ['a', 'b'] }],
      [{ seq: 2, topics: ['a', 'b'] }],
    ])
    const layout = layoutGraph(graph)
    const order = topicsOf(graph)
    expect(order).toEqual(['a', 'b'])

    const laneA = nodeOf(layout, 'n-2#a')
    const laneB = nodeOf(layout, 'n-2#b')
    expect(laneA).toMatchObject({ row: 1, lane: 0, x: 0, y: ROW_STEP, topic: 'a', topics: ['a'] })
    expect(laneB).toMatchObject({ row: 1, lane: 1, x: LANE_STEP, y: ROW_STEP, topic: 'b', topics: ['b'] })
    expect(laneB.x - laneA.x).toBe(NODE_WIDTH + SIBLING_GAP)
    expect(laneA.y).toBe(laneB.y)
  })

  it('同一回复中的兄弟节点互不重叠', () => {
    const layout = layoutGraph(build([
      [{ seq: 1, topics: ['a', 'b', 'c'] }],
    ]))

    const sorted = [...layout.nodes].sort((left, right) => left.x - right.x)
    for (let index = 1; index < sorted.length; index += 1) {
      const previous = sorted[index - 1]!
      const current = sorted[index]!
      expect(current.x - previous.x).toBeGreaterThanOrEqual(NODE_WIDTH)
    }
  })

  it('同一回复内的主题之间不产生边', () => {
    const layout = layoutGraph(build([
      [{ seq: 1, topics: ['a', 'b'] }],
      [{ seq: 2, topics: ['a', 'b'] }],
    ]))

    for (const edge of layout.edges) {
      const fromTopic = nodeOf(layout, edge.from).topic
      const toTopic = nodeOf(layout, edge.to).topic
      expect(fromTopic).toBe(toTopic)
    }
    expect([...new Set(edgeKeys(layout))]).toEqual(['n-1#a->n-2#a', 'n-1#b->n-2#b'])
  })
})

describe('graph layout: 主题跨行续接', () => {
  it('同一主题跨 seq 续接时保持固定 lane 与 x，y 随 row 递增', () => {
    const layout = layoutGraph(build([
      [{ seq: 1, topics: ['a'] }],
      [{ seq: 2, topics: ['a'] }],
      [{ seq: 3, topics: ['a'] }],
    ]))

    const chain = ['n-1#a', 'n-2#a', 'n-3#a'].map((id) => nodeOf(layout, id))
    expect(chain.map((node) => node.lane)).toEqual([0, 0, 0])
    expect(chain.map((node) => node.x)).toEqual([0, 0, 0])
    expect(chain.map((node) => node.y)).toEqual([0, ROW_STEP, 2 * ROW_STEP])
    expect(edgeKeys(layout)).toEqual(['n-1#a->n-2#a', 'n-2#a->n-3#a'])
  })

  it('中间穿插其他主题与跳号时，续接节点仍保持原 lane 与 x', () => {
    const layout = layoutGraph(build([
      [{ seq: 1, topics: ['a'] }],
      [{ seq: 2, topics: ['b'] }],
      [{ seq: 3, topics: ['c'] }],
      [{ seq: 7, topics: ['a'] }],
    ]))

    const first = nodeOf(layout, 'n-1#a')
    const resumed = nodeOf(layout, 'n-7#a')
    expect(resumed.lane).toBe(first.lane)
    expect(resumed.x).toBe(first.x)
    expect(resumed.row).toBe(3)
    expect(resumed.y).toBe(3 * ROW_STEP)
    expect(edgeKeys(layout)).toContain('n-1#a->n-7#a')
  })

  it('多主题分叉后同一回复再次共同出现时各自独立，同一 y、各自 lane，且无 merge 边', () => {
    const layout = layoutGraph(build([
      [{ seq: 1, topics: ['a', 'b'] }],
      [{ seq: 2, topics: ['a'] }],
      [{ seq: 3, topics: ['b'] }],
      [{ seq: 4, topics: ['a', 'b'] }],
    ]))

    const againA = nodeOf(layout, 'n-4#a')
    const againB = nodeOf(layout, 'n-4#b')
    expect(againA.y).toBe(againB.y)
    expect(againA.y).toBe(3 * ROW_STEP)
    expect(againA).toMatchObject({ lane: 0, x: 0, topic: 'a' })
    expect(againB).toMatchObject({ lane: 1, x: LANE_STEP, topic: 'b' })
    expect(layout.nodes.filter((node) => node.seq === 4)).toHaveLength(2)
    expect(edgeKeys(layout)).toEqual([
      'n-1#a->n-2#a',
      'n-1#b->n-3#b',
      'n-2#a->n-4#a',
      'n-3#b->n-4#b',
    ])
    expect(layout.edges.every((edge) => edge.kind === 'branch')).toBe(true)
  })
})

describe('graph layout: 边过滤', () => {
  it('输入中被强塞的 merge 边与跨主题边都被过滤，输出只含同主题 branch 边', () => {
    const base = build([
      [{ seq: 1, topics: ['a', 'b'] }],
      [{ seq: 2, topics: ['a', 'b'] }],
    ])
    const tainted = {
      ...base,
      edges: [
        ...base.edges,
        { from: 'n-1#a', to: 'n-2#a', kind: 'merge' },
        { from: 'n-1#b', to: 'n-2#a', kind: 'merge' },
        { from: 'n-1#a', to: 'n-2#b', kind: 'branch' },
      ],
    } as unknown as ProgressGraph

    const layout = layoutGraph(tainted)

    expect(layout.edges.some((edge) => (edge.kind as string) === 'merge')).toBe(false)
    expect(JSON.stringify(layout)).not.toContain('merge')
    for (const edge of layout.edges) {
      expect(edge.kind).toBe('branch')
      expect(nodeOf(layout, edge.from).topic).toBe(nodeOf(layout, edge.to).topic)
    }
    expect([...new Set(edgeKeys(layout))]).toEqual(['n-1#a->n-2#a', 'n-1#b->n-2#b'])
  })
})

describe('graph layout: SVG path 契约', () => {
  it('默认参数下 path 为从父节点底边中点到子节点顶边中点的三次贝塞尔', () => {
    const layout = layoutGraph(build([
      [{ seq: 1, topics: ['a'] }],
      [{ seq: 2, topics: ['a'] }],
    ]))

    const edge = layout.edges[0]
    expect(edge).toMatchObject({ from: 'n-1#a', to: 'n-2#a', kind: 'branch' })
    // x1 = 0 + 68 = 68, y1 = 46, y2 = 94, bend = max(16, 24) = 24
    expect(edge?.path).toBe('M 68 46 C 68 70 68 70 68 94')
  })

  it('bend 下限为 16：层间距很小时控制点偏移取 16', () => {
    const layout = layoutGraph(build([
      [{ seq: 1, topics: ['a'] }],
      [{ seq: 2, topics: ['a'] }],
    ]), { nodeWidth: 100, nodeHeight: 30, levelGap: 10, siblingGap: 4 })

    // x1 = 50, y1 = 30, y2 = 40, diff = 10, bend = max(16, 5) = 16
    expect(layout.edges[0]?.path).toBe('M 50 30 C 50 46 50 24 50 40')
  })

  it('同主题边的起点与终点 x 相同（垂直直线）', () => {
    const layout = layoutGraph(build([
      [{ seq: 1, topics: ['a', 'b'] }],
      [{ seq: 2, topics: ['b'] }],
      [{ seq: 3, topics: ['a', 'b'] }],
    ]))

    for (const edge of layout.edges) {
      const numbers = (edge.path.match(/-?\d+(\.\d+)?/g) ?? []).map(Number)
      expect(numbers).toHaveLength(8)
      expect(numbers[0]).toBe(numbers[2])
      expect(numbers[0]).toBe(numbers[4])
      expect(numbers[4]).toBe(numbers[6])
      expect(edge.path.startsWith('M ')).toBe(true)
      expect(edge.path).toContain(' C ')
    }
  })
})

describe('graph layout: LayoutOptions 覆盖', () => {
  it('nodeWidth/nodeHeight/levelGap/siblingGap 同时影响节点、坐标、边路径与总尺寸', () => {
    const graph = build([
      [{ seq: 1, topics: ['a', 'b'] }],
      [{ seq: 2, topics: ['a'] }],
    ])
    const layout = layoutGraph(graph, { nodeWidth: 100, nodeHeight: 30, levelGap: 10, siblingGap: 4 })

    const a1 = nodeOf(layout, 'n-1#a')
    const b1 = nodeOf(layout, 'n-1#b')
    const a2 = nodeOf(layout, 'n-2#a')
    expect(a1).toMatchObject({ width: 100, height: 30, x: 0, y: 0 })
    expect(b1).toMatchObject({ width: 100, height: 30, x: 104, y: 0 })
    expect(a2).toMatchObject({ width: 100, height: 30, x: 0, y: 40 })
    expect(layout.width).toBe(2 * 100 + 4)
    expect(layout.height).toBe(2 * 30 + 10)
    expect(layout.edges[0]?.path).toBe('M 50 30 C 50 46 50 24 50 40')
  })

  it('部分覆盖时未指定的选项回退到默认值', () => {
    const layout = layoutGraph(build([[{ seq: 1, topics: ['a'] }]]), { nodeWidth: 200 })

    expect(layout.nodes[0]).toMatchObject({ width: 200, height: NODE_HEIGHT })
    expect(layout.width).toBe(200)
    expect(layout.height).toBe(NODE_HEIGHT)
  })
})
