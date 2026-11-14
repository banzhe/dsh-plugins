/**
 * Where one Session's progress graph lives.
 *
 * Persistence is per Session — one record keyed by the Session id — because a
 * graph is derived from that Session's own log and nothing else.
 *
 * The stored record carries its own `schemaVersion`:
 * - Version 3 (current) stores independent per-`(seq, topic)` nodes with `branch` edges.
 * - Version 2 (legacy, migratable) keyed nodes by message `seq` with `topics[]`;
 *   {@link currentGraphOf} projects it purely into a version-3 graph without
 *   calling a model or reading the Session log, and {@link needsGraphMigration}
 *   reports that it should be re-persisted in version-3 format.
 * - Version 1 (legacy, unreadable) keyed nodes by topic label with per-topic
 *   sources; {@link currentGraphOf} answers `null` for it.
 *
 * @module @banzhe/dsh-session-topic-map/src/domain
 */

import { z } from 'zod'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import { normalizeTopic, type ProgressEdge, type ProgressGraph, type ProgressNode } from './progress-graph.ts'

/** Record format this build writes; earlier versions are legacy derived data. */
export const TOPIC_RECORD_VERSION = 3

const nodeSchema = z.object({
  /** `n-<seq>#<encodeURIComponent(topic)>`, derived from the message and topic. */
  id: z.string().min(1),
  seq: z.number().int().min(0),
  turn: z.number().int().min(0),
  topic: z.string().min(1),
  parents: z.array(z.string().min(1)),
})

const edgeSchema = z.object({
  from: z.string().min(1),
  to: z.string().min(1),
  kind: z.literal('branch'),
})

const graphSchema = z.object({
  nodes: z.array(nodeSchema),
  edges: z.array(edgeSchema),
  /** `-1` is the "nothing analyzed yet" cursor, not a missing field. */
  checkpoint: z.number().int().min(-1),
  turn: z.number().int().min(0),
})

const currentRecordSchema = z.object({
  schemaVersion: z.literal(TOPIC_RECORD_VERSION),
  graph: graphSchema,
  /** ISO-8601 instant of the last successful analysis; nothing branches on it. */
  updatedAt: z.string().min(1),
  turnsVerified: z.boolean().optional(),
})

/** Version-2 node schema kept for pure projection migration to version 3. */
const legacyV2NodeSchema = z.object({
  id: z.string().min(1),
  seq: z.number().int().min(0),
  turn: z.number().int().min(0),
  topics: z.array(z.string().min(1)).min(1),
  parents: z.array(z.string().min(1)),
})

const legacyV2EdgeSchema = z.object({
  from: z.string().min(1),
  to: z.string().min(1),
  kind: z.enum(['branch', 'merge']),
})

const legacyV2GraphSchema = z.object({
  nodes: z.array(legacyV2NodeSchema),
  edges: z.array(legacyV2EdgeSchema),
  checkpoint: z.number().int().min(-1),
  turn: z.number().int().min(0),
})

const legacyV2RecordSchema = z.object({
  schemaVersion: z.literal(2),
  graph: legacyV2GraphSchema,
  updatedAt: z.string().min(1),
  turnsVerified: z.boolean().optional(),
})

/**
 * A version-1 record: same table and same cursor fields, a graph this build does
 * not read.
 */
const legacyGraphSchema = z.object({
  nodes: z.array(z.unknown()),
  edges: z.array(z.unknown()),
  checkpoint: z.number().int().min(-1),
  turn: z.number().int().min(0),
})

const legacyRecordSchema = z.object({
  schemaVersion: z.literal(1).optional(),
  graph: legacyGraphSchema,
  updatedAt: z.string().min(1),
})

const recordSchema = z.union([currentRecordSchema, legacyV2RecordSchema, legacyRecordSchema])

/** One Session's record as this build writes it. */
export type CurrentTopicRecord = z.infer<typeof currentRecordSchema>

/** Version-2 node kept for legacy migration. */
export type LegacyV2Node = z.infer<typeof legacyV2NodeSchema>

/** Version-2 edge kept for legacy migration. */
export type LegacyV2Edge = z.infer<typeof legacyV2EdgeSchema>

/** Version-2 graph kept for legacy migration. */
export type LegacyV2Graph = z.infer<typeof legacyV2GraphSchema>

/** Version-2 record recognized and migrated on read. */
export type LegacyV2TopicRecord = z.infer<typeof legacyV2RecordSchema>

/** Version-1 record recognized, never restored as a graph. */
export type LegacyTopicRecord = z.infer<typeof legacyRecordSchema>

/** Anything the table may hold. */
export type TopicGraphRecord = z.infer<typeof recordSchema>

/** Doubles as the backend unit name. */
export const SESSION_TOPIC_DOMAIN = 'session_topic_map'

/** Table holding one record per Session id. */
export const SESSION_TOPIC_TABLE = 'graphs'

/**
 * No global slot: an absent record already means "this Session was never
 * analyzed". Invalid records are disposable derived data, so a bad one is moved
 * aside at open instead of failing the whole domain.
 */
export const sessionTopicDomainSpec = defineDomain({
  name: SESSION_TOPIC_DOMAIN,
  version: 1,
  invalidRecords: 'backup-and-skip',
  tables: { [SESSION_TOPIC_TABLE]: domainTable<string, TopicGraphRecord>(recordSchema) },
})

/**
 * Detach a version-3 graph into the record form the table stores.
 * @param graph - the graph to store.
 * @param updatedAt - ISO-8601 instant of this write.
 * @param turnsVerified - whether every node's turn was checked against the log.
 * @returns a version-3 record holding fresh mutable arrays.
 */
export function storedRecord(graph: ProgressGraph, updatedAt: string, turnsVerified = true): CurrentTopicRecord {
  return {
    schemaVersion: TOPIC_RECORD_VERSION,
    turnsVerified,
    graph: {
      nodes: graph.nodes.map(node => ({
        id: node.id,
        seq: node.seq,
        turn: node.turn,
        topic: node.topic,
        parents: [...node.parents],
      })),
      edges: graph.edges.map(edge => ({ from: edge.from, to: edge.to, kind: edge.kind })),
      checkpoint: graph.checkpoint,
      turn: graph.turn,
    },
    updatedAt,
  }
}

function isCurrentRecord(record: TopicGraphRecord): record is CurrentTopicRecord {
  return 'schemaVersion' in record && record.schemaVersion === TOPIC_RECORD_VERSION
}

function isV2Record(record: TopicGraphRecord): record is LegacyV2TopicRecord {
  return 'schemaVersion' in record && record.schemaVersion === 2
}

/**
 * Pure projection from a version-2 graph to the independent-topic version-3 graph.
 * Sorts nodes by seq ascending, splits each node's topics into individual nodes,
 * and rebuilds parents and `branch` edges strictly within each topic.
 */
function migrateV2Graph(legacy: LegacyV2Graph): ProgressGraph {
  const ordered = [...legacy.nodes].sort((left, right) => left.seq - right.seq)
  const seenIds = new Set<string>()
  const latestByTopic = new Map<string, string>()
  const nodes: ProgressNode[] = []
  const edges: ProgressEdge[] = []

  for (const legacyNode of ordered) {
    for (const rawTopic of legacyNode.topics) {
      const topic = normalizeTopic(rawTopic)
      if (topic === '') continue
      const id = `n-${legacyNode.seq}#${encodeURIComponent(topic)}`
      if (seenIds.has(id)) continue
      seenIds.add(id)

      const parent = latestByTopic.get(topic)
      const hasParent = parent !== undefined && parent !== id
      const parents = hasParent ? [parent] : []
      if (hasParent) {
        edges.push(Object.freeze({ from: parent, to: id, kind: 'branch' as const }))
      }
      latestByTopic.set(topic, id)
      nodes.push(Object.freeze({
        id,
        seq: legacyNode.seq,
        turn: legacyNode.turn,
        topic,
        parents: Object.freeze(parents),
      }))
    }
  }

  return Object.freeze({
    nodes: Object.freeze(nodes),
    edges: Object.freeze(edges),
    checkpoint: legacy.checkpoint,
    turn: legacy.turn,
  })
}

/**
 * Whether a stored record is a version-2 graph that should be migrated to version 3.
 * @param record - the stored record, if any.
 * @returns `true` only for a version-2 record.
 */
export function needsGraphMigration(record: TopicGraphRecord | undefined): boolean {
  return record !== undefined && isV2Record(record)
}

/**
 * The version-3 graph a stored record carries or projects to.
 * @param record - the stored record, if any.
 * @returns the graph directly for version 3, pure-projected for version 2, or `null` for version 1 or none.
 */
export function currentGraphOf(record: TopicGraphRecord | undefined): ProgressGraph | null {
  if (record === undefined) return null
  if (isCurrentRecord(record)) return record.graph
  if (isV2Record(record)) return migrateV2Graph(record.graph)
  return null
}
