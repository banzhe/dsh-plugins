/**
 * Client bundle contract: the [node, client] pair of tsdown configs the helper
 * hands back, asserted on the values a build consumes. No build is run, and
 * nothing here depends on how the configs are put together.
 */
import { afterEach, describe, expect, it } from 'vitest'
import type { UserConfig } from 'tsdown'
import { clientBundle, PLATFORM_MODULES } from '../src/index.ts'

const ID = '@banzhe/dsh-fixture'

/** The modules the host page already serves: externalised, never bundled. */
const HOST_MODULES = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  'zod',
  '@tanstack/react-virtual',
  '@deepseek-ai/dsh-client-store',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-dockkit',
]

const STYLESHEETS = ['dsh-css-modules', 'dsh-css-global', 'dsh-css-inline']

const FOOTER = 'return module.exports; } });'
const INTRO = 'var module = { exports: {} }; var exports = module.exports;'

interface NodeOptions {
  entry?: string | Readonly<Record<string, string>>
  clean?: boolean
  copy?: readonly { from: string; to: string }[]
}

interface ClientBundleOptions {
  id: string
  clientEntry?: string
  node?: NodeOptions
  externals?: readonly string[]
  css?: boolean | { registry?: boolean }
}

/** The fields of a rendered chunk the client banner may read. */
interface RenderedChunkProbe {
  fileName: string
  isEntry: boolean
  name: string
}

const ENTRY_CHUNK: RenderedChunkProbe = { fileName: 'client.js', isEntry: true, name: 'client' }
const EXTRA_CHUNK: RenderedChunkProbe = { fileName: 'client.vendor-7f3a.js', isEntry: false, name: 'vendor-7f3a' }

function configs(options: ClientBundleOptions = { id: ID }): { node: UserConfig; client: UserConfig } {
  const produced = clientBundle(options)
  expect(produced).toHaveLength(2)
  const [node, client] = produced
  if (node === undefined || client === undefined) throw new Error('clientBundle() must return two configs')
  return { node, client }
}

function outputOptionsOf(client: UserConfig) {
  const options = client.outputOptions
  if (typeof options !== 'object' || options === null) {
    throw new Error('client.outputOptions must be an object')
  }
  return options
}

function bannerText(client: UserConfig, chunk: RenderedChunkProbe): string {
  const banner = outputOptionsOf(client).banner
  if (typeof banner !== 'function') throw new Error('client.outputOptions.banner must be a function')
  // The banner receives a rendered chunk; the probe carries only the fields it may read.
  const text: unknown = banner(chunk as unknown as Parameters<typeof banner>[0])
  if (typeof text !== 'string') throw new Error('the client banner must return a string')
  return text
}

function neverBundleOf(client: UserConfig): readonly (string | RegExp)[] {
  const value = client.deps?.neverBundle
  if (!Array.isArray(value)) throw new Error('client.deps.neverBundle must be a list')
  return value
}

function alwaysBundleOf(client: UserConfig) {
  const value = client.deps?.alwaysBundle
  if (typeof value !== 'function') throw new Error('client.deps.alwaysBundle must be a function')
  return value
}

function pluginNames(plugins: UserConfig['plugins']): string[] {
  const names: string[] = []
  const visit = (slot: unknown): void => {
    if (Array.isArray(slot)) {
      for (const item of slot) visit(item)
      return
    }
    if (slot === undefined || slot === null || slot === false) return
    if (typeof slot !== 'object') throw new Error('a plugin slot is neither a plugin nor an empty slot')
    const name = (slot as { name?: unknown }).name
    if (typeof name !== 'string') throw new Error('a stylesheet plugin has no name')
    names.push(name)
  }
  visit(plugins)
  return names
}

describe('PLATFORM_MODULES', () => {
  it('lists the host-provided modules in the order the loader expects', () => {
    expect(PLATFORM_MODULES).toEqual(HOST_MODULES)
  })
})

describe('the returned pair', () => {
  it('hands back the node build first and the browser build second', () => {
    const produced = clientBundle({ id: ID })

    expect(produced).toHaveLength(2)
    expect(produced[0]?.platform).toBe('node')
    expect(produced[1]?.platform).toBe('browser')
  })
})

describe('the node config', () => {
  it('builds src/index.ts as ESM with declarations, by default', () => {
    const { node } = configs()

    expect(node.entry).toEqual(['src/index.ts'])
    expect(node.outDir).toBe('lib')
    expect(node.format).toEqual(['esm'])
    expect(node.platform).toBe('node')
    expect(node.dts).toBe(true)
    expect(node.fixedExtension).toBe(false)
    expect(node.clean).toBe(false)
    expect(node.copy).toBeUndefined()
  })

  it('passes a string entry override through', () => {
    const { node } = configs({ id: ID, node: { entry: 'src/main.ts' } })

    expect(node.entry).toBe('src/main.ts')
  })

  it('passes a named entry override through', () => {
    const entry = { index: 'src/one.ts', cli: 'src/two.ts' }
    const { node } = configs({ id: ID, node: { entry } })

    expect(node.entry).toEqual(entry)
  })

  it('passes clean and copy through', () => {
    const copy = [{ from: 'assets', to: 'lib/assets' }]
    const { node } = configs({ id: ID, node: { clean: true, copy } })

    expect(node.clean).toBe(true)
    expect(node.copy).toEqual(copy)
    // Each override stands alone: the entry stays at its default.
    expect(node.entry).toEqual(['src/index.ts'])
  })
})

describe('the client config', () => {
  it('builds src/client/index.ts as CommonJS for the browser, by default', () => {
    const { client } = configs()

    expect(client.entry).toEqual({ client: 'src/client/index.ts' })
    expect(client.outDir).toBe('lib')
    expect(client.format).toBe('cjs')
    expect(client.platform).toBe('browser')
    expect(client.dts).toBe(false)
    expect(client.clean).toBe(false)
    expect(client.sourcemap).toBe(true)
  })

  it('points the client entry at the caller path', () => {
    const { client } = configs({ id: ID, clientEntry: 'src/client/custom.ts' })

    expect(client.entry).toEqual({ client: 'src/client/custom.ts' })
  })

  it('shapes the output as one client.js entry plus named chunks', () => {
    const output = outputOptionsOf(configs().client)

    expect(output.entryFileNames).toBe('client.js')
    expect(output.chunkFileNames).toBe('client.[name].js')
    expect(output.sourcemapExcludeSources).toBe(false)
    expect(output.footer).toBe(FOOTER)
    expect(output.intro).toBe(INTRO)
  })
})

describe('the client banner', () => {
  it('opens the module loader call on the entry chunk', () => {
    const { client } = configs()

    expect(bannerText(client, ENTRY_CHUNK)).toBe(
      `window.__ModuleLoader__.load({ id: ${JSON.stringify(ID)}, factory: (require) => {`,
    )
  })

  it('names the chunk on a non-entry chunk', () => {
    const { client } = configs()

    expect(bannerText(client, EXTRA_CHUNK)).toBe(
      `window.__ModuleLoader__.load({ id: ${JSON.stringify(ID)}, chunk: ${JSON.stringify(EXTRA_CHUNK.fileName)}, factory: (require) => {`,
    )
  })

  it('escapes the id as a JSON string, in both banner forms', () => {
    const quotingId = '@scope/pkg"quoted\\\\backslash'
    const { client } = configs({ id: quotingId })

    const entry = bannerText(client, ENTRY_CHUNK)
    expect(entry).toBe(`window.__ModuleLoader__.load({ id: ${JSON.stringify(quotingId)}, factory: (require) => {`)
    expect(entry).not.toContain(quotingId)
    expect(JSON.parse(entry.slice(entry.indexOf('id: ') + 4, entry.indexOf(', factory: (require)')))).toBe(quotingId)

    const chunk = bannerText(client, EXTRA_CHUNK)
    expect(chunk).toContain(`id: ${JSON.stringify(quotingId)}, chunk: ${JSON.stringify(EXTRA_CHUNK.fileName)}, `)
    expect(chunk).not.toContain(quotingId)
    expect(
      JSON.parse(chunk.slice(chunk.indexOf(', chunk: ') + ', chunk: '.length, chunk.indexOf(', factory: (require)'))),
    ).toBe(EXTRA_CHUNK.fileName)
  })
})

describe('dependency handling', () => {
  it('keeps the default external baseline ahead of the caller externals, in order', () => {
    const baseline = neverBundleOf(configs().client)
    const withExternals = neverBundleOf(configs({ id: ID, externals: ['z-lib', 'a-lib'] }).client)

    expect(baseline.length).toBeGreaterThan(0)
    expect(withExternals.length).toBe(baseline.length + 2)
    expect(withExternals.slice(0, baseline.length)).toEqual(baseline)
    expect(withExternals.slice(-2)).toEqual(['z-lib', 'a-lib'])
  })

  it('bundles everything that is not exactly a platform module', () => {
    const alwaysBundle = alwaysBundleOf(configs().client)

    for (const module of PLATFORM_MODULES) expect(alwaysBundle(module, undefined)).toBe(false)
    expect(alwaysBundle('@deepseek-ai/dsh-client-store/subpath', undefined)).toBe(true)
    expect(alwaysBundle('host-open-in-app/shared', undefined)).toBe(true)
  })
})

describe('stylesheet plugins', () => {
  it('wires the three loaders in order, by default', () => {
    expect(pluginNames(configs().client.plugins)).toEqual(STYLESHEETS)
  })

  it('wires none of them when css is off', () => {
    expect(pluginNames(configs({ id: ID, css: false }).client.plugins)).toEqual([])
  })

  it('wires the same three when css is simply on', () => {
    expect(pluginNames(configs({ id: ID, css: true }).client.plugins)).toEqual(STYLESHEETS)
  })

  it('keeps the same three when the global registry is on', () => {
    expect(pluginNames(configs({ id: ID, css: { registry: true } }).client.plugins)).toEqual(STYLESHEETS)
  })

  it('keeps the same three when the global registry is off', () => {
    expect(pluginNames(configs({ id: ID, css: { registry: false } }).client.plugins)).toEqual(STYLESHEETS)
  })
})

describe('NODE_ENV', () => {
  const original = process.env.NODE_ENV

  afterEach(() => {
    if (original === undefined) delete process.env.NODE_ENV
    else process.env.NODE_ENV = original
  })

  it('falls back to production when the variable is unset', () => {
    delete process.env.NODE_ENV

    expect(configs().client.define).toEqual({ 'process.env.NODE_ENV': JSON.stringify('production') })
  })

  it('mirrors the variable when it is set', () => {
    process.env.NODE_ENV = 'staging'

    expect(configs().client.define).toEqual({ 'process.env.NODE_ENV': JSON.stringify('staging') })
  })
})
