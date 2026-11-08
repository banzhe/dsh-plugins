/**
 * The JSON documents the container helper exchanges with the host.
 *
 * These mirror the seam's types with plain strings where the seam brands
 * identity (`FsTargetKey`, `FsVersion`), because a brand cannot cross a wire.
 * Conversion back happens in one place — `src/fs.ts` — so nothing else sees an
 * unbranded key.
 * @module @banzhe/dsh-devcontainer/rpc/wire
 */

import { FsTargetKey, FsVersion } from '@deepseek-ai/dsh-fs'
import type {
  FsDirEntry,
  FsEditOutcome,
  FsErrorCode,
  FsInfo,
  FsPathInfo,
  FsTarget,
  FsWriteOutcome,
} from '@deepseek-ai/dsh-fs'
import { FS_ERROR_CODES } from './errors.ts'

const KNOWN_CODES = new Set<string>(FS_ERROR_CODES)

/**
 * The outcome of a remote delete.
 *
 * A local shape rather than a seam type: the seam of the DSH build this Bundle
 * compiles against declares no `deleteFile`, so neither does its vocabulary.
 */
export interface ContainerDeleteOutcome {
  /** The bounded LF-normalized removed text, or null when no basis is available. */
  readonly before: string | null
}

/** The outcome of a remote move, with the same local-shape reason as {@link ContainerDeleteOutcome}. */
export interface ContainerMoveOutcome {
  /** The bounded LF source basis, or null when it is unavailable. */
  readonly sourceBefore: string | null
  /** The published destination. */
  readonly destination: FsWriteOutcome
  /** Whether the source was removed after publication. */
  readonly sourceDeleted: boolean
  /** Why the source survived, when it did. */
  readonly sourceFailure?: {
    readonly code: FsErrorCode
    readonly message: string
  }
}

/** A resolved target as it travels. */
export interface WireTarget {
  /** The container-side realpath identity. */
  readonly targetKey: string
  /** The container-side spelling the caller sees. */
  readonly displayPath: string
}

/** `fs.stat` metadata. */
export interface WireInfo {
  readonly version: string
  readonly type: 'file' | 'directory' | 'other'
  readonly size?: number
}

/** `fs.lstat` metadata, which can name the link itself. */
export interface WirePathInfo {
  readonly version: string
  readonly type: 'file' | 'directory' | 'symlink' | 'other'
  readonly size?: number
}

/** One direct child from `fs.list`. */
export interface WireDirEntry {
  readonly name: string
  readonly type: 'file' | 'directory' | 'other'
  readonly target: WireTarget
  readonly version?: string
  readonly size?: number
}

/** The outcome of `fs.write`. */
export interface WireWriteOutcome {
  readonly operation: 'create' | 'update'
  readonly version: string
  readonly before: string | null
  readonly after: string
}

/** The outcome of `fs.edit` and `fs.patch`. */
export interface WireEditOutcome {
  readonly version: string
  readonly before: string
  readonly after: string
}

/** The outcome of `fs.delete`. */
export interface WireDeleteOutcome {
  readonly before: string | null
}

/** The outcome of `fs.move`. */
export interface WireMoveOutcome {
  readonly sourceBefore: string | null
  readonly destination: WireWriteOutcome
  readonly sourceDeleted: boolean
  readonly sourceFailure?: {
    readonly code: string
    readonly message: string
  }
}

/** The handle `fs.stream` opens. */
export interface WireStreamId {
  readonly id: string
}

/** One step of an open text stream. */
export interface WireStreamStep {
  readonly done: boolean
  readonly value: string
}

/** Brand one travelled target back into the seam's identity type. */
export function toFsTarget(target: WireTarget): FsTarget {
  return { targetKey: FsTargetKey(target.targetKey), displayPath: target.displayPath }
}

/** Brand `fs.stat` metadata back into the seam's type. */
export function toFsInfo(info: WireInfo): FsInfo {
  return {
    version: FsVersion(info.version),
    type: info.type,
    ...info.size === undefined ? {} : { size: info.size },
  }
}

/** Brand `fs.lstat` metadata back into the seam's type. */
export function toFsPathInfo(info: WirePathInfo): FsPathInfo {
  return {
    version: FsVersion(info.version),
    type: info.type,
    ...info.size === undefined ? {} : { size: info.size },
  }
}

/** Brand one listing entry back into the seam's type. */
export function toFsDirEntry(entry: WireDirEntry): FsDirEntry {
  return {
    name: entry.name,
    type: entry.type,
    target: toFsTarget(entry.target),
    ...entry.version === undefined ? {} : { version: FsVersion(entry.version) },
    ...entry.size === undefined ? {} : { size: entry.size },
  }
}

/** Brand a write outcome back into the seam's type. */
export function toFsWriteOutcome(outcome: WireWriteOutcome): FsWriteOutcome {
  return {
    operation: outcome.operation,
    version: FsVersion(outcome.version),
    before: outcome.before,
    after: outcome.after,
  }
}

/** Brand an edit or patch outcome back into the seam's type. */
export function toFsEditOutcome(outcome: WireEditOutcome): FsEditOutcome {
  return { version: FsVersion(outcome.version), before: outcome.before, after: outcome.after }
}

/** Pass a delete outcome through; its only field is already plain text. */
export function toFsDeleteOutcome(outcome: WireDeleteOutcome): ContainerDeleteOutcome {
  return { before: outcome.before }
}

/** Brand a move outcome back into the seam's type. */
export function toFsMoveOutcome(outcome: WireMoveOutcome): ContainerMoveOutcome {
  const destination = toFsWriteOutcome(outcome.destination)
  if (outcome.sourceDeleted || outcome.sourceFailure === undefined) {
    return { sourceBefore: outcome.sourceBefore, destination, sourceDeleted: true }
  }
  return {
    sourceBefore: outcome.sourceBefore,
    destination,
    sourceDeleted: false,
    sourceFailure: {
      code: KNOWN_CODES.has(outcome.sourceFailure.code) ? outcome.sourceFailure.code as FsErrorCode : 'FS_IO_ERROR',
      message: outcome.sourceFailure.message,
    },
  }
}
