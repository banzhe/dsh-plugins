import { defineConfig } from 'vitest/config'

/**
 * 100% thresholds over the shipped module, matching the workspace convention:
 * `tests/rescue.spec.ts` drives the real `apply` over a real Cordis context,
 * so the glue is measured rather than excluded.
 */
export default defineConfig({
  test: {
    include: ['tests/**/*.spec.ts'],
    pool: 'forks',
    coverage: {
      provider: 'v8',
      include: ['src/index.ts'],
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