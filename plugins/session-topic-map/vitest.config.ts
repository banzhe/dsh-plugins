import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: {
      '@deepseek-ai/dsh-client-ui-primitives': fileURLToPath(new URL('./tests/ui-primitives-double.tsx', import.meta.url)),
    },
  },
  test: {
    include: ['tests/**/*.spec.ts', 'tests/**/*.spec.tsx'],
    pool: 'forks',
    css: true,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts', 'src/**/*.tsx'],
      thresholds: {
        statements: 55,
        branches: 55,
        functions: 50,
        lines: 60,
      },
    },
  },
})
