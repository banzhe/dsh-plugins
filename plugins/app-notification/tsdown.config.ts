import { defineConfig } from 'tsdown'

/** Must match package.json `name`; the ModuleLoader factory id is this string. */
const id = '@banzhe/dsh-app-notification'

/**
 * Baseline module-table words the settings row may request without declaring
 * them (the shell's `PLATFORM_MODULES` seed). The row must render through the
 * SAME React instance the shell mounted, and through the SAME `ui-primitives`
 * the shell seeded, so neither is ever inlined.
 */
const PLATFORM_EXTERNALS = [
  'react',
  'react/jsx-runtime',
  '@deepseek-ai/dsh-client-ui-primitives',
] as const

export default defineConfig([
  {
    entry: ['src/index.ts'],
    outDir: 'lib',
    format: ['esm'],
    platform: 'node',
    dts: true,
    clean: false,
    fixedExtension: false,
  },
  {
    entry: { client: 'src/client/index.ts' },
    outDir: 'lib',
    format: 'cjs',
    platform: 'browser',
    dts: false,
    clean: false,
    sourcemap: true,
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
      banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(id)}, factory: (require) => {`,
      footer: 'return module.exports; } });',
      intro: 'var module = { exports: {} }; var exports = module.exports;',
    },
  },
])
