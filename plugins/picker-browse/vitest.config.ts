import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

/**
 * Suite for the forked picker: the upstream component and flow specs, the drive
 * row this Bundle adds, and the probe behind it.
 *
 * One alias: `@deepseek-ai/dsh-client-ui-primitives` is the Web shell's static
 * library, and importing it eagerly evaluates katex/shiki/micromark/… — a tree
 * this standalone package does not install. The browser half resolves the REAL
 * module from the shell's module-table seed, so only these Node specs need the
 * stand-in. The double keeps the shipped modal, button, and glyph behavior the
 * upstream specs assert.
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
      include: ['src/**/*.ts', 'src/**/*.tsx'],
      exclude: ['src/**/*.d.ts'],
      reporter: ['text'],
      thresholds: {
        statements: 90,
        branches: 85,
        functions: 90,
        lines: 90,
      },
    },
  },
})
