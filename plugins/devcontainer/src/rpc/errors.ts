/**
 * The failure vocabulary of the container filesystem RPC.
 *
 * The helper answers with a `error` frame whose `code` is already a DSH filesystem
 * code, because it maps POSIX errno values (`ENOENT`, `EACCES`, `EISDIR`, ...)
 * inside the container. This module translates that back into the seam's own
 * `FsError`, so a caller cannot tell a remote refusal from a local one.
 * @module @banzhe/dsh-devcontainer/rpc/errors
 */

import { FsError } from '@deepseek-ai/dsh-fs'
import type { FsErrorCode } from '@deepseek-ai/dsh-fs'

/**
 * The seam's failure codes, as a runtime set.
 *
 * The array is typed by `FsErrorCode`, so a code this DSH version does not have
 * fails the build instead of silently becoming a generic I/O failure.
 */
export const FS_ERROR_CODES: readonly FsErrorCode[] = [
  'FS_NOT_FOUND',
  'FS_NOT_DIRECTORY',
  'FS_NOT_TEXT',
  'FS_NOT_REGULAR_FILE',
  'FS_TOO_LARGE',
  'FS_PERMISSION_DENIED',
  'FS_SANDBOX_DENIED',
  'FS_IO_ERROR',
  'FS_STALE_VERSION',
  'FS_NOT_OBSERVED',
  'FS_AMBIGUOUS_EDIT',
  'FS_EDIT_NOT_FOUND',
  'FS_ABORTED',
]

const KNOWN_CODES = new Set<string>(FS_ERROR_CODES)

/**
 * A failure the container helper reported.
 *
 * It stays a distinct class so the transport and the filesystem vocabulary are
 * separable: a `code` the seam does not know (an unexpected remote failure)
 * becomes a generic I/O failure rather than an invented taxonomy entry.
 */
export class RpcOperationError extends Error {
  /** The remote filesystem code, when the helper named one. */
  readonly code: string | undefined

  /**
   * @param message - the remote diagnostic.
   * @param code - the remote `FS_*` code, when it has one.
   */
  constructor(message: string, code?: string) {
    super(message)
    this.name = 'RpcOperationError'
    this.code = code
  }
}

/**
 * Translate one remote or transport failure into the seam's typed error.
 * @param error - whatever the channel rejected with.
 * @param signal - the caller's cancellation signal, for attributing an abort.
 * @returns the `FsError` the filesystem seam reports.
 */
export function rpcFsError(error: unknown, signal?: AbortSignal): FsError {
  if (error instanceof FsError) return error
  if (error instanceof RpcOperationError && error.code !== undefined && KNOWN_CODES.has(error.code)) {
    return new FsError(error.message, error.code as FsErrorCode, { cause: error })
  }
  if (signal?.aborted === true) {
    return new FsError('the container filesystem operation was cancelled', 'FS_ABORTED', { cause: error })
  }
  const message = error instanceof Error ? error.message : String(error)
  return new FsError(message, 'FS_IO_ERROR', { cause: error })
}
