import { execFile } from 'node:child_process'
import { open, realpath } from 'node:fs/promises'
import path from 'node:path'
import type { GitChange, GitChangeStatus, GitStatus } from './shared.ts'

/** How long one git invocation may run before it is killed. */
const GIT_TIMEOUT_MS = 15_000

/** How much of a git failure is kept; a hostile repo must not flood the answer. */
const GIT_ERROR_CAP = 4_000

/**
 * How much stdout one git invocation may return.
 *
 * Separate from the error cap: a status or a diff past a few kilobytes is a
 * normal repository, and killing it there fails the panel. The draft trims
 * what it shows afterwards.
 */
const GIT_OUTPUT_CAP = 1_000_000

/** One git invocation's captured output. */
interface GitOutput {
  readonly stdout: string
  readonly stderr: string
}

/** A git invocation that exited non-zero, or never started. */
export class GitError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'GitError'
  }
}

/** Run one git command in `cwd`; rejects with {@link GitError} on any failure. */
function runGit(cwd: string, args: readonly string[]): Promise<GitOutput> {
  return new Promise((resolve, reject) => {
    execFile('git', ['-c', 'core.quotepath=false', ...args], {
      cwd,
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: GIT_OUTPUT_CAP,
      windowsHide: true,
    }, (error, stdout, stderr) => {
      if (error !== null) {
        const detail = stderr.trim() || error.message
        reject(new GitError(detail.slice(0, GIT_ERROR_CAP)))
        return
      }
      resolve({ stdout, stderr })
    })
  })
}

/**
 * The workspace root git itself reports, resolved to its real path.
 *
 * `rev-parse` fails outside a repository, which is the signal the route turns
 * into "not a git repository" rather than an empty change list.
 */
export async function resolveRepoRoot(cwd: string): Promise<string> {
  const { stdout } = await runGit(cwd, ['rev-parse', '--show-toplevel'])
  return realpath(stdout.trim())
}

/** Map one porcelain status letter onto the closed set the panel renders. */
function statusOf(letter: string): GitChangeStatus {
  switch (letter) {
    case 'A':
    case 'C':
      return 'added'
    case 'D':
      return 'deleted'
    case 'R':
      return 'renamed'
    case '?':
      return 'untracked'
    default:
      return 'modified'
  }
}

/**
 * Read one porcelain v1 record.
 *
 * Records are `XY <path>`, and a rename is `XY <from> -> <to>`. The panel
 * shows the path as it stands now, so a rename keeps the destination. A
 * record shorter than the status columns is skipped rather than guessed.
 */
function changeOf(record: string): GitChange | null {
  const indexed = record[0] === ' ' || record[0] === '?' ? record[1] : record[0]
  if (record.length < 4 || indexed === undefined) return null
  const status = statusOf(indexed)
  const raw = record.slice(3)
  const arrow = raw.lastIndexOf(' -> ')
  const target = status === 'renamed' && arrow !== -1 ? raw.slice(arrow + 4) : raw
  const normalized = target.replaceAll('\\', '/')
  if (normalized === '') return null
  return { path: normalized, status }
}

/** The current branch name, or null on a detached HEAD. */
async function readBranch(cwd: string): Promise<string | null> {
  const { stdout } = await runGit(cwd, ['rev-parse', '--abbrev-ref', 'HEAD'])
  const branch = stdout.trim()
  return branch === '' || branch === 'HEAD' ? null : branch
}

/**
 * The working tree's changed paths, unstaged and untracked together.
 *
 * `git status` is the one read: it reports the index and the worktree in one
 * pass, and `-uall` lists each untracked file instead of collapsing a new
 * directory into one row.
 */
export async function readStatus(cwd: string): Promise<GitStatus> {
  const [branch, listed] = await Promise.all([
    readBranch(cwd),
    runGit(cwd, ['status', '--porcelain', '-uall']),
  ])
  const changes: GitChange[] = []
  for (const record of listed.stdout.split('\n')) {
    const trimmed = record.replace(/\r$/, '')
    if (trimmed === '') continue
    const change = changeOf(trimmed)
    if (change !== null) changes.push(change)
  }
  return { branch, changes }
}

/** How much of a diff one draft may carry; past this the tail is marked truncated. */
const DIFF_CAP = 24_000

/**
 * The change context one message draft reads.
 *
 * The commit button stages everything and commits it, so the draft describes
 * that same set: staged, unstaged, and untracked. Untracked files have no
 * diff, so each one's contents are appended under its path.
 */
export async function readChangeContext(cwd: string): Promise<string> {
  const [staged, unstaged, untracked] = await Promise.all([
    runGit(cwd, ['diff', '--cached']),
    runGit(cwd, ['diff']),
    untrackedContext(cwd),
  ])
  const combined = [staged.stdout, unstaged.stdout, untracked].filter((part) => part !== '').join('\n')
  if (combined.length <= DIFF_CAP) return combined
  return `${combined.slice(0, DIFF_CAP)}\n\n[diff truncated]`
}

/** Per-file ceiling inside the untracked section; a binary or a huge file is named, not inlined. */
const UNTRACKED_FILE_CAP = 8_000

/** How many untracked files are read at once. The rest wait for the cap check. */
const UNTRACKED_BATCH = 8

/**
 * Contents of each untracked file, capped so one large file cannot fill the draft.
 *
 * Read directly rather than through `git diff --no-index`: that form needs a
 * null device, which is not portable, and git exits non-zero whenever the two
 * sides differ.
 */

async function untrackedContext(cwd: string): Promise<string> {
  const listed = await runGit(cwd, ['ls-files', '--others', '--exclude-standard', '-z'])
  const files = listed.stdout.split('\0').filter((file) => file !== '')
  const parts: string[] = []
  let used = 0
  for (let index = 0; index < files.length && used < DIFF_CAP; index += UNTRACKED_BATCH) {
    const batch = await Promise.all(files.slice(index, index + UNTRACKED_BATCH).map((file) => readUntracked(cwd, file)))
    for (const body of batch) {
      if (used >= DIFF_CAP) break
      parts.push(body)
      used += body.length
    }
  }
  return parts.join('\n')
}

/**
 * One untracked file's text, or a one-line note when it cannot be inlined.
 *
 * Only the capped prefix is read. One extra byte distinguishes a file that
 * fits from one that was cut; a NUL in that prefix marks a binary file.
 */
async function readUntracked(cwd: string, file: string): Promise<string> {
  const heading = `diff --git a/${file} b/${file}\nnew file`
  const handle = await open(path.join(cwd, file), 'r').catch(() => null)
  if (handle === null) return `${heading} ${file} (unreadable)`
  try {
    const buffer = Buffer.alloc(UNTRACKED_FILE_CAP + 1)
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
    const chunk = buffer.subarray(0, bytesRead)
    if (chunk.includes(0)) return `${heading} ${file} (binary, not shown)`
    const text = chunk.subarray(0, UNTRACKED_FILE_CAP).toString('utf8')
    const truncated = bytesRead > UNTRACKED_FILE_CAP ? '\n[file truncated]' : ''
    return `${heading} ${file}\n${text}${truncated}`
  }
  catch {
    return `${heading} ${file} (unreadable)`
  }
  finally {
    await handle.close()
  }
}

/**
 * Commit everything `git status` would list.
 *
 * Untracked and unstaged paths are staged first, so the button commits the
 * tree the panel is showing rather than only whatever was already staged.
 * `commit` prints the new hash on stdout; an empty index makes git exit
 * non-zero, which surfaces as {@link GitError}.
 */
export async function commitAll(cwd: string, message: string): Promise<string> {
  await runGit(cwd, ['add', '-A'])
  const { stdout } = await runGit(cwd, ['commit', '-m', message])
  const hash = /^\[(?:\S+) ([0-9a-f]+)\]/u.exec(stdout)?.[1]
  if (hash === undefined) throw new GitError('git commit did not report a hash')
  return hash
}
