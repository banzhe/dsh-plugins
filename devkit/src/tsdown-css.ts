/**
 * Stylesheet loaders for this repo's tsdown client bundles.
 *
 * DSH's own client preset does this for the packages inside the harness, and it
 * is not reusable from here: its three loaders live in a config factory that the
 * package does not export, and reaching them would drag in harness-internal
 * paths (its `web/src/platform.ts`, its `scripts` gates, and a scan of that
 * repository's package manifests). The semantics below restate the same three
 * modes for an out-of-tree Bundle — the way community plugin workspaces do — so
 * a stylesheet is a file on disk for every package here, with no bundled CSS
 * pipeline to configure:
 *
 * - `x.module.css` — lightningcss compiles the sheet with CSS Modules
 *   (`[hash]_[local]`). The importing module installs a tagged `<style>` at
 *   factory execution and exports the class map, so components write
 *   `className={css.row}`. This is the preferred mode for a component's own
 *   chrome: hashed names cannot collide with the shell's classes.
 * - `x.css` — the same injector without a class map, for a sheet a component
 *   imports for its side effect.
 * - `x.css?inline` — the compiled sheet as text, for a plugin that installs the
 *   tag itself and takes it back with its fiber (`ctx.effect`). Use this when the
 *   sheet must be removable, or when it is the plugin's own token layer.
 *
 * All three modes compile through lightningcss, like the harness preset and the
 * community workspaces that restate it. The specs therefore assert the compiled
 * form, and `devkit/tests/` is where that semantics is pinned once instead of
 * per Bundle.
 *
 * Every virtual id carries a null-byte prefix and an `.mjs` suffix: tsdown's own
 * CSS guard matches ids *ending* in the extension and fails the build without
 * `@tsdown/css`, and a virtual id must not look like a stylesheet path.
 */
import { readFile } from 'node:fs/promises'
import { basename, dirname, resolve as resolvePath } from 'node:path'
import { transform } from 'lightningcss'
import type { TsdownPlugin } from 'tsdown'

/** Suffix naming a CSS Modules sheet. */
const MODULE_SUFFIX = '.module.css'
/** Query asking for the sheet as text instead of an injector. */
const INLINE_QUERY = '?inline'
/** Virtual-id wrapper for a CSS Modules sheet. */
const MODULE_PREFIX = '\0dsh-css-module:'
/** Virtual-id wrapper for a side-effect stylesheet. */
const GLOBAL_PREFIX = '\0dsh-css-global:'
/** Virtual-id wrapper for a text import. */
const INLINE_PREFIX = '\0dsh-css-inline:'
/** Suffix keeping every virtual id off tsdown's `.css` guard. */
const VIRTUAL_SUFFIX = '.mjs'

/** Per-bundle options for {@link cssPlugins}. */
export interface CssPluginOptions {
  /**
   * Also record each sheet on `globalThis.__DSH_PLUGIN_CSS__`, so plugin code can
   * re-install a tag the page lost without re-running this bundle's factory (a
   * host restart that leaves the page open drops injected tags while the module
   * registry keeps the module). Off by default: the tag is installed
   * idempotently, and only a plugin that re-injects on mount needs the record.
   */
  readonly registry?: boolean
}

/**
 * The stylesheet loaders this repo's client bundles share.
 * @param id - plugin id (package name), stamped onto every injected `<style>` tag.
 * @param options - injection extras; see {@link CssPluginOptions}.
 * @returns three tsdown plugins, one per import form, for `plugins: [...cssPlugins(id)]`.
 */
export function cssPlugins(id: string, options: CssPluginOptions = {}): TsdownPlugin[] {
  const registry = options.registry === true
  return [modulesPlugin(id, registry), globalPlugin(id, registry), inlinePlugin()]
}

/**
 * Compile a CSS Modules sheet, export its class map and install its text.
 * @param id - plugin id stamped onto the installed tag.
 * @param registry - whether to publish the sheet on the global record.
 * @returns the loader.
 */
function modulesPlugin(id: string, registry: boolean): TsdownPlugin {
  return {
    name: 'dsh-css-modules',
    resolveId(source, importer) {
      if (!source.endsWith(MODULE_SUFFIX)) return null
      const file = stylesheetPath(source, importer)
      return file === undefined ? null : MODULE_PREFIX + file + VIRTUAL_SUFFIX
    },
    async load(virtualId) {
      if (!virtualId.startsWith(MODULE_PREFIX)) return null
      const file = virtualId.slice(MODULE_PREFIX.length, -VIRTUAL_SUFFIX.length)
      this.addWatchFile(file)
      const { code, exports } = transform({
        filename: file,
        code: await readFile(file),
        cssModules: { pattern: '[hash]_[local]' },
        minify: true,
      })
      // lightningcss reports exports for every module sheet once CSS Modules is
      // on, an empty sheet included; the fallback only satisfies its `void` type.
      /* v8 ignore next -- lightningcss always reports exports when cssModules is on */
      const cssExports = exports ?? {}
      // The map keeps the compiler's own name order: it is derived from the sheet,
      // so it is stable for a given input, and nothing reads the map's order.
      const classMap: Record<string, string> = Object.fromEntries(
        Object.entries(cssExports).map(([local, exported]) => [local, exported.name] as const),
      )
      return injectorModule(id, file, code.toString(), classMap, registry)
    },
  }
}

/**
 * Compile a side-effect stylesheet and install its text.
 * @param id - plugin id stamped onto the installed tag.
 * @param registry - whether to publish the sheet on the global record.
 * @returns the loader.
 */
function globalPlugin(id: string, registry: boolean): TsdownPlugin {
  return {
    name: 'dsh-css-global',
    resolveId(source, importer) {
      if (!source.endsWith('.css') || source.endsWith(MODULE_SUFFIX)) return null
      const file = stylesheetPath(source, importer)
      return file === undefined ? null : GLOBAL_PREFIX + file + VIRTUAL_SUFFIX
    },
    async load(virtualId) {
      if (!virtualId.startsWith(GLOBAL_PREFIX)) return null
      const file = virtualId.slice(GLOBAL_PREFIX.length, -VIRTUAL_SUFFIX.length)
      this.addWatchFile(file)
      const { code } = transform({ filename: file, code: await readFile(file), minify: true })
      return injectorModule(id, file, code.toString(), undefined, registry)
    },
  }
}

/**
 * Hand a compiled stylesheet back as text, for a plugin-owned install/remove effect.
 * @returns the loader.
 */
function inlinePlugin(): TsdownPlugin {
  return {
    name: 'dsh-css-inline',
    resolveId(source, importer) {
      if (!source.endsWith(`.css${INLINE_QUERY}`)) return null
      const file = stylesheetPath(source.slice(0, -INLINE_QUERY.length), importer)
      return file === undefined ? null : INLINE_PREFIX + file + VIRTUAL_SUFFIX
    },
    async load(virtualId) {
      if (!virtualId.startsWith(INLINE_PREFIX)) return null
      const file = virtualId.slice(INLINE_PREFIX.length, -VIRTUAL_SUFFIX.length)
      this.addWatchFile(file)
      const { code } = transform({ filename: file, code: await readFile(file), minify: true })
      return `export default ${JSON.stringify(code.toString())}`
    },
  }
}

/**
 * Resolve a stylesheet import against the importing module.
 * @param source - relative import specifier as written in the source.
 * @param importer - absolute path of the importing module.
 * @returns the sheet's absolute path, or undefined when the import cannot name one.
 */
function stylesheetPath(source: string, importer: string | undefined): string | undefined {
  // A sheet always belongs to the package that imports it: a dependency's
  // stylesheet, a bare specifier, or an entry-level import is not ours to serve,
  // and answering it with a wrong path would fail the build far from here.
  if (importer === undefined || !source.startsWith('.')) return undefined
  return resolvePath(dirname(importer), source)
}

/**
 * Emit the module that installs one sheet and (for CSS Modules) exports its map.
 * @param id - plugin id stamped onto the tag.
 * @param file - absolute path of the sheet, whose basename names the tag.
 * @param css - compiled stylesheet text.
 * @param classMap - CSS Modules map, or undefined for a side-effect sheet.
 * @param registry - whether to publish the sheet on the global record.
 * @returns the module's source.
 */
function injectorModule(
  id: string,
  file: string,
  css: string,
  classMap: Readonly<Record<string, string>> | undefined,
  registry: boolean,
): string {
  const tagId = `${id}/${basename(file)}`
  const source = [
    `const css = ${JSON.stringify(css)};`,
    `const tagId = ${JSON.stringify(tagId)};`,
    // Idempotent by tag: a bundle imported by two plugins, or re-imported after a
    // module-registry change, must not stack a second copy of the same sheet.
    'if (typeof document !== \'undefined\' && document.querySelector(\'style[data-plugin-css=\' + JSON.stringify(tagId) + \']\') === null) {',
    '  const tag = document.createElement(\'style\');',
    `  tag.dataset.plugin = ${JSON.stringify(id)};`,
    '  tag.dataset.pluginCss = tagId;',
    '  tag.textContent = css;',
    '  document.head.appendChild(tag);',
    '}',
  ]
  if (registry) {
    source.push(
      'const record = (globalThis.__DSH_PLUGIN_CSS__ ??= []);',
      'if (!record.some(entry => entry.tagId === tagId)) record.push({ tagId, css });',
    )
  }
  source.push(classMap === undefined ? 'export {};' : `export default ${JSON.stringify(classMap)};`)
  return source.join('\n')
}
