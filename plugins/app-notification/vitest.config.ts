import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

/**
 * Standalone suite for the completion-attention browser half. The specs drive
 * `../src/*.ts` directly and run under jsdom per file (the `@vitest-environment`
 * pragma), so capability probes and DOM-adjacent browser APIs are exercised
 * without a build step.
 *
 * One alias: `@deepseek-ai/dsh-client-ui-primitives` is the Web shell's static
 * library, and importing it eagerly evaluates katex/shiki/micromark/mdast/clsx —
 * a tree this standalone package does not install. The browser half resolves the
 * REAL module from the shell's module-table seed, so only Node specs need the
 * stand-in (same rationale as `tests/locale-double.ts`).
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
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
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
