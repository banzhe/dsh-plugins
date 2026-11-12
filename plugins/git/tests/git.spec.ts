import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { GitError, commitAll, readChangeContext, readStatus, resolveRepoRoot } from '../src/git.ts'

/**
 * Every git call these tests make — the ones driven here and the ones the
 * subject spawns — must stay inside the scratch directory and must not read the
 * developer's global or system config: a stray `user.name` or commit hook there
 * would change what the assertions see, and a stray repository above %TEMP%
 * would change what `resolveRepoRoot` finds.
 */
const overridden = [
  'GIT_CONFIG_GLOBAL',
  'GIT_CONFIG_NOSYSTEM',
  'GIT_CEILING_DIRECTORIES',
  'GIT_AUTHOR_NAME',
  'GIT_AUTHOR_EMAIL',
  'GIT_COMMITTER_NAME',
  'GIT_COMMITTER_EMAIL',
] as const

const TOTAL_LIMIT = 24000
const TRUNCATION_SUFFIX = '\n\n[diff truncated]'

const previousEnvironment = new Map<string, string | undefined>()
let scratch = ''

beforeEach(async () => {
  scratch = await realpath(await mkdtemp(join(tmpdir(), 'dsh-git-')))
  const emptyConfig = join(scratch, 'empty-gitconfig')
  await writeFile(emptyConfig, '')
  const values: Record<(typeof overridden)[number], string> = {
    GIT_CONFIG_GLOBAL: emptyConfig,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CEILING_DIRECTORIES: tmpdir(),
    GIT_AUTHOR_NAME: 'DSH Test',
    GIT_AUTHOR_EMAIL: 'dsh-test@example.invalid',
    GIT_COMMITTER_NAME: 'DSH Test',
    GIT_COMMITTER_EMAIL: 'dsh-test@example.invalid',
  }
  for (const name of overridden) {
    previousEnvironment.set(name, process.env[name])
    process.env[name] = values[name]
  }
})

afterEach(async () => {
  for (const name of overridden) {
    const value = previousEnvironment.get(name)
    if (value === undefined) Reflect.deleteProperty(process.env, name)
    else process.env[name] = value
  }
  previousEnvironment.clear()
  await rm(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
})

function git(cwd: string, ...args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, env: process.env }, (error, stdout) => {
      if (error !== null) {
        reject(new Error(error.message))
        return
      }
      resolve(stdout)
    })
  })
}

async function repository(name = 'repo'): Promise<string> {
  const root = join(scratch, name)
  await mkdir(root, { recursive: true })
  await git(root, 'init', '-b', 'main')
  return root
}

async function write(root: string, relative: string, content: string | Buffer): Promise<void> {
  const target = join(root, relative)
  await mkdir(dirname(target), { recursive: true })
  await writeFile(target, content)
}

async function commitBase(root: string, files: Record<string, string | Buffer>): Promise<void> {
  for (const [relative, content] of Object.entries(files)) await write(root, relative, content)
  await git(root, 'add', '--all')
  await git(root, 'commit', '-m', 'base')
}

function byPath<T extends { path: string }>(changes: readonly T[]): T[] {
  return [...changes].sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0))
}

function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => undefined,
    (reason: unknown) => reason,
  )
}

it('refuses a directory that is not inside a repository', async () => {
  const plain = join(scratch, 'plain')
  await mkdir(plain, { recursive: true })
  const reason = await rejectionOf(resolveRepoRoot(plain))
  expect(reason).toBeInstanceOf(GitError)
  expect((reason as Error).name).toBe('GitError')
})

it('resolves the realpath of the repository root from a nested directory', async () => {
  const root = await repository()
  const nested = join(root, 'packages', 'app')
  await mkdir(nested, { recursive: true })
  const expected = await realpath(root)
  expect(await resolveRepoRoot(root)).toBe(expected)
  expect(await resolveRepoRoot(nested)).toBe(expected)
  expect(await resolveRepoRoot(join(nested, '..', '..'))).toBe(expected)
})

it('names the branch and reports no changes for a clean repository', async () => {
  const root = await repository()
  await commitBase(root, { 'a.txt': 'a\n' })
  expect(await readStatus(root)).toEqual({ branch: 'main', changes: [] })
})

it('lists every change kind with forward-slash paths', async () => {
  const root = await repository()
  await commitBase(root, {
    'modified.txt': 'one\n',
    'deleted.txt': 'gone\n',
    'renamed.txt': 'moved\n',
    'src/nested/deep.txt': 'nested\n',
  })
  await mkdir(join(root, 'moved', 'deep'), { recursive: true })
  await write(root, 'staged.txt', 'staged\n')
  await git(root, 'add', 'staged.txt')
  await write(root, 'modified.txt', 'two\n')
  await git(root, 'rm', 'deleted.txt')
  await git(root, 'mv', 'renamed.txt', 'moved/deep/renamed.txt')
  await write(root, 'src/nested/deep.txt', 'nested again\n')
  await write(root, 'untracked.txt', 'untracked\n')

  const status = await readStatus(root)
  expect(status.branch).toBe('main')
  expect(byPath(status.changes)).toEqual(
    byPath([
      { path: 'staged.txt', status: 'added' },
      { path: 'modified.txt', status: 'modified' },
      { path: 'deleted.txt', status: 'deleted' },
      { path: 'moved/deep/renamed.txt', status: 'renamed' },
      { path: 'src/nested/deep.txt', status: 'modified' },
      { path: 'untracked.txt', status: 'untracked' },
    ]),
  )
})

it('answers a null branch for a detached HEAD', async () => {
  const root = await repository()
  await commitBase(root, { 'a.txt': 'a\n' })
  await git(root, 'checkout', '--detach')
  const status = await readStatus(root)
  expect(status.branch).toBeNull()
  expect(status.changes).toEqual([])
})

it('answers an empty context when nothing changed', async () => {
  const root = await repository()
  await commitBase(root, { 'a.txt': 'a\n' })
  expect(await readChangeContext(root)).toBe('')
})

it('covers staged, unstaged, and untracked changes', async () => {
  const root = await repository()
  await commitBase(root, { 'staged.txt': 'before\n', 'unstaged.txt': 'before\n' })
  await write(root, 'staged.txt', 'staged-after\n')
  await git(root, 'add', 'staged.txt')
  await write(root, 'unstaged.txt', 'unstaged-after\n')
  await write(root, 'untracked.txt', 'untracked-body\n')

  const context = await readChangeContext(root)
  expect(context).toContain('staged.txt')
  expect(context).toContain('staged-after')
  expect(context).toContain('unstaged.txt')
  expect(context).toContain('unstaged-after')
  expect(context).toContain('untracked.txt')
  expect(context).toContain('untracked-body')
})

it('labels a binary file instead of pasting its bytes', async () => {
  const root = await repository()
  await commitBase(root, { 'a.txt': 'a\n' })
  await write(root, 'blob.bin', Buffer.from([0, 1, 2, 3, 0, 255, 254, 10]))

  const context = await readChangeContext(root)
  expect(context).toContain('(binary, not shown)')
  expect(context.includes('\u0000')).toBe(false)
})

it('truncates one oversized file with a marker', async () => {
  const root = await repository()
  await commitBase(root, { 'a.txt': 'a\n' })
  await write(root, 'long.txt', `${'y'.repeat(20000)}\n`)

  const context = await readChangeContext(root)
  expect(context).toContain('[file truncated]')
  expect(context.length).toBeLessThan(8200)
})

it('stops the whole context at 24000 bytes with a trailing marker', async () => {
  const root = await repository()
  const names = ['bulk-1.txt', 'bulk-2.txt', 'bulk-3.txt', 'bulk-4.txt', 'bulk-5.txt', 'bulk-6.txt']
  const seeded: Record<string, string> = {}
  for (const name of names) seeded[name] = 'seed\n'
  await commitBase(root, seeded)
  for (const name of names) await write(root, name, `${name}\n${'z'.repeat(6000)}\n`)
  await git(root, 'add', '--all')

  const context = await readChangeContext(root)
  expect(context.endsWith(TRUNCATION_SUFFIX)).toBe(true)
  expect(context.length).toBeLessThanOrEqual(TOTAL_LIMIT + TRUNCATION_SUFFIX.length)
})

it('stages everything, including untracked files, and returns the commit hash', async () => {
  const root = await repository()
  await commitBase(root, { 'tracked.txt': 'before\n' })
  await write(root, 'tracked.txt', 'after\n')
  await write(root, 'fresh/nested.txt', 'new\n')

  const hash = await commitAll(root, 'feat: everything')
  expect(hash).toMatch(/^[0-9a-f]{7,40}$/)
  expect((await git(root, 'rev-parse', 'HEAD')).trim().startsWith(hash)).toBe(true)
  expect((await git(root, 'log', '-1', '--pretty=%s')).trim()).toBe('feat: everything')
  expect((await git(root, 'ls-files')).split('\n').filter(line => line.length > 0)).toContain('fresh/nested.txt')
  expect((await readStatus(root)).changes).toEqual([])
})

it('rejects with GitError when there is nothing to commit', async () => {
  const root = await repository()
  await commitBase(root, { 'a.txt': 'a\n' })
  const reason = await rejectionOf(commitAll(root, 'empty'))
  expect(reason).toBeInstanceOf(GitError)
  expect((reason as Error).name).toBe('GitError')
})
