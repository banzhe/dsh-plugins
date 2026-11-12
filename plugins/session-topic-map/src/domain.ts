/**
 * Where one Session's progress graph lives.
 *
 * Persistence is per Session — one record keyed by the Session id — because a
 * graph is derived from that Session's own log and nothing else: a second Session
 * has its own conversation, its own checkpoint, and its own topics.
 *
 * The stored record carries its own `schemaVersion`. Version 2 keys nodes by
 * message seq and stores each node's topics; version 1 keyed them by topic label
 * and stored per-topic sources, which is a different graph, not a different
 * spelling of this one. A version-1 record is therefore accepted by the schema
 * (so opening the domain over old media still succeeds) but recognized and never
 * read as the current schema: {@link currentGraphOf} answers `null` for it and
 * the Session starts from an empty graph, which the next successful analysis
 * overwrites with a version-2 record. The domain keeps its version stamp because
 * the stored layout did not change and refusing the old medium would fail the
 * whole open.
 *
 * @module @banzhe/dsh-session-topic-map/src/domain
 */

import { z } from 'zod'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import type { ProgressGraph } from './progress-graph.ts'

/** Record format this build writes; anything else is legacy derived data. */
export const TOPIC_RECORD_VERSION = 2

const nodeSchema = z.object({
  /** `n-<seq>`, derived from the message the node stands for. */
  id: z.string().min(1),
  seq: z.number().int().min(0),
  turn: z.number().int().min(0),
  topics: z.array(z.string().min(1)).min(1),
  parents: z.array(z.string().min(1)),
})

const edgeSchema = z.object({
  from: z.string().min(1),
  to: z.string().min(1),
  kind: z.enum(['branch', 'merge']),
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
  /**
   * Whether every node's turn has been checked against the Session log. An
   * earlier build derived turns from turn boundaries alone, which could store a
   * turn the transcript never shows; such a record lacks the flag and is
   * re-anchored from the log the next time it is read.
   */
  turnsVerified: z.boolean().optional(),
})

/**
 * A version-1 record: same table and same cursor fields, a graph this build does
 * not read. Its nodes and edges stay opaque on purpose — the only fact this
 * build needs is that the record is not version 2.
 */
const legacyGraphSchema = z.object({
  nodes: z.array(z.unknown()),
  edges: z.array(z.unknown()),
  checkpoint: z.number().int().min(-1),
  turn: z.number().int().min(0),
})

const legacyRecordSchema = z.object({
  graph: legacyGraphSchema,
  updatedAt: z.string().min(1),
})

const recordSchema = z.union([currentRecordSchema, legacyRecordSchema])

/** One Session's record as this build writes it. */
export type CurrentTopicRecord = z.infer<typeof currentRecordSchema>

/** A record an earlier build wrote; recognized, never restored as a graph. */
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
 * Detach a graph into the record form the table stores.
 * @param graph - the graph to store.
 * @param updatedAt - ISO-8601 instant of this write.
 * @param turnsVerified - whether every node's turn was checked against the log.
 * @returns a version-2 record holding fresh mutable arrays.
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
        topics: [...node.topics],
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
  const version: number = 'schemaVersion' in record ? record.schemaVersion : 0
  return version === TOPIC_RECORD_VERSION
}

/**
 * The graph a stored record carries, when this build may read it.
 * @param record - the stored record, if any.
 * @returns the graph for a version-2 record; `null` for a legacy record or none.
 */
export function currentGraphOf(record: TopicGraphRecord | undefined): ProgressGraph | null {
  if (record === undefined || !isCurrentRecord(record)) return null
  return record.graph
}
