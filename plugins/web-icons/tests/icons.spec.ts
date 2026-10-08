import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { expect, it } from 'vitest'
import {
  ASSET_DIRECTORY, assertIconsPresent, etagOf, ICON_ROUTES, inspectIcon, isMissing, matchesEtag, readIcon,
} from '../src/icons.ts'

it('claims one browser pathname per snapshotted asset', () => {
  const paths = ICON_ROUTES.map(route => route.path)
  expect(new Set(paths).size).toBe(paths.length)
  expect(new Set(ICON_ROUTES.map(route => route.asset)).size).toBe(ICON_ROUTES.length)
  for (const route of ICON_ROUTES) {
    expect(route.path.startsWith('/')).toBe(true)
    expect(route.asset).not.toContain('/')
  }
  expect(paths).toContain('/favicon.ico')
  expect(paths).toContain('/manifest.webmanifest')
  // The retired mark stays retired: the harness build must not ship it, so
  // claiming the pathname here would resurrect it on the browser surface.
  expect(paths).not.toContain('/favicon.svg')
})

it('serves each asset under the content type its extension implies', () => {
  const byType = (extension: string) => ICON_ROUTES.filter(route => route.asset.endsWith(extension))
  expect(byType('.ico').map(route => route.contentType)).toEqual(['image/vnd.microsoft.icon'])
  for (const route of byType('.png')) expect(route.contentType, route.asset).toBe('image/png')
  expect(byType('.png')).toHaveLength(5)
  expect(byType('.svg').map(route => route.contentType)).toEqual(['image/svg+xml'])
  expect(byType('.webmanifest').map(route => route.contentType)).toEqual(['application/manifest+json'])
})

it('resolves the snapshot beside this package, not from the working directory', () => {
  expect(ASSET_DIRECTORY.endsWith(`web-icons${sep}assets${sep}`)).toBe(true)
})

it('reads a snapshotted asset identity and its bytes', async () => {
  const file = await inspectIcon('favicon.ico')
  const body = await readIcon('favicon.ico')
  expect(file?.etag).toBe(etagOf(file!.size, file!.mtimeMs))
  expect(file?.etag).toMatch(/^W\/"\d+-\d+"$/)
  expect(file?.size).toBe(body?.byteLength)
  expect(body?.subarray(0, 4)).toEqual(Buffer.from([0x00, 0x00, 0x01, 0x00]))
})

it('reports an absent or non-file target as undefined rather than a failure', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'web-icons-'))
  try {
    await mkdir(join(directory, 'directory.png'))
    expect(await inspectIcon('nope.png', directory)).toBeUndefined()
    expect(await inspectIcon('directory.png', directory)).toBeUndefined()
    expect(await readIcon('nope.png', directory)).toBeUndefined()
    expect(await readIcon('directory.png', directory)).toBeUndefined()
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

it('propagates a failure that is not an absent file', async () => {
  // A path Node rejects outright stands in for any read failure the filesystem
  // reports with a code of its own.
  const directory = await mkdtemp(join(tmpdir(), 'web-icons-'))
  try {
    await expect(inspectIcon('nul\u0000name', directory)).rejects.toThrow()
    await expect(readIcon('nul\u0000name', directory)).rejects.toThrow()
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

it('classifies only a coded absent-file rejection as absence', () => {
  expect(isMissing(Object.assign(new Error('gone'), { code: 'ENOENT' }))).toBe(true)
  expect(isMissing(Object.assign(new Error('isdir'), { code: 'EISDIR' }))).toBe(true)
  expect(isMissing(Object.assign(new Error('notdir'), { code: 'ENOTDIR' }))).toBe(true)
  expect(isMissing(Object.assign(new Error('denied'), { code: 'EACCES' }))).toBe(false)
  // A rejection with no code is a failure, not a missing file: reporting it as
  // absence would hide the real cause behind "snapshot is missing".
  expect(isMissing(new Error('no code'))).toBe(false)
  expect(isMissing('thrown string')).toBe(false)
  expect(isMissing(null)).toBe(false)
})

it('accepts a complete snapshot and names the files an incomplete one lacks', async () => {
  await expect(assertIconsPresent()).resolves.toBeUndefined()
  // One present asset among the requested routes keeps the report to the files
  // actually missing.
  await expect(assertIconsPresent([ICON_ROUTES[0]!, ICON_ROUTES[1]!])).resolves.toBeUndefined()
  const directory = await mkdtemp(join(tmpdir(), 'web-icons-'))
  try {
    const failure = await assertIconsPresent(ICON_ROUTES, directory).catch((error: unknown) => error)
    expect(String(failure)).toContain('web-icons: snapshot is missing')
    expect(String(failure)).toContain(join(directory, 'favicon.ico'))
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

it('moves the validator when the snapshot is refreshed in place', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'web-icons-'))
  try {
    const target = join(directory, 'favicon.ico')
    await writeFile(target, 'first')
    const before = await inspectIcon('favicon.ico', directory)
    await writeFile(target, 'second-version')
    const after = await inspectIcon('favicon.ico', directory)
    expect(before?.etag).toBeDefined()
    expect(after?.etag).not.toBe(before?.etag)
    // A client holding the replaced bytes must not be told it is current.
    expect(matchesEtag(before!.etag, after!.etag)).toBe(false)
    expect(await readIcon('favicon.ico', directory)).toEqual(Buffer.from('second-version'))
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

it('matches a validator the client already holds, ignoring weakness on both sides', () => {
  const etag = etagOf(15086, 1_700_000_000_123)
  expect(etag).toBe('W/"15086-1700000000123"')
  expect(matchesEtag(undefined, etag)).toBe(false)
  expect(matchesEtag('*', etag)).toBe(true)
  expect(matchesEtag('W/"15086-1700000000123"', etag)).toBe(true)
  expect(matchesEtag('"15086-1700000000123"', etag)).toBe(true)
  expect(matchesEtag('W/"1-2", W/"15086-1700000000123"', etag)).toBe(true)
  expect(matchesEtag('W/"15086-1700000000124"', etag)).toBe(false)
})
