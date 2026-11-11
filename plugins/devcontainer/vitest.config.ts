import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

/**
 * Suite for the repository/container seams, the Host derivation set, and the
 * settings page, driven directly through `../src/*` with no build step.
 *
 * One alias: `@deepseek-ai/dsh-client-ui-primitives` is the Web shell's static
 * library, and importing it eagerly evaluates katex/shiki/micromark/… — a tree
 * this standalone package does not install. The browser half resolves the REAL
 * module from the shell's module-table seed, so only the specs need the stand-in
 * (`tests/ui-primitives-double.tsx`).
 *
 * `css: true` because the page imports its sheet as `styles.css?inline`. Vitest
 * stubs CSS to an empty module by default, which would let the stylesheet
 * assertions pass vacuously (ADR 0009, note 11).
 */
export default defineConfig({
  resolve: {
    alias: {
      '@deepseek-ai/dsh-client-ui-primitives': fileURLToPath(
        new URL('./tests/ui-primitives-double.tsx', import.meta.url),
      ),
    },
  },
  test: {
    include: ['tests/**/*.spec.ts', 'tests/**/*.spec.tsx'],
    pool: 'forks',
    css: true,
    coverage: {
      provider: 'v8',
      include: [
        'src/index.ts',
        'src/ids.ts',
        'src/presets.ts',
        'src/variants.ts',
        'src/paths.ts',
        'src/jsonc.ts',
        'src/config-loader.ts',
        'src/container.ts',
        'src/sbx.ts',
        'src/host-mounts.ts',
        'src/argv.ts',
        'src/prompt.ts',
        'src/options.ts',
        'src/registry.ts',
        'src/exec.ts',
        'src/fs.ts',
        'src/subprocess.ts',
        'src/ptc.ts',
        'src/helper-source.ts',
        'src/rpc/frames.ts',
        'src/rpc/client.ts',
        'src/rpc/pool.ts',
        'src/rpc/errors.ts',
        'src/rpc/wire.ts',
        'src/client/variants.ts',
        'src/client/locales.ts',
        'src/client/controller.ts',
        'src/client/VariantsSection.tsx',
      ],
      reporter: ['text'],
    },
  },
})
