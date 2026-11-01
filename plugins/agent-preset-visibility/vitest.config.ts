import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

/**
 * Suite for the preset-roster filter seam, the hidden-list rules, the page
 * controller, and the rendered settings section, driven directly through
 * `../src/client/*` with no build step.
 *
 * One alias: ``@deepseek-ai/dsh-client-ui-primitives`` is the Web shell's static
 * library, and importing it eagerly evaluates katex/shiki/micromark/… — a tree
 * this standalone package does not install. The browser half resolves the REAL
 * module from the shell's module-table seed, so only the specs need the stand-in
 * (`tests/ui-primitives-double.tsx`).
 *
 * ``css: true`` because the page imports its sheet as ``visibility.css?inline``.
 * Vitest stubs CSS to an empty module by default, which would let the
 * stylesheet assertions pass vacuously (ADR 0009, note 11).
 *
 * Coverage takes every module the specs reach through their own interfaces: the
 * roster seam, the hidden-list rules, the dictionaries, the page controller, the
 * section component (mounted under jsdom by the ``@vitest-environment`` pragma in
 * `section.spec.tsx`), and the Host half, which is measured for its Config schema.
 * One file is left out: ``src/client/index.ts`` is Loader row glue that needs a
 * live Cordis composition to install the seam and register the slot, so a
 * package-wide threshold would demand coverage no unit test can honestly produce.
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
        'src/client/visibility.ts',
        'src/client/remote.ts',
        'src/client/locales.ts',
        'src/client/controller.ts',
        'src/client/PresetVisibilitySection.tsx',
      ],
      reporter: ['text'],
      thresholds: {
        perFile: true,
        statements: 100,
        branches: 100,
        functions: 100,
        lines: 100,
      },
    },
  },
})
