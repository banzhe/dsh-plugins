/**
 * The progress graph: what the conversation has been about, one node per reply.
 *
 * A node stands for one message — in practice one assistant reply — and carries
 * the topics that reply advanced. A reply that covers two subjects is therefore
 * ONE node with two topics, not two nodes: the conversation has one progress
 * point there. Progression is linked per topic: a later node that continues a
 * topic continues it from that topic's latest node, so topics can diverge, meet
 * in one reply again, and diverge again, with the shape of the conversation
 * visible as branches and merges.
 *
 * Everything here is pure: no clock, no storage, no model. {@link applyAnalysis}
 * is the single transition and it takes the whole batch that produced it, so a
 * replay is idempotent and a failed or cancelled analysis — which never calls
 * this function — cannot move the checkpoint past work that did not finish.
 *
 * @module @banzhe/dsh-session-topic-map/src/progress-graph
 */

/** One message that advanced topics. */
export interface ProgressNode {
  /** Identity derived from the message seq: `n-<seq>`. */
  readonly id: string
  /** Event seq of the message this node stands for. */
  readonly seq: number
  /** Turn of that message, so a click can find it in the transcript. */
  readonly turn: number
  /** Normalized topic labels this reply advanced, in first-reported order. */
  readonly topics: readonly string[]
  /** Ids of the nodes this one continues, ordered ascending by the parent's seq. */
  readonly parents: readonly string[]
}

/** One continuation link. */
export interface ProgressEdge {
  /** Parent node id. */
  readonly from: string
  /** Child node id. */
  readonly to: string
  /** `merge` when the child continues more than one topic, otherwise `branch`. */
  readonly kind: 'branch' | 'merge'
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
  topics: string[]
  parents: string[]
}

/** One node per message seq: two contributions from the same message are one node. */
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
      topics: [...node.topics],
      parents: [...node.parents],
    }
    byId.set(copy.id, copy)
    return copy
  })
  for (const contribution of [...contributions].sort((left, right) => left.seq - right.seq)) {
    const id = `n-${contribution.seq}`
    const topics = topicsOfContribution(contribution.topics)
    const existing = byId.get(id)
    if (existing === undefined) {
      const node: MutableNode = {
        id,
        seq: contribution.seq,
        turn: contribution.turn,
        topics,
        parents: [],
      }
      ordered.push(node)
      byId.set(id, node)
      continue
    }
    for (const topic of topics) {
      if (!existing.topics.includes(topic)) existing.topics.push(topic)
    }
  }
  ordered.sort((left, right) => left.seq - right.seq)
  return ordered
}

/**
 * Recompute every node's parents from its topics.
 *
 * A node continues each of its topics from that topic's latest earlier node. The
 * whole set is derived, never accumulated, so replaying a batch and rebuilding
 * from the same nodes always yields the same links.
 */
function linkParents(nodes: readonly MutableNode[]): void {
  const latest = new Map<string, MutableNode>()
  const seqOf = new Map<string, number>(nodes.map(node => [node.id, node.seq]))
  for (const node of nodes) {
    const candidates = new Set<string>()
    for (const topic of node.topics) {
      const previous = latest.get(topic)
      if (previous !== undefined && previous.id !== node.id) candidates.add(previous.id)
    }
    node.parents = [...candidates].sort((left, right) => (seqOf.get(left) ?? 0) - (seqOf.get(right) ?? 0))
    for (const topic of node.topics) latest.set(topic, node)
  }
}

function edgesOf(nodes: readonly MutableNode[]): readonly ProgressEdge[] {
  const edges: ProgressEdge[] = []
  for (const node of nodes) {
    const kind = node.parents.length > 1 ? 'merge' : 'branch'
    for (const parent of node.parents) edges.push({ from: parent, to: node.id, kind })
  }
  return Object.freeze(edges)
}

function freezeNode(node: MutableNode): ProgressNode {
  return Object.freeze({
    id: node.id,
    seq: node.seq,
    turn: node.turn,
    topics: Object.freeze([...node.topics]),
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
 * @returns the node with the greatest seq carrying that topic, or `undefined`.
 */
export function latestNodeOf(graph: ProgressGraph, topic: string): ProgressNode | undefined {
  const normalized = normalizeTopic(topic)
  let found: ProgressNode | undefined
  for (const node of graph.nodes) {
    if (node.topics.includes(normalized)) found = node
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
    for (const topic of node.topics) {
      if (!seen.includes(topic)) seen.push(topic)
    }
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
