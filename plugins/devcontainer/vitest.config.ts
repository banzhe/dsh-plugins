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
    // Measured over what the package actually ships: every module under src
    // builds into lib, and src/helper/main.mjs is copied verbatim as a program the
    // container runs. Three kinds of module cannot be driven from a unit test —
    // the container helper (its only execution context is a live container), the
    // browser entry (no spec mounts it), and type-only modules such as
    // src/types.ts and src/client/css.d.ts — so they stay in the report as the gap
    // they are and the thresholds are global rather than per-file. The numbers are
    // the measured baseline (88.80 / 82.61 / 90.07 / 91.84) rounded down.
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts', 'src/**/*.tsx', 'src/**/*.mjs'],
      reporter: ['text'],
      thresholds: {
        statements: 88,
        branches: 82,
        functions: 90,
        lines: 91,
      },
    },
  },
})