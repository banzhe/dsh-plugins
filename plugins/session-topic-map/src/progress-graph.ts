/**
 * The progress graph: independent topic progressions across a Session.
 *
 * Each `(seq, topic)` pair is its own node, linked only to the latest earlier
 * node of that same topic so every topic forms an independent chain with
 * `branch` edges. One reply may still advance multiple topics in
 * `TopicContribution.topics`; each reported topic becomes a separate node at the
 * same `seq` and `turn`.
 *
 * Everything here is pure: no clock, no storage, no model. {@link applyAnalysis}
 * is the single transition and it takes the whole batch that produced it, so a
 * replay is idempotent and a failed or cancelled analysis — which never calls
 * this function — cannot move the checkpoint past work that did not finish.
 *
 * @module @banzhe/dsh-session-topic-map/src/progress-graph
 */

/** One topic advancement at a specific message. */
export interface ProgressNode {
  /** Identity derived from the message seq and normalized topic: `n-${seq}#${encodeURIComponent(topic)}`. */
  readonly id: string
  /** Event seq of the message this node stands for. */
  readonly seq: number
  /** Turn of that message, so a click can find it in the transcript. */
  readonly turn: number
  /** Normalized topic label this node advances. */
  readonly topic: string
  /** Ids of the preceding node in the same topic (empty for the first node of a topic). */
  readonly parents: readonly string[]
}

/** One continuation link within a topic. */
export interface ProgressEdge {
  /** Parent node id. */
  readonly from: string
  /** Child node id. */
  readonly to: string
  /** Same-topic continuation edge. */
  readonly kind: 'branch'
}

/** The whole graph for one Session, with the analysis cursor that produced it. */
export interface ProgressGraph {
  /** Nodes in ascending seq order. */
  readonly nodes: readonly ProgressNode[]
  /** Links derived from every node's parents. */
  readonly edges: readonly ProgressEdge[]
  /** Highest analyzed event seq; `-1` before the first successful analysis. */
  readonly checkpoint: number
  /** Turn in force at {@link checkpoint}, so a resume can label the next message. */
  readonly turn: number
}

/** The graph of a Session nothing has analyzed yet. */
export const EMPTY_PROGRESS_GRAPH: ProgressGraph = Object.freeze({
  nodes: Object.freeze([]),
  edges: Object.freeze([]),
  checkpoint: -1,
  turn: 0,
})

/** The topics one message advanced. */
export interface TopicContribution {
  /** Event seq of the message. */
  readonly seq: number
  /** Turn of that message. */
  readonly turn: number
  /** Topic labels, normalized and de-duplicated; empty entries are dropped. */
  readonly topics: readonly string[]
}

/** Everything one analysis run decided, together with the range it covered. */
export interface AnalysisBatch {
  /** First event seq the run was allowed to read. */
  readonly fromSeq: number
  /** Last event seq the run covered; becomes the new checkpoint. */
  readonly toSeq: number
  /** Turn in force at {@link toSeq}. */
  readonly turn: number
  /** One entry per message that reported topics; empty when the range held none. */
  readonly contributions: readonly TopicContribution[]
}

/**
 * The comparison form of a topic label: surrounding space dropped, inner runs
 * collapsed, case folded.
 * @param label - raw label from the analysis.
 * @returns the normalized label.
 */
export function normalizeTopic(label: string): string {
  return label.trim().replace(/\s+/gu, ' ').toLowerCase()
}

function topicsOfContribution(topics: readonly string[]): string[] {
  const kept: string[] = []
  for (const topic of topics) {
    const normalized = normalizeTopic(topic)
    if (normalized === '' || kept.includes(normalized)) continue
    kept.push(normalized)
  }
  return kept
}

interface MutableNode {
  id: string
  seq: number
  turn: number
  topic: string
  parents: string[]
}

/** One node per `(seq, topic)`: duplicate entries for the same pair are ignored. */
function applyContributions(
  nodes: readonly ProgressNode[],
  contributions: readonly TopicContribution[],
): MutableNode[] {
  const byId = new Map<string, MutableNode>()
  const ordered: MutableNode[] = nodes.map((node) => {
    const copy: MutableNode = {
      id: node.id,
      seq: node.seq,
      turn: node.turn,
      topic: node.topic,
      parents: [...node.parents],
    }
    byId.set(copy.id, copy)
    return copy
  })
  for (const contribution of [...contributions].sort((left, right) => left.seq - right.seq)) {
    const topics = topicsOfContribution(contribution.topics)
    for (const topic of topics) {
      const id = `n-${contribution.seq}#${encodeURIComponent(topic)}`
      if (byId.has(id)) continue
      const node: MutableNode = {
        id,
        seq: contribution.seq,
        turn: contribution.turn,
        topic,
        parents: [],
      }
      ordered.push(node)
      byId.set(id, node)
    }
  }
  ordered.sort((left, right) => left.seq - right.seq)
  return ordered
}

/**
 * Recompute every node's parent from its own topic.
 *
 * Each node continues its topic from that topic's latest earlier node.
 */
function linkParents(nodes: readonly MutableNode[]): void {
  const latest = new Map<string, MutableNode>()
  for (const node of nodes) {
    const previous = latest.get(node.topic)
    node.parents = previous !== undefined && previous.id !== node.id ? [previous.id] : []
    latest.set(node.topic, node)
  }
}

function edgesOf(nodes: readonly MutableNode[]): readonly ProgressEdge[] {
  const edges: ProgressEdge[] = []
  for (const node of nodes) {
    for (const parent of node.parents) {
      edges.push(Object.freeze({ from: parent, to: node.id, kind: 'branch' as const }))
    }
  }
  return Object.freeze(edges)
}

function freezeNode(node: MutableNode): ProgressNode {
  return Object.freeze({
    id: node.id,
    seq: node.seq,
    turn: node.turn,
    topic: node.topic,
    parents: Object.freeze([...node.parents]),
  })
}

/**
 * Apply one analysis batch.
 *
 * A batch whose range the graph already covers is a replay and returns the graph
 * unchanged, which is what makes a retry idempotent.
 *
 * @param graph - the graph before this run.
 * @param batch - the topics that run read, plus the range it covered.
 * @returns a new graph; the input is never mutated.
 */
export function applyAnalysis(graph: ProgressGraph, batch: AnalysisBatch): ProgressGraph {
  if (batch.toSeq <= graph.checkpoint) return graph
  const nodes = applyContributions(graph.nodes, batch.contributions)
  linkParents(nodes)
  return Object.freeze({
    nodes: Object.freeze(nodes.map(freezeNode)),
    edges: edgesOf(nodes),
    checkpoint: batch.toSeq,
    turn: batch.turn,
  })
}

/**
 * The node a topic currently ends at.
 * @param graph - the current graph.
 * @param topic - any label spelling of the topic.
 * @returns the node with the greatest seq for that topic, or `undefined`.
 */
export function latestNodeOf(graph: ProgressGraph, topic: string): ProgressNode | undefined {
  const normalized = normalizeTopic(topic)
  let found: ProgressNode | undefined
  for (const node of graph.nodes) {
    if (node.topic === normalized && (found === undefined || node.seq >= found.seq)) {
      found = node
    }
  }
  return found
}

/**
 * The labels the analysis may reuse, in first-appearance order.
 * @param graph - the current graph.
 * @returns one entry per distinct topic.
 */
export function topicsOf(graph: ProgressGraph): readonly string[] {
  const seen: string[] = []
  for (const node of graph.nodes) {
    if (!seen.includes(node.topic)) seen.push(node.topic)
  }
  return seen
}

/**
 * Look one node up by id.
 * @param graph - the current graph.
 * @param id - node id.
 * @returns the node, or `undefined` when the graph has no such id.
 */
export function nodeById(graph: ProgressGraph, id: string): ProgressNode | undefined {
  return graph.nodes.find(node => node.id === id)
}
