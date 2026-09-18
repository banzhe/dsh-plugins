import { defineConfig } from 'vitest/config'

/**
 * Suite for the hover-archive browser half. The specs drive `../src/client/*`
 * under jsdom (the `@vitest-environment` pragma) so the DOM gesture, the React
 * fiber walk, and the archive dispatch all run against real element trees.
 *
 * Every module is measured completely. `src/index.ts` (the Host half) is an
 * empty apply whose only job is to seat the Bundle in the Loader tree, so it is
 * out of scope rather than uncovered on purpose.
 */
export default defineConfig({
  test: {
    include: ['tests/**/*.spec.ts'],
    pool: 'forks',
    coverage: {
      provider: 'v8',
      include: ['src/client/**/*.ts'],
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
