import { defineConfig } from 'vitest/config'

/**
 * Suite for the `/title-refresh` command. Coverage is scoped to
 * `src/command.ts` on purpose: `src/index.ts` is provider code whose every path
 * needs a live auxiliary model call, so a package-wide threshold would demand
 * coverage no unit test can honestly produce. Only the command module is
 * measured, and it is measured completely.
 */
export default defineConfig({
  test: {
    include: ['tests/**/*.spec.ts'],
    pool: 'forks',
    coverage: {
      provider: 'v8',
      include: ['src/command.ts'],
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
