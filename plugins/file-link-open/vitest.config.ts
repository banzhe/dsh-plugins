import { defineConfig } from 'vitest/config'

/**
 * Suite for the file-link right-click menu's link resolution, the host's
 * line-bearing argv rewriting, and the wire/contract boundaries around them.
 *
 * No `ui-primitives` alias is needed here, unlike the plugins that import the
 * shell's library: none of these specs imports it. `react`, `react-dom` and
 * `jsdom` come from the workspace catalog.
 */
export default defineConfig({
  test: {
    include: ['tests/**/*.spec.ts', 'tests/**/*.spec.tsx'],
    pool: 'forks',
    coverage: {
      provider: 'v8',
      // `src/index.ts` is host code whose routes need a live Cordis composition,
      // so a package-wide threshold would demand coverage no unit test can
      // honestly produce. The two pure modules the launch arguments live in are
      // measured completely.
      include: ['src/launch-args.ts', 'src/client/target.ts'],
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
