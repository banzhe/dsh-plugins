/**
 * The one client-bundle recipe every Bundle in this workspace builds with.
 *
 * A Bundle here always has two halves: a Node half the Host Loader mounts, and a
 * browser half that ships as `client.js` — a CommonJS factory registered through
 * `window.__ModuleLoader__.load({ id, factory })`. The rules around that factory
 * are the same for all of them, and getting one wrong fails at runtime, not at
 * build time: an inlined React renders outside the shell's tree, a bundled module
 * the shell already seeds duplicates its state, and a bundle that forgets the
 * wrapper never registers at all. So they live here once, next to the stylesheet
 * loaders (`tsdown-css.ts`), and each package's `tsdown.config.ts` only states
 * what actually differs: its id, its entries, and the module-table specifiers it
 * requests beyond the baseline.
 *
 * ## The external baseline
 *
 * The Web shell seeds a frozen module table before any plugin bundle executes,
 * and every dynamic bundle resolves against it. {@link PLATFORM_MODULES} restates
 * that table for DSH `0.2.2-rc.2` (`packages/client/web/src/platform.ts` in the
 * harness) instead of importing it: devkit is build-time only and must build
 * from this checkout alone, never from a host-internal path. It is the reason a
 * Bundle here must NOT declare these specifiers itself — they are implicit, and
 * re-requesting one is at best noise.
 *
 * Matching is exact, deliberately: a specifier is external only when the table
 * seeds it. Subpaths are NOT swept in with their package, because a package can
 * publish a browser-safe `/shared` module (route names, wire payloads) that is
 * meant to be inlined; externalizing it would ask the shell's table for a key it
 * does not have.
 *
 * @module @banzhe/dsh-devkit/src/tsdown-client
 */
import type { UserConfig } from 'tsdown'
import { cssPlugins, type CssPluginOptions } from './tsdown-css.ts'

/**
 * The module specifiers the DSH 0.2.2-rc.2 Web shell seeds into its frozen module
 * table, in the shell's own order. A dynamic client bundle resolves these
 * externally and carries everything else itself.
 *
 * Restated from the harness (`packages/client/web/src/platform.ts`), not imported:
 * no build in this workspace may read a host-internal path.
 */
export const PLATFORM_MODULES: readonly string[] = [
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

/** Node-half overrides; every field defaults to the rule the whole workspace shares. */
export interface NodeBundleOptions {
  /** Entry file, or a name-to-file map for a package that ships several (default `['src/index.ts']`). */
  readonly entry?: string | Readonly<Record<string, string>>
  /**
   * Clear `lib` before the build (default false: the client half writes into the
   * same directory and its own config must not be the one that cleans).
   */
  readonly clean?: boolean
  /** Files copied verbatim next to the bundles, for programs that ship uncompiled. */
  readonly copy?: readonly { readonly from: string; readonly to: string }[]
}

/** What one package's `tsdown.config.ts` states: its identity, its entries, and its requests. */
export interface ClientBundleOptions {
  /** Must equal the package's `name`: the ModuleLoader factory id is this string. */
  readonly id: string
  /** Client entry (default `'src/client/index.ts'`; a package whose browser half is one file states it). */
  readonly clientEntry?: string
  /** Node-half overrides. */
  readonly node?: NodeBundleOptions
  /**
   * Module-table specifiers this package requests beyond {@link PLATFORM_MODULES}
   * — a package-specific dynamic row or subpath, never a repeat of the baseline.
   */
  readonly externals?: readonly string[]
  /**
   * Stylesheet loaders for the client half (default true). They are inert for a
   * package that imports no sheet, so every Bundle takes the default and a
   * package only states `false` to prove it carries no stylesheet at all.
   */
  readonly css?: boolean | CssPluginOptions
}

/**
 * The Node half: one ESM build with declarations, next to the browser half.
 * @param options - node-half overrides.
 * @returns the tsdown config for `src/index.ts`.
 */
function nodeBundle(options: NodeBundleOptions | undefined): UserConfig {
  return {
    entry: options?.entry ?? ['src/index.ts'],
    outDir: 'lib',
    format: ['esm'],
    platform: 'node',
    dts: true,
    clean: options?.clean ?? false,
    fixedExtension: false,
    // The public contract is readonly; tsdown's own option wants a mutable
    // array, so hand it a copy rather than widening what a caller may mutate.
    ...(options?.copy === undefined
      ? {}
      : { copy: options.copy.map(entry => ({ from: entry.from, to: entry.to })) }),
  }
}

/**
 * Build both halves of one Bundle.
 *
 * @param options - the package's id, entries, and extra module-table requests.
 * @returns two tsdown configs in the order the build runs them: Node half, then
 * the browser half that must not clean the directory the first one wrote.
 */
export function clientBundle(options: ClientBundleOptions): UserConfig[] {
  const externals: readonly string[] = [
    ...PLATFORM_MODULES,
    ...(options.externals ?? []),
  ]
  const css = options.css ?? true
  return [
    nodeBundle(options.node),
    {
      entry: { client: options.clientEntry ?? 'src/client/index.ts' },
      outDir: 'lib',
      format: 'cjs',
      platform: 'browser',
      dts: false,
      clean: false,
      sourcemap: true,
      ...(css === false ? {} : { plugins: cssPlugins(options.id, css === true ? {} : css) }),
      deps: {
        // Exact specifiers: a subpath of an external package stays inlined on
        // purpose — a package may publish a browser-safe '/shared' module the
        // shell's table has no key for.
        neverBundle: [...externals],
        alwaysBundle: (specifier: string) => !externals.includes(specifier),
      },
      define: {
        'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production'),
      },
      outputOptions: {
        entryFileNames: 'client.js',
        // A source `import()` becomes a sibling chunk the module loader fetches
        // through `require.async`; naming it here keeps that name predictable.
        chunkFileNames: 'client.[name].js',
        sourcemapExcludeSources: false,
        // The registration call: the loader keys the factory by the package name,
        // and a split chunk also states its own file so a stack names it.
        banner: chunk => `window.__ModuleLoader__.load({ id: ${JSON.stringify(options.id)}, ${chunk.isEntry ? '' : `chunk: ${JSON.stringify(chunk.fileName)}, `}factory: (require) => {`,
        footer: 'return module.exports; } });',
        intro: 'var module = { exports: {} }; var exports = module.exports;',
      },
    },
  ]
}
