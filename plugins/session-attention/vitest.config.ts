import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

/**
 * Standalone suite for the attention-overlay browser half. The specs drive
 * `../src/*` directly and run under jsdom per file (the `@vitest-environment`
 * pragma), so the React entry, the DOM escape handling, and the stylesheet
 * injection are exercised without a build step.
 *
 * One alias: `@deepseek-ai/dsh-client-ui-primitives` is the Web shell's static
 * library, and importing it eagerly evaluates katex/shiki/micromark/… — a tree
 * this standalone package does not install. The browser half resolves the REAL
 * module from the shell's module-table seed, so only Node specs need the
 * stand-in.
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
    include: ['tests/**/*.spec.ts'],
    pool: 'forks',
    // The browser half imports its sheet as `overlay.css?inline`. Vitest stubs
    // CSS to an empty module by default, which would hand the plugin an empty
    // `<style>` and let every stylesheet assertion pass vacuously; turning the
    // pipeline on makes Vite return the real text.
    css: true,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts', 'src/**/*.tsx'],
      // `css.d.ts` declares the `?inline` import and emits no code; counting it
      // as an uncovered file would put a permanent 0% row in the report.
      exclude: ['src/**/*.d.ts'],
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
