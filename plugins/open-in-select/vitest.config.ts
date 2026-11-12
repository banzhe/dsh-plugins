import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

/**
 * Suite for the header control's browser half: the two Host calls, the two
 * decisions taken between them, and the control's own rendering.
 *
 * One alias: `@deepseek-ai/dsh-client-ui-primitives` is the Web shell's static
 * library, and importing it eagerly evaluates katex/shiki/micromark/… — a tree
 * this standalone package does not install. The browser half resolves the REAL
 * module from the shell's module-table seed, so only Node specs need the
 * stand-in.
 *
 * Coverage is scoped to the two React-free modules. `src/index.ts` mounts the
 * whole plugin on a live Cordis composition, which no unit spec can honestly
 * cover.
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
    css: true,
    pool: 'forks',
    coverage: {
      provider: 'v8',
      include: ['src/client/api.ts', 'src/client/choice.ts'],
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
