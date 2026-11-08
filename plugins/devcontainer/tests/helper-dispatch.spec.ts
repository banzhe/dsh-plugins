import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { join, posix } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { cleanupTemporaryDirectories, temporaryDirectory } from './support.ts'
import { realpathSync } from 'node:fs'

afterAll(cleanupTemporaryDirectories)

/** The helper program, driven in this process. */
interface Helper {
  handle(method: string, params?: unknown): Promise<unknown>
}

let instances = 0

/**
 * Load a fresh helper instance and complete its handshake.
 * @param workspace - the container directory the helper treats as home.
 * @returns the program, ready for requests.
 */
async function helperFor(workspace: string): Promise<Helper> {
  const helper = await unhandshaken()
  await helper.handle('hello', { protocol: 3, workspace })
  return helper
}

/** Load a fresh helper instance that has not been handshaken yet. */
async function unhandshaken(): Promise<Helper> {
  instances += 1
  const loaded: unknown = await import(/* @vite-ignore */ `../src/helper/main.mjs?v=${instances}`)
  return loaded as Helper
}

/** A POSIX spelling of one host directory, which the helper accepts on any platform. */
function containerPathOf(root: string): string {
  return root.split('\\').join('/')
}

/** One workspace plus its helper, shared by the tests that need a repository tree. */
async function workspace(files: Record<string, string> = {}): Promise<{ root: string, helper: Helper }> {
  const source = temporaryDirectory()
  for (const [relative, content] of Object.entries(files)) {
    const absolute = join(source, ...relative.split('/'))
    mkdirSync(join(absolute, '..'), { recursive: true })
    writeFileSync(absolute, content, 'utf8')
  }
  const root = realpathSync(source)
  return { root, helper: await helperFor(containerPathOf(root)) }
}

/** A target for one path inside a workspace. */
async function targetOf(helper: Helper, path: string): Promise<{ targetKey: string, displayPath: string }> {
  return await helper.handle('fs.resolve', { path }) as { targetKey: string, displayPath: string }
}

describe('the container helper handshake', () => {
  it('reports the protocol, the runtime and the workspace it will serve', async () => {
    const helper = await unhandshaken()
    const greeting = await helper.handle('hello', { protocol: 3, workspace: '/workspaces/demo' }) as Record<string, unknown>
    expect(greeting['protocol']).toBe(3)
    expect(greeting['workspace']).toBe('/workspaces/demo')
    expect(typeof greeting['nodeVersion']).toBe('string')
  })

  it('answers a ping once handshaken', async () => {
    const { helper } = await workspace()
    const answer = await helper.handle('ping') as { pong: boolean, now: number }
    expect(answer.pong).toBe(true)
    expect(typeof answer.now).toBe('number')
  })

  it('refuses an operation before the handshake', async () => {
    const helper = await unhandshaken()
    await expect(helper.handle('ping')).rejects.toThrow('handshake required')
  })

  it('refuses a second handshake and an unknown operation', async () => {
    const { helper } = await workspace()
    await expect(helper.handle('hello', { protocol: 3, workspace: '/workspaces/demo' }))
      .rejects.toThrow('handshake already completed')
    await expect(helper.handle('fs.nope')).rejects.toThrow('unknown operation')
  })
})

describe('the container helper path handling', () => {
  it('resolves a container path to a stable identity', async () => {
    const { root, helper } = await workspace({ 'src/a.ts': 'export {}\n' })
    const target = await targetOf(helper, posix.join(containerPathOf(root), 'src/a.ts'))
    expect(target.targetKey).toBe(posix.join(containerPathOf(root), 'src/a.ts'))
    expect(target.displayPath).toBe(posix.join(containerPathOf(root), 'src/a.ts'))
  })

  it('resolves a relative path against the requested cwd', async () => {
    const { root, helper } = await workspace({ 'src/a.ts': '' })
    const target = await targetOf(helper, 'a.ts')
    expect(target.targetKey.endsWith('/src/a.ts')).toBe(false)
    const located = await helper.handle('fs.resolve', {
      path: 'a.ts',
      cwd: posix.join(containerPathOf(root), 'src'),
    }) as { targetKey: string }
    expect(located.targetKey).toBe(posix.join(containerPathOf(root), 'src/a.ts'))
  })

  it('accepts the drive-mangled spelling win32 leaves on a container path', async () => {
    // The mangling only exists for a POSIX mount, so this instance is mounted
    // the way a real container is; nothing is read from it.
    const helper = await helperFor('/workspaces/demo')
    const mangled = 'C:\\workspaces\\demo\\src\\a.ts'
    const target = await helper.handle('fs.resolve', { path: mangled }) as { displayPath: string }
    expect(target.displayPath).toBe('/workspaces/demo/src/a.ts')
  })

  it('refuses an empty path', async () => {
    const { helper } = await workspace()
    await expect(helper.handle('fs.resolve', { path: '  ' })).rejects.toMatchObject({ code: 'FS_NOT_FOUND' })
  })
})

describe('the container helper metadata', () => {
  it('reports a file, a directory and a link without following it', async () => {
    const { root, helper } = await workspace({ 'a.ts': 'x', 'dir/b.ts': 'y' })
    // A junction is a directory link on every platform and needs no privilege
    // on Windows, where a file symlink does.
    symlinkSync(join(root, 'dir'), join(root, 'linked'), 'junction')
    const base = containerPathOf(root)
    expect((await helper.handle('fs.lstat', { path: posix.join(base, 'a.ts') }) as { type: string }).type).toBe('file')
    expect((await helper.handle('fs.lstat', { path: posix.join(base, 'dir') }) as { type: string }).type).toBe('directory')
    expect((await helper.handle('fs.lstat', { path: posix.join(base, 'linked') }) as { type: string }).type).toBe('symlink')
    expect(await helper.handle('fs.lstat', { path: posix.join(base, 'missing.ts') })).toBeNull()
  })

  it('follows the link for stat and reports the target version', async () => {
    const { root, helper } = await workspace({ 'dir/b.ts': 'x' })
    symlinkSync(join(root, 'dir'), join(root, 'linked'), 'junction')
    const target = await targetOf(helper, posix.join(containerPathOf(root), 'linked/b.ts'))
    const info = await helper.handle('fs.stat', { target }) as { type: string, size: number, version: string }
    expect(info.type).toBe('file')
    expect(info.size).toBe(1)
    expect(info.version).toContain(':')
  })
})

describe('the container helper reads', () => {
  it('returns the file text and refuses what is not text', async () => {
    const { root, helper } = await workspace({ 'a.ts': 'export {}\n', 'bin.dat': 'a\u0000b', 'dir/b.ts': '' })
    const base = containerPathOf(root)
    expect(await helper.handle('fs.readText', { target: await targetOf(helper, posix.join(base, 'a.ts')) }))
      .toBe('export {}\n')
    await expect(helper.handle('fs.readText', { target: await targetOf(helper, posix.join(base, 'bin.dat')) }))
      .rejects.toMatchObject({ code: 'FS_NOT_TEXT' })
    await expect(helper.handle('fs.readText', { target: await targetOf(helper, posix.join(base, 'dir')) }))
      .rejects.toMatchObject({ code: 'FS_NOT_REGULAR_FILE' })
    await expect(helper.handle('fs.readText', { target: await targetOf(helper, posix.join(base, 'missing.ts')) }))
      .rejects.toMatchObject({ code: 'FS_NOT_FOUND' })
  })

  it('returns bytes and a byte window as base64', async () => {
    const { root, helper } = await workspace({ 'a.txt': 'abcdef' })
    const target = await targetOf(helper, posix.join(containerPathOf(root), 'a.txt'))
    expect(Buffer.from(await helper.handle('fs.readBytes', { target, maxBytes: 1024 }) as string, 'base64').toString())
      .toBe('abcdef')
    expect(Buffer.from(await helper.handle('fs.readRange', { target, offset: 2, length: 3 }) as string, 'base64').toString())
      .toBe('cde')
    await expect(helper.handle('fs.readBytes', { target, maxBytes: 2 })).rejects.toMatchObject({ code: 'FS_TOO_LARGE' })
  })

  it('refuses a read whose real target leaves the workspace', async () => {
    const { root, helper } = await workspace({ 'dir/b.ts': 'inside\n' })
    const outside = temporaryDirectory()
    writeFileSync(join(outside, 'secret.txt'), 'TOP SECRET\n')
    // A junction is a directory link on every platform and needs no privilege on
    // Windows, where a file symlink does.
    symlinkSync(outside, join(root, 'linked'), 'junction')
    const base = containerPathOf(root)
    // The identity the host fenced can be repointed outside the workspace between
    // that check and the read; the helper resolves it again before the I/O.
    const escaped = {
      targetKey: posix.join(base, 'linked/secret.txt'),
      displayPath: posix.join(base, 'linked/secret.txt'),
    }
    for (const call of [
      () => helper.handle('fs.readText', { target: escaped }),
      () => helper.handle('fs.readBytes', { target: escaped, maxBytes: 1024 }),
      () => helper.handle('fs.readRange', { target: escaped, offset: 0, length: 4 }),
      () => helper.handle('fs.stream', { target: escaped }),
    ]) {
      await expect(call()).rejects.toMatchObject({ code: 'FS_PERMISSION_DENIED' })
    }

    // A link that stays inside the workspace still reads through the same check.
    symlinkSync(join(root, 'dir'), join(root, 'inside'), 'junction')
    const insideLink = {
      targetKey: posix.join(base, 'inside/b.ts'),
      displayPath: posix.join(base, 'inside/b.ts'),
    }
    expect(await helper.handle('fs.readText', { target: insideLink })).toBe('inside\n')
  })

  it('streams a file in chunks until it ends', async () => {
    const { root, helper } = await workspace({ 'a.txt': 'one\ntwo\n' })
    const target = await targetOf(helper, posix.join(containerPathOf(root), 'a.txt'))
    const { id } = await helper.handle('fs.stream', { target }) as { id: string }
    let text = ''
    for (;;) {
      const step = await helper.handle('fs.next', { id }) as { done: boolean, value: string }
      if (step.done) break
      text += step.value
    }
    expect(text).toBe('one\ntwo\n')
    await expect(helper.handle('fs.next', { id })).rejects.toThrow('unknown text stream')
    await expect(helper.handle('fs.streamClose', { id })).resolves.toBeNull()
  })
})

describe('the container helper listings', () => {
  it('lists direct children in name order with their targets', async () => {
    const { root, helper } = await workspace({ 'dir/b.ts': '', 'dir/a.ts': '', 'dir/sub/c.ts': '' })
    const base = containerPathOf(root)
    const listing = await helper.handle('fs.list', { target: await targetOf(helper, posix.join(base, 'dir')) }) as
      { name: string, type: string, target: { targetKey: string } }[]
    expect(listing.map(entry => entry.name)).toEqual(['a.ts', 'b.ts', 'sub'])
    expect(listing.map(entry => entry.type)).toEqual(['file', 'file', 'directory'])
    expect(listing[0]?.target.targetKey).toBe(posix.join(base, 'dir/a.ts'))
  })

  it('refuses a target that is not a directory', async () => {
    const { root, helper } = await workspace({ 'a.ts': '' })
    const target = await targetOf(helper, posix.join(containerPathOf(root), 'a.ts'))
    await expect(helper.handle('fs.list', { target })).rejects.toMatchObject({ code: 'FS_NOT_DIRECTORY' })
    await expect(helper.handle('fs.list', { target: { targetKey: posix.join(containerPathOf(root), 'gone') } }))
      .rejects.toMatchObject({ code: 'FS_NOT_FOUND' })
  })
})

describe('the container helper writes', () => {
  it('creates and then replaces a file, reporting the diff basis', async () => {
    const { root, helper } = await workspace()
    const path = posix.join(containerPathOf(root), 'new.ts')
    const created = await helper.handle('fs.write', { target: { targetKey: path, displayPath: path }, content: 'one\n' }) as
      { operation: string, before: string | null, after: string }
    expect(created.operation).toBe('create')
    expect(created.before).toBeNull()
    expect(created.after).toBe('one\n')
    const replaced = await helper.handle('fs.write', { target: { targetKey: path, displayPath: path }, content: 'two\n' }) as
      { operation: string, before: string | null }
    expect(replaced.operation).toBe('update')
    expect(replaced.before).toBe('one\n')
  })

  it('honours both guards', async () => {
    const { root, helper } = await workspace({ 'a.ts': 'one\n' })
    const path = posix.join(containerPathOf(root), 'a.ts')
    const target = { targetKey: path, displayPath: path }
    await expect(helper.handle('fs.write', { target, content: 'x', expected: { kind: 'createIfAbsent' } }))
      .rejects.toMatchObject({ code: 'FS_NOT_OBSERVED' })
    await expect(helper.handle('fs.write', { target, content: 'x', expected: { kind: 'replaceIfVersion', version: 'stale' } }))
      .rejects.toMatchObject({ code: 'FS_STALE_VERSION' })
    await expect(helper.handle('fs.write', {
      target: { targetKey: posix.join(containerPathOf(root), 'gone.ts'), displayPath: 'gone.ts' },
      content: 'x',
      expected: { kind: 'replaceIfVersion', version: 'stale' },
    })).rejects.toMatchObject({ code: 'FS_STALE_VERSION' })
  })

  it('edits literal text, keeps CRLF, and refuses ambiguity', async () => {
    const { root, helper } = await workspace({ 'a.ts': 'one\r\ntwo\r\n' })
    const path = posix.join(containerPathOf(root), 'a.ts')
    const target = { targetKey: path, displayPath: path }
    const edited = await helper.handle('fs.edit', { target, edit: { oldString: 'two', newString: 'three', replaceAll: false } }) as
      { before: string, after: string }
    expect(edited.before).toBe('one\ntwo\n')
    expect(edited.after).toBe('one\nthree\n')
    const stored = await helper.handle('fs.readText', { target }) as string
    expect(stored).toBe('one\r\nthree\r\n')
    await expect(helper.handle('fs.edit', { target, edit: { oldString: 'absent', newString: 'x', replaceAll: false } }))
      .rejects.toMatchObject({ code: 'FS_EDIT_NOT_FOUND' })
    await helper.handle('fs.write', { target, content: 'same\nsame\n' })
    await expect(helper.handle('fs.edit', { target, edit: { oldString: 'same', newString: 'x', replaceAll: false } }))
      .rejects.toMatchObject({ code: 'FS_AMBIGUOUS_EDIT' })
  })

  it('applies hunks and reports a mismatch', async () => {
    const { root, helper } = await workspace({ 'a.ts': 'one\ntwo\n' })
    const path = posix.join(containerPathOf(root), 'a.ts')
    const target = { targetKey: path, displayPath: path }
    const patched = await helper.handle('fs.patch', {
      target,
      hunks: [{ lineNumber: 1, oldLines: ['two'], newLines: ['three'], isEndOfFile: false }],
    }) as { after: string }
    expect(patched.after).toBe('one\nthree\n')
    await expect(helper.handle('fs.patch', {
      target,
      hunks: [{ lineNumber: 1, oldLines: ['absent'], newLines: ['x'], isEndOfFile: false }],
    })).rejects.toMatchObject({ code: 'FS_PATCH_MISMATCH' })
  })

  it('deletes and moves a file', async () => {
    const { root, helper } = await workspace({ 'a.ts': 'one\n', 'b.ts': 'two\n' })
    const base = containerPathOf(root)
    const source = { targetKey: posix.join(base, 'a.ts'), displayPath: posix.join(base, 'a.ts') }
    const destination = { targetKey: posix.join(base, 'c.ts'), displayPath: posix.join(base, 'c.ts') }
    const moved = await helper.handle('fs.move', { source, destination, options: {} }) as
      { sourceDeleted: boolean, destination: { operation: string } }
    expect(moved.sourceDeleted).toBe(true)
    expect(moved.destination.operation).toBe('create')
    expect(await helper.handle('fs.readText', { target: destination })).toBe('one\n')
    await expect(helper.handle('fs.move', { source: destination, destination, options: {} }))
      .rejects.toMatchObject({ code: 'FS_SAME_TARGET' })

    const removed = await helper.handle('fs.delete', { target: destination }) as { before: string | null }
    expect(removed.before).toBe('one\n')
    await expect(helper.handle('fs.readText', { target: destination })).rejects.toMatchObject({ code: 'FS_NOT_FOUND' })
  })
})

describe('the container helper failure mapping', () => {
  it('turns a POSIX errno into the shared filesystem code', async () => {
    const { root, helper } = await workspace({ 'a.ts': '' })
    const base = containerPathOf(root)
    // A file used as a directory is ENOTDIR for the OS and "absent" for the
    // resolver, which keeps the seam's taxonomy instead of leaking an errno.
    const nested = await helper.handle('fs.resolve', { path: posix.join(base, 'a.ts', 'child.ts') }) as { targetKey: string }
    expect(nested.targetKey.startsWith(base)).toBe(true)
    await expect(helper.handle('fs.stat', { target: { targetKey: posix.join(base, 'a.ts', 'child.ts') } }))
      .resolves.toBeNull()
  })
})
