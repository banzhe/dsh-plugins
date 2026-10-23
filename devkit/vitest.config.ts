import { defineConfig } from 'vitest/config'

/**
 * The specs drive the plugin hooks directly over real sheets in a temp
 * directory: no build runs, and the assertions are the emitted module's text,
 * which is what the bundle carries.
 *
 * These loaders decide what every client artifact contains, so a mode without
 * a spec is a mode nobody would notice was broken.
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
        perFile: true,
        statements: 100,
        branches: 100,
        functions: 100,
        lines: 100,
      },
    },
  },
})
