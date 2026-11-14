import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import {
  EMPTY_PROGRESS_GRAPH,
  applyAnalysis,
  latestNodeOf,
  nodeById,
  normalizeTopic,
  topicsOf,
  type AnalysisBatch,
  type ProgressGraph,
} from '../src/progress-graph.ts'
import {
  SESSION_TOPIC_DOMAIN,
  SESSION_TOPIC_TABLE,
  TOPIC_RECORD_VERSION,
  currentGraphOf,
  needsGraphMigration,
  sessionTopicDomainSpec,
  storedRecord,
  type LegacyTopicRecord,
  type LegacyV2TopicRecord,
  type TopicGraphRecord,
} from '../src/domain.ts'

const batch = (
  fromSeq: number,
  toSeq: number,
  turn: number,
  contributions: AnalysisBatch['contributions'] = [],
): AnalysisBatch => ({ fromSeq, toSeq, turn, contributions: [...contributions] })

const edgeKey = (e: { from: string; to: string }) => `${e.from}->${e.to}`
const sortedEdgeKeys = (g: ProgressGraph) => g.edges.map(edgeKey).sort()

describe('normalizeTopic', () => {
  it('去除首尾空白并把内部连续空白折叠为单个空格', () => {
    expect(normalizeTopic('  Model   Gate \t ')).toBe('model gate')
  })

  it('转为小写', () => {
    expect(normalizeTopic('API Design')).toBe('api design')
  })

  it('保留中文字符，仅处理空白与大小写', () => {
    expect(normalizeTopic('  主题   A ')).toBe('主题 a')
  })

  it('空白字符串归一化为空字符串', () => {
    expect(normalizeTopic('   ')).toBe('')
  })
})

describe('EMPTY_PROGRESS_GRAPH', () => {
  it('是已冻结的空图，checkpoint 为 -1，turn 为 0', () => {
    expect(Object.isFrozen(EMPTY_PROGRESS_GRAPH)).toBe(true)
    expect(EMPTY_PROGRESS_GRAPH.nodes).toEqual([])
    expect(EMPTY_PROGRESS_GRAPH.edges).toEqual([])
    expect(EMPTY_PROGRESS_GRAPH.checkpoint).toBe(-1)
    expect(EMPTY_PROGRESS_GRAPH.turn).toBe(0)
  })
})

describe('applyAnalysis', () => {
  it('单主题单贡献生成一个节点，id 使用 encodeURIComponent 编码，parents 为空', () => {
    const next = applyAnalysis(
      EMPTY_PROGRESS_GRAPH,
      batch(0, 1, 1, [{ seq: 1, turn: 1, topics: ['Model Gate'] }]),
    )

    expect(next.nodes).toHaveLength(1)
    const node = next.nodes[0]!
    expect(node.id).toBe('n-1#model%20gate')
    expect(node.seq).toBe(1)
    expect(node.turn).toBe(1)
    expect(node.topic).toBe('model gate')
    expect(node.parents).toEqual([])
    expect(next.edges).toEqual([])
    expect(next.checkpoint).toBe(1)
    expect(next.turn).toBe(1)
  })

  it('中文主题的 id 为 encodeURIComponent 后的归一化结果', () => {
    const next = applyAnalysis(
      EMPTY_PROGRESS_GRAPH,
      batch(0, 1, 1, [{ seq: 1, turn: 1, topics: ['主题 A'] }]),
    )
    expect(next.nodes[0]!.id).toBe('n-1#%E4%B8%BB%E9%A2%98%20a')
    expect(next.nodes[0]!.topic).toBe('主题 a')
  })

  it('同一 seq 推进多个主题时生成多个独立节点，且主题之间不连边', () => {
    const next = applyAnalysis(
      EMPTY_PROGRESS_GRAPH,
      batch(0, 1, 1, [{ seq: 1, turn: 1, topics: ['alpha', 'beta'] }]),
    )

    expect(next.nodes.map((n) => n.id)).toEqual(['n-1#alpha', 'n-1#beta'])
    expect(next.nodes.every((n) => n.parents.length === 0)).toBe(true)
    expect(next.edges).toEqual([])
  })

  it('同一主题跨 seq 时，后续节点仅连接同主题最新前序节点', () => {
    const g1 = applyAnalysis(
      EMPTY_PROGRESS_GRAPH,
      batch(0, 1, 1, [{ seq: 1, turn: 1, topics: ['alpha'] }]),
    )
    const g2 = applyAnalysis(
      g1,
      batch(1, 2, 2, [{ seq: 2, turn: 2, topics: ['alpha'] }]),
    )
    const g3 = applyAnalysis(
      g2,
      batch(2, 3, 3, [{ seq: 3, turn: 3, topics: ['alpha'] }]),
    )

    expect(g3.nodes.map((n) => n.id)).toEqual(['n-1#alpha', 'n-2#alpha', 'n-3#alpha'])
    expect(nodeById(g3, 'n-2#alpha')!.parents).toEqual(['n-1#alpha'])
    expect(nodeById(g3, 'n-3#alpha')!.parents).toEqual(['n-2#alpha'])
    expect(sortedEdgeKeys(g3)).toEqual(['n-1#alpha->n-2#alpha', 'n-2#alpha->n-3#alpha'])
    expect(g3.edges.every((e) => e.kind === 'branch')).toBe(true)
  })

  it('不同主题之间不互连，不产生跨主题边或 merge 节点', () => {
    const g1 = applyAnalysis(
      EMPTY_PROGRESS_GRAPH,
      batch(0, 1, 1, [{ seq: 1, turn: 1, topics: ['alpha'] }]),
    )
    const g2 = applyAnalysis(
      g1,
      batch(1, 2, 2, [{ seq: 2, turn: 2, topics: ['beta', 'alpha'] }]),
    )

    expect(nodeById(g2, 'n-2#beta')!.parents).toEqual([])
    expect(nodeById(g2, 'n-2#alpha')!.parents).toEqual(['n-1#alpha'])
    expect(g2.edges).toHaveLength(1)
    expect(g2.edges[0]).toEqual({ from: 'n-1#alpha', to: 'n-2#alpha', kind: 'branch' })
  })

  it('丢弃空字符串主题并对同一贡献内的主题去重（保持首次出现顺序）', () => {
    const next = applyAnalysis(
      EMPTY_PROGRESS_GRAPH,
      batch(0, 1, 1, [
        { seq: 1, turn: 1, topics: ['  ', 'Beta', 'alpha', 'BETA', ' alpha  '] },
      ]),
    )
    expect(next.nodes.map((n) => n.id)).toEqual(['n-1#beta', 'n-1#alpha'])
    expect(next.nodes.map((n) => n.topic)).toEqual(['beta', 'alpha'])
  })

  it('节点按 seq 升序排列，同一 seq 内保持主题出现顺序', () => {
    const next = applyAnalysis(
      EMPTY_PROGRESS_GRAPH,
      batch(0, 3, 3, [
        { seq: 1, turn: 1, topics: ['gamma'] },
        { seq: 2, turn: 2, topics: ['beta', 'alpha'] },
        { seq: 3, turn: 3, topics: ['alpha'] },
      ]),
    )
    expect(next.nodes.map((n) => n.id)).toEqual([
      'n-1#gamma',
      'n-2#beta',
      'n-2#alpha',
      'n-3#alpha',
    ])
    expect(nodeById(next, 'n-3#alpha')!.parents).toEqual(['n-2#alpha'])
  })

  it('parents 绝不包含节点自身', () => {
    const next = applyAnalysis(
      EMPTY_PROGRESS_GRAPH,
      batch(0, 2, 2, [
        { seq: 1, turn: 1, topics: ['alpha', 'alpha'] },
        { seq: 2, turn: 2, topics: ['alpha'] },
      ]),
    )
    for (const node of next.nodes) {
      expect(node.parents).not.toContain(node.id)
    }
  })

  it('同一 (seq, topic) 不会重复建节点', () => {
    const g1 = applyAnalysis(
      EMPTY_PROGRESS_GRAPH,
      batch(0, 1, 1, [{ seq: 1, turn: 1, topics: ['alpha'] }]),
    )
    const g2 = applyAnalysis(
      g1,
      batch(1, 1, 1, [{ seq: 1, turn: 1, topics: ['alpha'] }]),
    )
    expect(g2.nodes.filter((n) => n.id === 'n-1#alpha')).toHaveLength(1)
  })

  it('空 contributions 仅推进 checkpoint 与 turn，保留既有 nodes 和 edges', () => {
    const g1 = applyAnalysis(
      EMPTY_PROGRESS_GRAPH,
      batch(0, 1, 1, [{ seq: 1, turn: 1, topics: ['alpha'] }]),
    )
    const g2 = applyAnalysis(
      g1,
      batch(1, 5, 4, [{ seq: 5, turn: 4, topics: [] }]),
    )

    expect(g2.checkpoint).toBe(5)
    expect(g2.turn).toBe(4)
    expect(g2.nodes).toEqual(g1.nodes)
    expect(g2.edges).toEqual(g1.edges)
  })

  it('幂等重放：toSeq <= checkpoint 时原样返回同一引用', () => {
    const g1 = applyAnalysis(
      EMPTY_PROGRESS_GRAPH,
      batch(0, 2, 2, [{ seq: 2, turn: 2, topics: ['alpha'] }]),
    )
    const replay = applyAnalysis(
      g1,
      batch(0, 2, 2, [{ seq: 2, turn: 2, topics: ['alpha', 'beta'] }]),
    )
    expect(replay).toBe(g1)

    const older = applyAnalysis(g1, batch(0, 1, 1, [{ seq: 1, turn: 1, topics: ['gamma'] }]))
    expect(older).toBe(g1)
  })

  it('不修改入参 graph 与 batch', () => {
    const g1 = applyAnalysis(
      EMPTY_PROGRESS_GRAPH,
      batch(0, 1, 1, [{ seq: 1, turn: 1, topics: ['alpha'] }]),
    )
    const snapshotGraph = JSON.stringify(g1)
    const b = batch(1, 2, 2, [{ seq: 2, turn: 2, topics: ['alpha', 'beta'] }])
    const snapshotBatch = JSON.stringify(b)

    applyAnalysis(g1, b)

    expect(JSON.stringify(g1)).toBe(snapshotGraph)
    expect(JSON.stringify(b)).toBe(snapshotBatch)
  })

  it('返回的 graph、nodes、edges 与每个节点的 parents 均已冻结', () => {
    const next = applyAnalysis(
      EMPTY_PROGRESS_GRAPH,
      batch(0, 2, 2, [
        { seq: 1, turn: 1, topics: ['alpha'] },
        { seq: 2, turn: 2, topics: ['alpha'] },
      ]),
    )
    expect(Object.isFrozen(next)).toBe(true)
    expect(Object.isFrozen(next.nodes)).toBe(true)
    expect(Object.isFrozen(next.edges)).toBe(true)
    for (const node of next.nodes) {
      expect(Object.isFrozen(node.parents)).toBe(true)
    }
    for (const edge of next.edges) {
      expect(Object.isFrozen(edge)).toBe(true)
    }
  })
})

describe('latestNodeOf', () => {
  const graph = applyAnalysis(
    EMPTY_PROGRESS_GRAPH,
    batch(0, 3, 3, [
      { seq: 1, turn: 1, topics: ['alpha'] },
      { seq: 2, turn: 2, topics: ['beta'] },
      { seq: 3, turn: 3, topics: ['alpha'] },
    ]),
  )

  it('返回同一主题中 seq 最大的节点', () => {
    expect(latestNodeOf(graph, 'alpha')!.id).toBe('n-3#alpha')
  })

  it('对输入主题先做归一化再查找', () => {
    expect(latestNodeOf(graph, '  ALPHA ')!.id).toBe('n-3#alpha')
  })

  it('主题不存在时返回 undefined', () => {
    expect(latestNodeOf(graph, 'missing')).toBeUndefined()
  })

  it('空图返回 undefined', () => {
    expect(latestNodeOf(EMPTY_PROGRESS_GRAPH, 'alpha')).toBeUndefined()
  })
})

describe('topicsOf', () => {
  it('按首次出现顺序返回去重后的主题列表', () => {
    const graph = applyAnalysis(
      EMPTY_PROGRESS_GRAPH,
      batch(0, 3, 3, [
        { seq: 1, turn: 1, topics: ['beta'] },
        { seq: 2, turn: 2, topics: ['alpha', 'beta'] },
        { seq: 3, turn: 3, topics: ['gamma', 'alpha'] },
      ]),
    )
    expect(topicsOf(graph)).toEqual(['beta', 'alpha', 'gamma'])
  })

  it('空图返回空数组', () => {
    expect(topicsOf(EMPTY_PROGRESS_GRAPH)).toEqual([])
  })
})

describe('nodeById', () => {
  const graph = applyAnalysis(
    EMPTY_PROGRESS_GRAPH,
    batch(0, 1, 1, [{ seq: 1, turn: 1, topics: ['主题 A'] }]),
  )

  it('按精确 id 查找节点', () => {
    const node = nodeById(graph, 'n-1#%E4%B8%BB%E9%A2%98%20a')
    expect(node).toBeDefined()
    expect(node!.topic).toBe('主题 a')
  })

  it('找不到时返回 undefined（不做归一化或模糊匹配）', () => {
    expect(nodeById(graph, 'n-1#主题 a')).toBeUndefined()
    expect(nodeById(graph, 'n-9#missing')).toBeUndefined()
  })
})

describe('domain: 常量与领域表', () => {
  it('导出的版本与表名常量符合契约', () => {
    expect(TOPIC_RECORD_VERSION).toBe(3)
    expect(SESSION_TOPIC_DOMAIN).toBe('session_topic_map')
    expect(SESSION_TOPIC_TABLE).toBe('graphs')
  })

  it('sessionTopicDomainSpec 可在内存 storage 桩下打开、读写 v3 / v2 / v1 记录', async () => {
    const tables = new Map<string, Map<string, unknown>>()
    const unit = {
      loadAll: async () => ({
        tables: Object.fromEntries(
          [...tables].map(([table, records]) => [table, Object.fromEntries(records)]),
        ),
        global: null as unknown,
      }),
      pushRecord: async (table: string, key: string, value: unknown) => {
        const records = tables.get(table) ?? new Map<string, unknown>()
        tables.set(table, records)
        records.set(key, value)
      },
      putRecord: async (table: string, key: string, value: unknown) => {
        const records = tables.get(table) ?? new Map<string, unknown>()
        tables.set(table, records)
        records.set(key, value)
      },
      deleteRecord: async (table: string, key: string) => {
        tables.get(table)?.delete(key)
      },
      setGlobal: async () => {},
      close: async () => {},
    }
    const ctx = new Context()
    ctx.provide('storage', {
      backend: { get: () => ({ kv: { open: async () => unit }, close: async () => {} }) },
    } as never)
    const facility = new DomainFacility(ctx, { backend: 'test' })
    const domain = await facility.open(sessionTopicDomainSpec)
    try {
      const table = domain.table(SESSION_TOPIC_TABLE)

      const graph = applyAnalysis(
        EMPTY_PROGRESS_GRAPH,
        batch(0, 2, 2, [
          { seq: 1, turn: 1, topics: ['alpha'] },
          { seq: 2, turn: 2, topics: ['alpha', 'beta'] },
        ]),
      )
      const v3 = storedRecord(graph, '2026-01-01T00:00:00.000Z')
      await table.put('session-v3', v3)
      const readV3 = table.get('session-v3')
      expect(readV3).toBeDefined()
      expect(currentGraphOf(readV3)).toEqual(graph)
      expect(needsGraphMigration(readV3)).toBe(false)

      const v2: LegacyV2TopicRecord = {
        schemaVersion: 2,
        graph: { nodes: [], edges: [], checkpoint: 5, turn: 2 },
        updatedAt: 'now',
      }
      await table.put('session-v2', v2)
      const readV2 = table.get('session-v2')
      expect(needsGraphMigration(readV2)).toBe(true)
      const migrated = currentGraphOf(readV2)
      expect(migrated!.checkpoint).toBe(5)
      expect(migrated!.turn).toBe(2)

      const v1: LegacyTopicRecord = {
        graph: { nodes: [], edges: [], checkpoint: 3, turn: 1 },
        updatedAt: 'now',
      }
      await table.put('session-v1', v1)
      const readV1 = table.get('session-v1')
      expect(needsGraphMigration(readV1)).toBe(false)
      expect(currentGraphOf(readV1)).toBeNull()
    } finally {
      await domain.close()
    }
  })
})

describe('domain: storedRecord', () => {
  const graph = applyAnalysis(
    EMPTY_PROGRESS_GRAPH,
    batch(0, 2, 2, [
      { seq: 1, turn: 1, topics: ['alpha'] },
      { seq: 2, turn: 2, topics: ['alpha', 'beta'] },
    ]),
  )

  it('序列化为 schemaVersion 3 记录，默认 turnsVerified 为 true', () => {
    const record = storedRecord(graph, '2026-01-01T00:00:00.000Z')
    expect(record.schemaVersion).toBe(3)
    expect(record.updatedAt).toBe('2026-01-01T00:00:00.000Z')
    expect(record.turnsVerified).toBe(true)
    expect(record.graph.checkpoint).toBe(graph.checkpoint)
    expect(record.graph.turn).toBe(graph.turn)
    expect(record.graph.nodes).toEqual(graph.nodes)
    expect(record.graph.edges).toEqual(graph.edges)
  })

  it('支持显式传入 turnsVerified = false', () => {
    const record = storedRecord(graph, '2026-01-01T00:00:00.000Z', false)
    expect(record.turnsVerified).toBe(false)
  })

  it('生成独立的深拷贝数组，不与输入共享可变引用', () => {
    const record = storedRecord(graph, '2026-01-01T00:00:00.000Z')
    expect(record.graph.nodes).not.toBe(graph.nodes)
    expect(record.graph.edges).not.toBe(graph.edges)
    const node = record.graph.nodes[1]!
    expect(node.parents).not.toBe(graph.nodes[1]!.parents)
  })
})

describe('domain: needsGraphMigration', () => {
  const v3: TopicGraphRecord = storedRecord(EMPTY_PROGRESS_GRAPH, 'now')
  const v2: LegacyV2TopicRecord = {
    schemaVersion: 2,
    graph: { nodes: [], edges: [], checkpoint: 0, turn: 0 },
    updatedAt: 'now',
  }
  const v1: LegacyTopicRecord = {
    graph: { nodes: [], edges: [], checkpoint: 0, turn: 0 },
    updatedAt: 'now',
  }

  it('仅对 v2 记录返回 true', () => {
    expect(needsGraphMigration(v2)).toBe(true)
  })

  it('对 undefined、v3 与 v1 记录返回 false', () => {
    expect(needsGraphMigration(undefined)).toBe(false)
    expect(needsGraphMigration(v3)).toBe(false)
    expect(needsGraphMigration(v1)).toBe(false)
  })
})

describe('domain: currentGraphOf', () => {
  it('undefined 返回 null', () => {
    expect(currentGraphOf(undefined)).toBeNull()
  })

  it('v3 记录直接返回其 graph', () => {
    const graph = applyAnalysis(
      EMPTY_PROGRESS_GRAPH,
      batch(0, 1, 1, [{ seq: 1, turn: 1, topics: ['alpha'] }]),
    )
    const record = storedRecord(graph, 'now')
    expect(currentGraphOf(record)).toBe(record.graph)
  })

  it('v1 旧记录返回 null', () => {
    const v1: LegacyTopicRecord = {
      schemaVersion: 1,
      graph: { nodes: [{ id: 'legacy' }], edges: [], checkpoint: 3, turn: 2 },
      updatedAt: 'now',
    }
    expect(currentGraphOf(v1)).toBeNull()
  })

  it('空节点的 v2 图迁移后完整保留 checkpoint 与 turn', () => {
    const v2: LegacyV2TopicRecord = {
      schemaVersion: 2,
      graph: { nodes: [], edges: [], checkpoint: 5, turn: 2 },
      updatedAt: 'now',
    }
    const graph = currentGraphOf(v2)
    expect(graph).not.toBeNull()
    expect(graph!.nodes).toEqual([])
    expect(graph!.edges).toEqual([])
    expect(graph!.checkpoint).toBe(5)
    expect(graph!.turn).toBe(2)
  })

  it('v2 迁移：按 seq 排序、拆分 topics、丢弃 merge 连接并按同主题重建 branch 边', () => {
    const v2: LegacyV2TopicRecord = {
      schemaVersion: 2,
      graph: {
        nodes: [
          { id: 'x', seq: 2, turn: 2, topics: ['Alpha', 'Beta'], parents: ['y'] },
          { id: 'y', seq: 1, turn: 1, topics: ['alpha', ' '], parents: [] },
          { id: 'z', seq: 3, turn: 3, topics: ['beta', 'ALPHA'], parents: ['x', 'y'] },
        ],
        edges: [
          { from: 'y', to: 'x', kind: 'branch' },
          { from: 'x', to: 'z', kind: 'merge' },
          { from: 'y', to: 'z', kind: 'merge' },
        ],
        checkpoint: 3,
        turn: 3,
      },
      updatedAt: 'now',
    }

    const graph = currentGraphOf(v2)!

    expect(graph.checkpoint).toBe(3)
    expect(graph.turn).toBe(3)
    expect(graph.nodes.map((n) => n.id)).toEqual([
      'n-1#alpha',
      'n-2#alpha',
      'n-2#beta',
      'n-3#beta',
      'n-3#alpha',
    ])
    expect(graph.nodes.map((n) => n.seq)).toEqual([1, 2, 2, 3, 3])
    expect(nodeById(graph, 'n-1#alpha')!.parents).toEqual([])
    expect(nodeById(graph, 'n-2#alpha')!.parents).toEqual(['n-1#alpha'])
    expect(nodeById(graph, 'n-2#beta')!.parents).toEqual([])
    expect(nodeById(graph, 'n-3#beta')!.parents).toEqual(['n-2#beta'])
    expect(nodeById(graph, 'n-3#alpha')!.parents).toEqual(['n-2#alpha'])
    expect(sortedEdgeKeys(graph)).toEqual([
      'n-1#alpha->n-2#alpha',
      'n-2#alpha->n-3#alpha',
      'n-2#beta->n-3#beta',
    ])
    expect(graph.edges.every((e) => e.kind === 'branch')).toBe(true)
    expect(graph.edges.some((e) => e.from === 'x' || e.to === 'z')).toBe(false)
  })
})