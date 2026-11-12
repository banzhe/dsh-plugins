import { defineConfig } from 'vitest/config'

/**
 * Suite for the plan-toggle browser half, driven through its plugin entry with
 * the four public services it injects replaced by recording doubles. The specs
 * declare `@vitest-environment jsdom` per file, so the composer keyboard path
 * runs against a real DOM without a build step.
 *
 * Coverage is measured over every shipped source and pinned just under the
 * measured baseline (94.84 / 91.02 / 100 / 98.68) — the Host half is the empty
 * Loader hook the specs cover completely, so functions stays at 100 — so a
 * regression fails while the remaining gap stays visible in the report instead
 * of being excluded.
 */
export default defineConfig({
  test: {
    include: ['tests/**/*.spec.ts'],
    pool: 'forks',
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      reporter: ['text'],
      thresholds: {
        statements: 94,
        branches: 90,
        functions: 100,
        lines: 98,
      },
    },
  },
})
