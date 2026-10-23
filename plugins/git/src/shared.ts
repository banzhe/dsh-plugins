/**
 * Wire contract shared by the Host routes and the Client panel.
 *
 * Browser-safe: types and path constants only. The Host registers `_PATH`;
 * the Client addresses `_ROUTE`, the document-relative form, so the same
 * client half works under a mount prefix.
 */

export type GitChangeStatus = 'added' | 'modified' | 'deleted' | 'renamed' | 'untracked'

/** One changed path, relative to the workspace root, using `/` separators. */
export interface GitChange {
  readonly path: string
  readonly status: GitChangeStatus
}

export interface GitStatus {
  readonly branch: string | null
  readonly changes: readonly GitChange[]
}

export interface GitCommitRequest {
  readonly cwd: string
  readonly message: string
}

export interface GitCommitResult {
  readonly ok: true
  readonly hash: string
}

export type GitMessageLanguage = 'zh' | 'en'

/** The route drafts text; it never commits. */
export interface GitMessageRequest {
  readonly cwd: string
  readonly language: GitMessageLanguage
  readonly sessionId: string
}

/** POST /message answer: one Conventional Commit message, ready to edit. */
export interface GitMessageResult {
  readonly ok: true
  readonly message: string
}

export interface GitRouteError {
  readonly code: string
  readonly message: string
}

export const STATUS_PATH = '/api/git/status'

export const STATUS_ROUTE = STATUS_PATH.slice(1)

export const COMMIT_PATH = '/api/git/commit'

export const COMMIT_ROUTE = COMMIT_PATH.slice(1)

export const MESSAGE_PATH = '/api/git/message'

export const MESSAGE_ROUTE = MESSAGE_PATH.slice(1)
