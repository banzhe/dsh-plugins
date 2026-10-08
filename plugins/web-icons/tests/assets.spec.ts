import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { ASSET_DIRECTORY, ICON_ROUTES } from '../src/icons.ts'

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

/**
 * One signature check per media type the takeover set uses. A media type with no
 * entry fails the loop below, so a new route cannot skip verification by being
 * neither ICO, PNG nor SVG.
 */
const SIGNATURES: Record<string, (bytes: Buffer) => void> = {
  'image/vnd.microsoft.icon': (bytes) => { expect([...bytes.subarray(0, 4)]).toEqual([0x00, 0x00, 0x01, 0x00]) },
  'image/png': (bytes) => { expect(bytes.subarray(0, 8)).toEqual(PNG_SIGNATURE) },
  'image/svg+xml': (bytes) => { expect(bytes.toString('utf8').trimStart().startsWith('<svg')).toBe(true) },
  'application/manifest+json': (bytes) => { expect(typeof JSON.parse(bytes.toString('utf8'))).toBe('object') },
}

/**
 * The snapshot is a copy of artwork this repository does not author, so these
 * specs pin what the plugin's behavior depends on — every file is present, is the
 * format its media type claims, and the manifest describes the icon set — rather
 * than bytes that a re-sync is expected to replace.
 */
it('ships every snapshotted asset in the format its media type claims', async () => {
  for (const route of ICON_ROUTES) {
    const bytes = await readFile(join(ASSET_DIRECTORY, route.asset))
    expect(bytes.byteLength, route.asset).toBeGreaterThan(0)
    const signature = SIGNATURES[route.contentType]
    if (signature === undefined) throw new Error(`no signature check for ${route.contentType} (${route.asset})`)
    signature(bytes)
  }
})

it('carries the install metadata the manifest must declare', async () => {
  const manifest: unknown = JSON.parse(await readFile(join(ASSET_DIRECTORY, 'manifest.webmanifest'), 'utf8'))
  expect(manifest).toEqual({
    id: '/',
    name: 'DeepSeek Harness',
    short_name: 'DSH',
    start_url: '/',
    scope: '/',
    display: 'fullscreen',
    icons: [
      { src: '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: '/icon-maskable-192.png', sizes: '192x192', type: 'image/png', purpose: 'maskable' },
      { src: '/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  })
})

it('makes the manifest reference only pathnames this plugin claims', async () => {
  const manifest = JSON.parse(await readFile(join(ASSET_DIRECTORY, 'manifest.webmanifest'), 'utf8')) as {
    icons: { src: string }[]
  }
  const claimed = new Set(ICON_ROUTES.map(route => route.path))
  for (const icon of manifest.icons) expect(claimed.has(icon.src), icon.src).toBe(true)
})
