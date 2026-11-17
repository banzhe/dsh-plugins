import { defineConfig } from 'vitest/config'

/**
 * Standalone suite for the forked browser half. The specs here drive the pure
 * modules directly (grouping tree and path-suffix derivation); the upstream
 * component specs are not copied because they run on
 * `@deepseek-ai/dsh-client-test-runtime`, whose peer closure this workspace
 * does not install. The browser half itself resolves the shell's module table
 * at run time, so no alias is needed for the baseline libraries.
 */
export default defineConfig({
  test: {
    include: ['tests/**/*.spec.ts'],
    pool: 'forks',
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts', 'src/**/*.tsx'],
      exclude: ['src/**/*.d.ts'],
      reporter: ['text'],
    },
  },
})
