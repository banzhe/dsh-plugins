import { COMMIT_ROUTE, MESSAGE_ROUTE, STATUS_ROUTE, type GitChangeStatus, type GitMessageLanguage, type GitRouteError, type GitStatus } from '../shared.ts'

/** One JSON body with its status; never rejects. The caller narrows the shape. */
async function fetchJson(url: string, options?: RequestInit): Promise<{ ok: boolean; data: unknown }> {
  try {
    const response = await fetch(url, options)
    try {
      return { ok: response.ok, data: await response.json() }
    }
    catch {
      return { ok: false, data: null }
    }
  }
  catch {
    return { ok: false, data: null }
  }
}

const CHANGE_STATUS: Record<GitChangeStatus, true> = {
  added: true,
  modified: true,
  deleted: true,
  renamed: true,
  untracked: true,
}

/** A status payload, or null when the body is not one. */
function statusOf(data: unknown): GitStatus | null {
  if (typeof data !== 'object' || data === null) return null
  const { branch, changes } = data as { branch?: unknown; changes?: unknown }
  if (branch !== null && typeof branch !== 'string') return null
  if (!Array.isArray(changes)) return null
  return { branch, changes: changes.filter(isChange) }
}

function isChange(value: unknown): value is GitStatus['changes'][number] {
  if (typeof value !== 'object' || value === null) return false
  const { path, status } = value as { path?: unknown; status?: unknown }
  return typeof path === 'string' && typeof status === 'string' && status in CHANGE_STATUS
}

/** A route error's message, or null when the body is not one. */
function errorOf(data: unknown): string | null {
  if (typeof data !== 'object' || data === null) return null
  const { message } = data as Partial<GitRouteError>
  return typeof message === 'string' && message !== '' ? message : null
}

/** The workspace's branch and changed paths, or the route's failure message. */
export async function readWorkspaceStatus(cwd: string, signal: AbortSignal): Promise<
  { ok: true; status: GitStatus } | { ok: false; message: string | null }
> {
  const result = await fetchJson(`${STATUS_ROUTE}?cwd=${encodeURIComponent(cwd)}`, { signal })
  if (signal.aborted) return { ok: false, message: null }
  const status = result.ok ? statusOf(result.data) : null
  return status === null ? { ok: false, message: errorOf(result.data) } : { ok: true, status }
}

/** One drafted commit message, or the route's failure message. Never commits. */
export async function draftWorkspaceMessage(cwd: string, language: GitMessageLanguage, sessionId: string, signal: AbortSignal): Promise<
  { ok: true; message: string } | { ok: false; message: string | null }
> {
  const result = await fetchJson(MESSAGE_ROUTE, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ cwd, language, sessionId }),
    signal,
  })
  if (signal.aborted) return { ok: false, message: null }
  const message = result.ok ? textField(result.data, 'message') : null
  return message === null ? { ok: false, message: errorOf(result.data) } : { ok: true, message }
}

/** The new commit's hash, or the route's failure message. */
export async function commitWorkspace(cwd: string, message: string): Promise<
  { ok: true; hash: string } | { ok: false; message: string | null }
> {
  const result = await fetchJson(COMMIT_ROUTE, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ cwd, message }),
  })
  const hash = result.ok ? textField(result.data, 'hash') : null
  return hash === null ? { ok: false, message: errorOf(result.data) } : { ok: true, hash }
}

/** One non-empty string field of a JSON object, or null when it is not one. */
function textField(data: unknown, key: string): string | null {
  if (typeof data !== 'object' || data === null || !(key in data)) return null
  const value = (data as Record<string, unknown>)[key]
  return typeof value === 'string' && value.trim() !== '' ? value : null
}
