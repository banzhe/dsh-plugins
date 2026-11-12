import { describe, expect, it } from 'vitest'
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

function batch(fromSeq: number, toSeq: number, turn: number, contributions: AnalysisBatch['contributions']): AnalysisBatch {
  return { fromSeq, toSeq, turn, contributions }
}

describe('progress graph', () => {
  it('creates one node per reply, and a reply with two topics is a single node', () => {
    const graph = applyAnalysis(EMPTY_PROGRESS_GRAPH, batch(1, 4, 1, [
      { seq: 3, turn: 1, topics: ['a', 'b'] },
    ]))

    expect(graph.nodes).toHaveLength(1)
    expect(graph.nodes[0]).toMatchObject({ id: 'n-3', seq: 3, turn: 1, topics: ['a', 'b'], parents: [] })
    expect(graph.edges).toEqual([])
    expect(graph.checkpoint).toBe(4)
    expect(graph.turn).toBe(1)
  })

  it('links a later reply continuing only topic A from A latest node as a branch', () => {
    const first = applyAnalysis(EMPTY_PROGRESS_GRAPH, batch(1, 2, 1, [{ seq: 1, turn: 1, topics: ['a'] }]))
    const second = applyAnalysis(first, batch(3, 4, 1, [{ seq: 3, turn: 1, topics: ['a'] }]))

    expect(second.nodes.map((node) => node.id)).toEqual(['n-1', 'n-3'])
    expect(second.nodes[1]?.parents).toEqual(['n-1'])
    expect(second.edges).toEqual([{ from: 'n-1', to: 'n-3', kind: 'branch' }])
  })

  it('links a reply continuing A and B together from both latest nodes as two merge edges, still one node', () => {
    let graph = applyAnalysis(EMPTY_PROGRESS_GRAPH, batch(1, 2, 1, [{ seq: 1, turn: 1, topics: ['a'] }]))
    graph = applyAnalysis(graph, batch(3, 4, 1, [{ seq: 3, turn: 1, topics: ['b'] }]))
    graph = applyAnalysis(graph, batch(5, 6, 1, [{ seq: 5, turn: 1, topics: ['a', 'b'] }]))

    const merged = nodeById(graph, 'n-5')
    expect(graph.nodes).toHaveLength(3)
    expect(merged?.topics).toEqual(['a', 'b'])
    expect(merged?.parents).toEqual(['n-1', 'n-3'])
    const mergeEdges = graph.edges.filter((edge) => edge.to === 'n-5')
    expect(mergeEdges).toHaveLength(2)
    expect(mergeEdges.every((edge) => edge.kind === 'merge')).toBe(true)
    expect(mergeEdges.map((edge) => edge.from).sort()).toEqual(['n-1', 'n-3'])
  })

  it('lets A and B be continued separately after a merge', () => {
    let graph = applyAnalysis(EMPTY_PROGRESS_GRAPH, batch(1, 2, 1, [{ seq: 1, turn: 1, topics: ['a'] }]))
    graph = applyAnalysis(graph, batch(3, 4, 1, [{ seq: 3, turn: 1, topics: ['b'] }]))
    graph = applyAnalysis(graph, batch(5, 6, 1, [{ seq: 5, turn: 1, topics: ['a', 'b'] }]))
    graph = applyAnalysis(graph, batch(7, 8, 1, [{ seq: 7, turn: 1, topics: ['a'] }]))
    graph = applyAnalysis(graph, batch(9, 10, 1, [{ seq: 9, turn: 1, topics: ['b'] }]))

    expect(nodeById(graph, 'n-7')?.parents).toEqual(['n-5'])
    expect(nodeById(graph, 'n-9')?.parents).toEqual(['n-5'])
    expect(graph.edges).toContainEqual({ from: 'n-5', to: 'n-7', kind: 'branch' })
    expect(graph.edges).toContainEqual({ from: 'n-5', to: 'n-9', kind: 'branch' })
  })

  it('advances the checkpoint only when the contribution list is empty', () => {
    const first = applyAnalysis(EMPTY_PROGRESS_GRAPH, batch(1, 2, 1, [{ seq: 1, turn: 1, topics: ['a'] }]))
    const empty = applyAnalysis(first, batch(3, 6, 2, []))

    expect(empty.nodes).toEqual(first.nodes)
    expect(empty.edges).toEqual(first.edges)
    expect(empty.checkpoint).toBe(6)
    expect(empty.turn).toBe(2)
  })

  it('returns the same object when a replayed range is already covered', () => {
    const graph = applyAnalysis(EMPTY_PROGRESS_GRAPH, batch(1, 5, 1, [{ seq: 2, turn: 1, topics: ['a'] }]))
    const replay = applyAnalysis(graph, batch(1, 5, 1, [{ seq: 2, turn: 1, topics: ['a'] }]))

    expect(replay).toBe(graph)
  })

  it('keeps the graph identical when analysis is never applied (failed or cancelled run)', () => {
    const graph = applyAnalysis(EMPTY_PROGRESS_GRAPH, batch(1, 2, 1, [{ seq: 1, turn: 1, topics: ['a'] }]))
    const snapshot = JSON.stringify(graph)

    expect(JSON.stringify(graph)).toBe(snapshot)
    expect(graph.checkpoint).toBe(2)
  })

  it('does not mutate its arguments and returns a frozen graph', () => {
    const before = applyAnalysis(EMPTY_PROGRESS_GRAPH, batch(1, 2, 1, [{ seq: 1, turn: 1, topics: ['a'] }]))
    const snapshot = JSON.stringify(before)
    const contributions = [{ seq: 3, turn: 1, topics: ['a'] }]
    const request = batch(3, 4, 1, contributions)
    const after = applyAnalysis(before, request)

    expect(JSON.stringify(before)).toBe(snapshot)
    expect(contributions).toEqual([{ seq: 3, turn: 1, topics: ['a'] }])
    expect(after).not.toBe(before)
    expect(Object.isFrozen(after)).toBe(true)
    expect(Object.isFrozen(after.nodes)).toBe(true)
  })

  it('collapses equal labels that differ only in case and whitespace', () => {
    expect(normalizeTopic('  Model   Gate ')).toBe('model gate')

    const graph = applyAnalysis(EMPTY_PROGRESS_GRAPH, batch(1, 2, 1, [
      { seq: 1, turn: 1, topics: ['Model   Gate', 'model gate'] },
    ]))
    expect(graph.nodes[0]?.topics).toEqual(['model gate'])
    expect(topicsOf(graph)).toEqual(['model gate'])
  })

  it('drops labels that normalize to an empty string', () => {
    const graph = applyAnalysis(EMPTY_PROGRESS_GRAPH, batch(1, 2, 1, [
      { seq: 1, turn: 1, topics: ['   ', 'real'] },
    ]))
    expect(graph.nodes[0]?.topics).toEqual(['real'])
  })

  it('orders parents ascending by seq and never includes the node itself', () => {
    let graph = applyAnalysis(EMPTY_PROGRESS_GRAPH, batch(1, 2, 1, [{ seq: 1, turn: 1, topics: ['a'] }]))
    graph = applyAnalysis(graph, batch(3, 4, 1, [{ seq: 3, turn: 1, topics: ['b'] }]))
    graph = applyAnalysis(graph, batch(5, 6, 1, [{ seq: 5, turn: 1, topics: ['b', 'a'] }]))

    const merged = nodeById(graph, 'n-5')
    expect(merged?.parents).toEqual(['n-1', 'n-3'])
    expect(merged?.parents).not.toContain('n-5')
    for (const node of graph.nodes) {
      expect(node.parents).not.toContain(node.id)
    }
  })

  it('reports the latest node of a topic, topics in first-appearance order, and nodes by id', () => {
    let graph: ProgressGraph = applyAnalysis(EMPTY_PROGRESS_GRAPH, batch(1, 2, 1, [{ seq: 1, turn: 1, topics: ['a', 'b'] }]))
    graph = applyAnalysis(graph, batch(3, 4, 1, [{ seq: 3, turn: 1, topics: ['b'] }]))

    expect(latestNodeOf(graph, ' A ')?.id).toBe('n-1')
    expect(latestNodeOf(graph, 'B')?.id).toBe('n-3')
    expect(latestNodeOf(graph, 'missing')).toBeUndefined()
    expect(topicsOf(graph)).toEqual(['a', 'b'])
    expect(nodeById(graph, 'n-3')?.seq).toBe(3)
    expect(nodeById(graph, 'n-99')).toBeUndefined()
  })
})
