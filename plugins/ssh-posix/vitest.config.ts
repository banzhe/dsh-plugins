import { defineConfig } from 'vitest/config'

/**
 * Suite for the forked connection service: the shipped client, protocol, schema and
 * stream-authentication specs, plus the Windows-host and per-stream forwarding cases
 * this fork adds.
 */
export default defineConfig({
  test: {
    include: ['tests/**/*.spec.ts'],
    pool: 'forks',
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.d.ts'],
      reporter: ['text'],
      thresholds: { statements: 90, branches: 85, functions: 90, lines: 90 },
    },
  },
})
