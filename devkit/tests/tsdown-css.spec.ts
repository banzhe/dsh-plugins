/**
 * Stylesheet-loader contract, asserted against the module text each loader
 * emits: the three import forms, the guard-dodging virtual ids, the watch
 * registrations, the CSS Modules map, and the imports the loaders must decline
 * rather than answer with a wrong path.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { cssPlugins, type CssPluginOptions } from '../src/tsdown-css.ts'

const ID = '@banzhe/dsh-devkit-fixture'

/** The slice of the rolldown plugin context these loaders use. */
interface WatchContext {
  addWatchFile(file: string): void
}

/** The plugin hooks under test, named so a spec can fail on the right one. */
interface Loader {
  name: string
  resolveId?: (source: string, importer?: string) => string | null
  load?: (this: WatchContext, id: string) => Promise<string | null>
}

/** A stylesheet no build imports: the specs move it through the hooks by hand. */
const IMPORTER = join(tmpdir(), 'dsh-devkit-probe', 'index.ts')

let roots: string[] = []

afterEach(async () => {
  const pending = roots
  roots = []
  for (const root of pending) await rm(root, { recursive: true, force: true })
})

/** Write one sheet into a fresh temp directory beside the module that imports it. */
async function sheet(name: string, content: string): Promise<{ file: string; importer: string }> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-devkit-css-'))
  roots.push(root)
  const file = join(root, name)
  await writeFile(file, content)
  return { file, importer: join(root, 'index.ts') }
}

/** The loader responding to one import form. */
function loader(name: string, options: CssPluginOptions = {}): Loader {
  const found = (cssPlugins(ID, options) as unknown as Loader[]).find(candidate => candidate.name === name)
  if (found === undefined) throw new Error(`${name} is missing from cssPlugins()`)
  return found
}

/** Resolve through one loader, failing loudly when it declines a sheet it owns. */
function resolve(plugin: Loader, source: string, importer: string): string {
  const id = plugin.resolveId?.(source, importer)
  if (typeof id !== 'string') throw new Error(`${plugin.name} declined ${source}`)
  return id
}

/** Load through one loader, keeping the watch files it registers. */
async function load(plugin: Loader, id: string): Promise<{ source: string; watched: string[] }> {
  const watched: string[] = []
  const source = await plugin.load?.call({ addWatchFile: file => { watched.push(file) } }, id)
  if (typeof source !== 'string') throw new Error(`${plugin.name} declined ${id}`)
  return { source, watched }
}

/** The class map a CSS Modules loader exported, read back off the module text. */
function classMapOf(source: string): Record<string, string> {
  const declaration = source.slice(source.lastIndexOf('\n') + 1)
  expect(declaration).toMatch(/^export default \{.*\};$/)
  return JSON.parse(declaration.slice('export default '.length, -1)) as Record<string, string>
}

describe('cssPlugins', () => {
  it('offers one loader per import form', () => {
    expect((cssPlugins(ID) as unknown as Loader[]).map(plugin => plugin.name))
      .toEqual(['dsh-css-modules', 'dsh-css-global', 'dsh-css-inline'])
  })
})

describe('CSS Modules sheets', () => {
  it('hashes the class names, exports their map, and installs the compiled sheet', async () => {
    const { file, importer } = await sheet('Card.module.css', '.row { color: red; }\n.row .label { gap: 4px; }\n')
    const plugin = loader('dsh-css-modules')

    const virtual = resolve(plugin, './Card.module.css', importer)
    // tsdown's own css guard fails the build on any id ENDING in `.css`.
    expect(virtual.endsWith('.css')).toBe(false)

    const { source, watched } = await load(plugin, virtual)
    expect(watched).toEqual([file])
    expect(source).toContain(`"${ID}/Card.module.css"`)
    expect(source).toContain('data-plugin-css')
    expect(source).toContain(`tag.dataset.plugin = "${ID}"`)

    const classMap = classMapOf(source)
    expect(Object.keys(classMap).sort()).toEqual(['label', 'row'])
    // lightningcss's `[hash]` is a base64-ish token: letters, digits, `_` and `-`.
    expect(classMap['row']).toMatch(/^[\w-]+_row$/)
    expect(classMap['label']).toMatch(/^[\w-]+_label$/)
    expect(source).toContain(`.${classMap['row']}{color:red}`)
    expect(source).toContain(`.${classMap['row']} .${classMap['label']}{gap:4px}`)
  })

  it('hashes at-rule names too, so a sheet without a class still yields its map', async () => {
    const { importer } = await sheet('Spin.module.css', '@keyframes spin { from { opacity: 0 } to { opacity: 1 } }\n')
    const plugin = loader('dsh-css-modules')

    const { source } = await load(plugin, resolve(plugin, './Spin.module.css', importer))

    const classMap = classMapOf(source)
    expect(Object.keys(classMap)).toEqual(['spin'])
    expect(source).toContain(`@keyframes ${classMap['spin']}`)
  })

  it('records the sheet on the global registry only when asked', async () => {
    const { importer } = await sheet('Card.module.css', '.row { color: red; }\n')
    const recorded = loader('dsh-css-modules', { registry: true })
    const plain = loader('dsh-css-modules')

    const withRecord = await load(recorded, resolve(recorded, './Card.module.css', importer))
    const withoutRecord = await load(plain, resolve(plain, './Card.module.css', importer))

    expect(withRecord.source).toContain('__DSH_PLUGIN_CSS__')
    expect(withRecord.source).toContain('record.push({ tagId, css });')
    expect(withoutRecord.source).not.toContain('__DSH_PLUGIN_CSS__')
  })
})

describe('side-effect stylesheets', () => {
  it('installs the compiled sheet and exports nothing', async () => {
    const { file, importer } = await sheet('base.css', '/* a comment the bundle does not need */\nbody { color: red; }\n')
    const plugin = loader('dsh-css-global')

    const virtual = resolve(plugin, './base.css', importer)
    expect(virtual.endsWith('.css')).toBe(false)

    const { source, watched } = await load(plugin, virtual)
    expect(watched).toEqual([file])
    expect(source).toContain('body{color:red}')
    expect(source).not.toContain('a comment the bundle does not need')
    expect(source.endsWith('export {};')).toBe(true)
  })

  it('records the sheet on the global registry only when asked', async () => {
    const { importer } = await sheet('base.css', 'body { color: red; }\n')
    const recorded = loader('dsh-css-global', { registry: true })

    const { source } = await load(recorded, resolve(recorded, './base.css', importer))

    expect(source).toContain('__DSH_PLUGIN_CSS__')
  })
})

describe('text imports', () => {
  it('compiles the sheet and hands back the text, for a plugin-owned effect', async () => {
    const written = '/* keeps its comment */\n.sa-root.sa-root {\n  pointer-events: none;\n}\n'
    const { file, importer } = await sheet('overlay.css', written)
    const plugin = loader('dsh-css-inline')

    const { source, watched } = await load(plugin, resolve(plugin, './overlay.css?inline', importer))

    expect(watched).toEqual([file])
    // Compiled like the other two modes: the comment is gone, the rule is one line.
    expect(source).toBe(`export default ${JSON.stringify('.sa-root.sa-root{pointer-events:none}')}`)
    expect(source).not.toContain('keeps its comment')
  })
})

describe('imports the loaders do not own', () => {
  it('declines the forms another loader serves', () => {
    const modules = loader('dsh-css-modules')
    const global = loader('dsh-css-global')
    const inline = loader('dsh-css-inline')

    expect(modules.resolveId?.('./Card.css', IMPORTER)).toBeNull()
    expect(modules.resolveId?.('./Card.module.css?inline', IMPORTER)).toBeNull()
    expect(global.resolveId?.('./Card.module.css', IMPORTER)).toBeNull()
    expect(global.resolveId?.('../probe.ts', IMPORTER)).toBeNull()
    expect(inline.resolveId?.('./overlay.css', IMPORTER)).toBeNull()
    // A module sheet asked for as text is text: the query selects the text mode,
    // so no injector is emitted and no class map is handed back either way.
    expect(inline.resolveId?.('./overlay.module.css?inline', IMPORTER)).toBeTypeOf('string')
  })

  it('declines an import that cannot name a sheet of this package', () => {
    // A dependency's stylesheet, and an entry-level import: neither is ours to
    // resolve, and answering with a path relative to here would be wrong.
    expect(loader('dsh-css-modules').resolveId?.('some-lib/Card.module.css', IMPORTER)).toBeNull()
    expect(loader('dsh-css-modules').resolveId?.('./Card.module.css')).toBeNull()
    expect(loader('dsh-css-global').resolveId?.('some-lib/base.css', IMPORTER)).toBeNull()
    expect(loader('dsh-css-global').resolveId?.('./base.css')).toBeNull()
    expect(loader('dsh-css-inline').resolveId?.('some-lib/base.css?inline', IMPORTER)).toBeNull()
    expect(loader('dsh-css-inline').resolveId?.('./base.css?inline')).toBeNull()
  })

  it('declines a virtual id another loader owns', async () => {
    const { importer } = await sheet('Card.module.css', '.row { color: red; }\n')
    const modules = resolve(loader('dsh-css-modules'), './Card.module.css', importer)

    expect(await loader('dsh-css-global').load?.call({ addWatchFile: () => {} }, modules)).toBeNull()
    expect(await loader('dsh-css-inline').load?.call({ addWatchFile: () => {} }, modules)).toBeNull()
    expect(await loader('dsh-css-modules').load?.call({ addWatchFile: () => {} }, 'plain-module.js')).toBeNull()
    expect(await loader('dsh-css-global').load?.call({ addWatchFile: () => {} }, 'plain-module.js')).toBeNull()
    expect(await loader('dsh-css-inline').load?.call({ addWatchFile: () => {} }, 'plain-module.js')).toBeNull()
  })
})
