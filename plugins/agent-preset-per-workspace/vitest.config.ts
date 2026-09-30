import { defineConfig } from 'vitest/config'

/**
 * Thresholds cover every shipped module, `src/index.ts` included:
 * `tests/plugin.spec.ts` drives its listeners over a real Cordis context, so
 * the glue is measured honestly rather than excluded.
 */
export default defineConfig({
  test: {
    include: ['tests/**/*.spec.ts'],
    pool: 'forks',
    coverage: {
      provider: 'v8',
      include: ['src/index.ts', 'src/policy.ts', 'src/domain.ts'],
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
