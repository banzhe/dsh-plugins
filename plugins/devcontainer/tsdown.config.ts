import { cssPlugins } from '@banzhe/dsh-devkit'
import { defineConfig } from 'tsdown'

/** Must match package.json `name`; the ModuleLoader factory id is this string. */
const id = '@banzhe/dsh-devcontainer'

/**
 * Baseline module-table words the browser half may request without declaring
 * them (the shell's PLATFORM_MODULES seed): the page must render through the
 * SAME React instance the shell mounted, and through the SAME ui-primitives the
 * shell seeded, so neither may be inlined.
 */
const PLATFORM_EXTERNALS = [
  'react',
  'react/jsx-runtime',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-store',
] as const

export default defineConfig([
  {
    entry: { index: 'src/index.ts', shell: 'src/shell.ts', fs: 'src/fs.ts' },
    outDir: 'lib',
    format: ['esm'],
    platform: 'node',
    dts: true,
    clean: true,
    fixedExtension: false,
    // The container runs this program with its own `node`, so it ships verbatim
    // next to the bundles instead of being compiled with them.
    copy: [{ from: 'src/helper/main.mjs', to: 'lib/helper' }],
  },
  {
    entry: { client: 'src/client/index.ts' },
    outDir: 'lib',
    format: 'cjs',
    platform: 'browser',
    dts: false,
    clean: false,
    sourcemap: true,
    // The sheet is imported as styles.css?inline, which the shared devkit
    // resolves to its text: one artifact is fetched, so there is no sibling CSS
    // asset to link and no bundler CSS pipeline to configure.
    plugins: cssPlugins(id),
    deps: {
      neverBundle: [...PLATFORM_EXTERNALS],
      alwaysBundle: (specifier: string) =>
        !(PLATFORM_EXTERNALS as readonly string[]).includes(specifier),
    },
    define: {
      'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production'),
    },
    outputOptions: {
      entryFileNames: 'client.js',
      sourcemapExcludeSources: false,
      banner: 'window.__ModuleLoader__.load({ id: ' + JSON.stringify(id) + ', factory: (require) => {',
      footer: 'return module.exports; } });',
      intro: 'var module = { exports: {} }; var exports = module.exports;',
    },
  },
])
