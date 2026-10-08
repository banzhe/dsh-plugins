import { defineConfig } from 'vitest/config'

/**
 * Suite for the icon table, the snapshot reader, the validator comparison, and
 * the routes the Host registers. `tests/apply.spec.ts` drives `apply()` and every
 * handler through a fake composition, so both source modules are measured.
 */
export default defineConfig({
  test: {
    include: ['tests/**/*.spec.ts'],
    pool: 'forks',
    coverage: {
      provider: 'v8',
      include: ['src/icons.ts', 'src/index.ts'],
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
