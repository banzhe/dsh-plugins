import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

/**
 * Suite for the rows this plugin contributes to the official file context
 * menu, the host's line-bearing argv rewriting, and the wire/contract
 * boundaries around them.
 *
 * One alias: `@deepseek-ai/dsh-client-ui-primitives` is the Web shell's static
 * library, and importing it eagerly evaluates katex/shiki/micromark/… — a tree
 * this standalone package does not install. The browser half resolves the REAL
 * module from the shell's module-table seed, so only Node specs need the
 * stand-in.
 * `react`, `react-dom` and `jsdom` come from the workspace catalog.
 */
export default defineConfig({
  resolve: {
    alias: [{
      find: /^@deepseek-ai\/dsh-client-ui-primitives$/,
      replacement: fileURLToPath(new URL('./tests/ui-primitives-double.tsx', import.meta.url)),
    }],
  },
  test: {
    include: ['tests/**/*.spec.ts', 'tests/**/*.spec.tsx'],
    pool: 'forks',
    coverage: {
      provider: 'v8',
      // `src/index.ts` is host code whose routes need a live Cordis composition,
      // so a package-wide threshold would demand coverage no unit test can
      // honestly produce. The pure modules the row set and the launch arguments
      // live in are measured completely.
      include: ['src/launch-args.ts', 'src/client/actions.ts'],
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
