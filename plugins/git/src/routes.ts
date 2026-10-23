import path from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { ModelSelection } from '@deepseek-ai/dsh-api-session-controller'
import type {} from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-projection'
import type {} from '@deepseek-ai/dsh-workspace'
import { SessionId } from '@deepseek-ai/dsh-session'
import { commitAll, GitError, readChangeContext, readStatus, resolveRepoRoot } from './git.ts'
import { draftMessage } from './message.ts'
import { COMMIT_PATH, MESSAGE_PATH, STATUS_PATH, type GitCommitRequest, type GitMessageRequest, type GitRouteError } from './shared.ts'

/** Cordis function-plugin name. */
export const name = 'git'

export const inject = ['webServer', 'connection', 'workspaceRegistry', 'llm', 'sessions', 'sessionProjections']

/** Trust surface consumed here; the browser-side connection package owns the full type. */
interface ConnectionLike {
  requestRejection(req: unknown): number | undefined
}

/** The Node request surface these routes read; an unread body is drained, not left open. */
interface RouteRequest extends AsyncIterable<Buffer> {
  readonly method?: string | undefined
  readonly url?: string | undefined
  readonly headers: Record<string, string | string[] | undefined>
  resume(): void
}

interface RouteResponse {
  statusCode: number
  setHeader(name: string, value: string): void
  end(body?: string): void
}

/** The route carrier; `register` returns this plugin's disposer. */
interface WebServerLike {
  register(route: {
    kind: 'exact'
    path: string
    handler: (req: RouteRequest, res: RouteResponse) => Promise<void>
  }): () => void
}

function connectionOf(ctx: Context): ConnectionLike {
  return (ctx as unknown as { connection: ConnectionLike }).connection
}

function webServerOf(ctx: Context): WebServerLike {
  return (ctx as unknown as { webServer: WebServerLike }).webServer
}

function rejected(connection: ConnectionLike, req: unknown, res: RouteResponse): boolean {
  const rejection = connection.requestRejection(req)
  if (rejection === undefined) return false
  res.statusCode = rejection
  res.end()
  return true
}

/** A commit message names files and a sentence; anything larger is hostile. */
const MAX_BODY_BYTES = 64 * 1024

/** Outcomes are live facts, so nothing here is cacheable. */
function sendJson(res: RouteResponse, status: number, payload: unknown): void {
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(JSON.stringify(payload))
}

function sendMethodNotAllowed(res: RouteResponse, allow: string): void {
  res.statusCode = 405
  res.setHeader('allow', allow)
  res.end()
}

function sendError(res: RouteResponse, status: number, code: string, message: string): void {
  const body: GitRouteError = { code, message }
  sendJson(res, status, body)
}

/**
 * A too-large body is drained rather than left unread: an unread stream holds
 * the socket open, and this route answers 413 immediately.
 */
async function readBoundedBody(req: RouteRequest): Promise<string | null> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.byteLength
    if (size > MAX_BODY_BYTES) {
      req.resume()
      return null
    }
    chunks.push(chunk)
  }
  return Buffer.concat(chunks, size).toString('utf8')
}

export function cwdOf(url: string | undefined): string | null {
  if (url === undefined) return null
  const query = url.includes('?') ? url.slice(url.indexOf('?')) : ''
  const cwd = new URLSearchParams(query).get('cwd')
  return cwd === null || cwd.trim() === '' ? null : cwd
}

/**
 * Both write routes share this gate: the method, the media type, and the body
 * ceiling.
 */
async function readJsonPost(req: RouteRequest, res: RouteResponse): Promise<string | null> {
  if (req.method !== 'POST') {
    sendMethodNotAllowed(res, 'POST')
    return null
  }
  const essence = String(req.headers['content-type']).split(';', 1)[0]?.trim().toLowerCase()
  if (essence !== 'application/json') {
    sendError(res, 415, 'unsupported-media-type', 'content-type must be application/json')
    return null
  }
  let text: string | null
  try {
    text = await readBoundedBody(req)
  }
  catch {
    sendError(res, 400, 'bad-request', 'request body unreadable')
    return null
  }
  if (text === null) {
    sendError(res, 413, 'payload-too-large', 'request body is too large')
    return null
  }
  return text
}

export function parseMessage(text: string): GitMessageRequest | null {
  let body: unknown
  try {
    body = JSON.parse(text)
  }
  catch {
    return null
  }
  if (typeof body !== 'object' || body === null) return null
  const { cwd, language, sessionId } = body as Record<string, unknown>
  if (typeof cwd !== 'string' || typeof sessionId !== 'string') return null
  if (cwd.trim() === '' || sessionId.trim() === '') return null
  if (language !== 'zh' && language !== 'en') return null
  return { cwd, language, sessionId }
}

export function parseCommit(text: string): GitCommitRequest | null {
  let body: unknown
  try {
    body = JSON.parse(text)
  }
  catch {
    return null
  }
  if (typeof body !== 'object' || body === null) return null
  const { cwd, message } = body as Record<string, unknown>
  if (typeof cwd !== 'string' || typeof message !== 'string') return null
  if (cwd.trim() === '' || message.trim() === '') return null
  return { cwd, message }
}

/**
 * The session tells the panel its cwd, but the route does not trust that
 * string: it must be absolute, and `resolveByPath` must find a workspace
 * registered for that exact directory. A missing path and an unregistered
 * directory are the same answer — there is nothing to operate on.
 */
async function allowedRoot(ctx: Context, requested: string): Promise<string | null> {
  if (!path.isAbsolute(requested)) return null
  try {
    const workspace = await ctx.workspaceRegistry.resolveByPath(requested)
    return workspace?.path ?? null
  }
  catch {
    return null
  }
}

export function apply(ctx: Context): void {
  ctx.effect(() => webServerOf(ctx).register({
    kind: 'exact',
    path: STATUS_PATH,
    handler: async (req, res) => {
      if (rejected(connectionOf(ctx), req, res)) return
      if (req.method !== 'GET') {
        sendMethodNotAllowed(res, 'GET')
        return
      }
      const cwd = cwdOf(req.url)
      if (cwd === null) {
        sendError(res, 400, 'bad-request', 'cwd is required')
        return
      }
      const root = await allowedRoot(ctx, cwd)
      if (root === null) {
        sendError(res, 404, 'not-a-workspace', 'cwd is not a registered workspace')
        return
      }
      try {
        await resolveRepoRoot(root)
        sendJson(res, 200, await readStatus(root))
      }
      catch (error) {
        const message = error instanceof GitError ? error.message : 'git status failed'
        sendError(res, 409, 'not-a-repository', message)
      }
    },
  }), `git: GET ${STATUS_PATH}`)

  ctx.effect(() => webServerOf(ctx).register({
    kind: 'exact',
    path: COMMIT_PATH,
    handler: async (req, res) => {
      if (rejected(connectionOf(ctx), req, res)) return
      const text = await readJsonPost(req, res)
      if (text === null) return
      const parsed = parseCommit(text)
      if (parsed === null) {
        sendError(res, 400, 'bad-request', 'request body does not match the route schema')
        return
      }
      const root = await allowedRoot(ctx, parsed.cwd)
      if (root === null) {
        sendError(res, 404, 'not-a-workspace', 'cwd is not a registered workspace')
        return
      }
      try {
        await resolveRepoRoot(root)
        const hash = await commitAll(root, parsed.message)
        sendJson(res, 200, { ok: true, hash })
      }
      catch (error) {
        const message = error instanceof GitError ? error.message : 'git commit failed'
        sendError(res, 409, 'commit-failed', message)
      }
    },
  }), `git: POST ${COMMIT_PATH}`)

  ctx.effect(() => webServerOf(ctx).register({
    kind: 'exact',
    path: MESSAGE_PATH,
    handler: async (req, res) => {
      if (rejected(connectionOf(ctx), req, res)) return
      const text = await readJsonPost(req, res)
      if (text === null) return
      const parsed = parseMessage(text)
      if (parsed === null) {
        sendError(res, 400, 'bad-request', 'request body does not match the route schema')
        return
      }
      const root = await allowedRoot(ctx, parsed.cwd)
      if (root === null) {
        sendError(res, 404, 'not-a-workspace', 'cwd is not a registered workspace')
        return
      }
      try {
        // A missing model fails before any diff is read. The repository check
        // stays first: "not a repository" is the more specific answer.
        await resolveRepoRoot(root)
        const route = await modelRoute(ctx, parsed.sessionId)
        const diff = await readChangeContext(root)
        if (diff.trim() === '') {
          sendError(res, 409, 'nothing-to-describe', 'there are no changes to describe')
          return
        }
        const message = await draftMessage({ diff, ...route, language: parsed.language, llm: ctx.llm })
        sendJson(res, 200, { ok: true, message })
      }
      catch (error) {
        const message = error instanceof Error ? error.message : 'drafting the commit message failed'
        sendError(res, 409, 'draft-failed', message)
      }
    },
  }), `git: POST ${MESSAGE_PATH}`)
}

async function modelRoute(ctx: Context, sessionId: string): Promise<ModelSelection> {
  const selected = selectionOf(ctx, sessionId)
  if (selected !== null) return selected
  const llm = ctx.llm
  const provider = llm.listProviders()[0]
  if (provider === undefined) throw new GitError('no model provider is configured')
  const models = await llm.listModels(provider.id)
  const model = models[0]
  if (model === undefined) throw new GitError(`provider ${provider.id} advertises no model`)
  return { provider: provider.id, model: model.id }
}

/**
 * `pending` is a selection the user made that no request has consumed yet, so it
 * wins over `lastUsed`, the selection the session's latest request ran on.
 */
function selectionOf(ctx: Context, sessionId: string): ModelSelection | null {
  const session = ctx.sessions.get(SessionId(sessionId))
  if (session === undefined) return null
  const value = ctx.sessionProjections.stateOf(session, 'modelSelection')
  return value?.pending ?? value?.lastUsed ?? null
}
