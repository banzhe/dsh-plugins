/**
 * Wire contract shared by the Host routes and the Client panel.
 *
 * Browser-safe: types and path constants only. The Host registers `_PATH`;
 * the Client addresses `_ROUTE`, the document-relative form, so the same
 * client half works under a mount prefix.
 */

/** One file the working tree differs from HEAD in. */
export type GitChangeStatus = 'added' | 'modified' | 'deleted' | 'renamed' | 'untracked'

/** One changed path, relative to the workspace root, using `/` separators. */
export interface GitChange {
  readonly path: string
  readonly status: GitChangeStatus
}

/** GET /status answer: the workspace's branch and its changed paths. */
export interface GitStatus {
  readonly branch: string | null
  readonly changes: readonly GitChange[]
}

/** POST /commit body. */
export interface GitCommitRequest {
  readonly cwd: string
  readonly message: string
}

/** POST /commit answer. */
export interface GitCommitResult {
  readonly ok: true
  readonly hash: string
}

/** Which of the two message styles a draft request asks for. */
export type GitMessageLanguage = 'zh' | 'en'

/** POST /message body. The route drafts text; it never commits. */
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

/** Route failure body. */
export interface GitRouteError {
  readonly code: string
  readonly message: string
}

/** GET route path serving one workspace's changed paths. */
export const STATUS_PATH = '/api/git/status'

/** Browser-relative form of {@link STATUS_PATH}. */
export const STATUS_ROUTE = STATUS_PATH.slice(1)

/** POST route path committing the workspace's staged and unstaged changes. */
export const COMMIT_PATH = '/api/git/commit'

/** Browser-relative form of {@link COMMIT_PATH}. */
export const COMMIT_ROUTE = COMMIT_PATH.slice(1)

/** POST route path drafting a commit message from the workspace's changes. */
export const MESSAGE_PATH = '/api/git/message'

/** Browser-relative form of {@link MESSAGE_PATH}. */
export const MESSAGE_ROUTE = MESSAGE_PATH.slice(1)
