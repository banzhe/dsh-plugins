import { defineConfig } from 'vitest/config'

/**
 * Suite for the file-link right-click menu's link resolution, the host's
 * line-bearing argv rewriting, and the wire/contract boundaries around them.
 *
 * The specs drive `src/*.ts` directly and none of them imports
 * `@deepseek-ai/dsh-client-ui-primitives` — the Web shell's static library,
 * whose eager katex/shiki/micromark tree this standalone package does not
 * install — so no alias stand-in is needed here, unlike the plugins that import
 * the shell's library. `link-target.spec.tsx` renders the official
 * `MarkdownFileLink` shape with real React in jsdom, and
 * `official-launch-contract.spec.ts` drives the real official resolver through
 * its injectable launcher hook. `react`, `react-dom` and `jsdom` come from the
 * workspace catalog.
 */
export default defineConfig({
  test: {
    include: ['tests/**/*.spec.ts', 'tests/**/*.spec.tsx'],
    pool: 'forks',
    coverage: {
      provider: 'v8',
      // `src/index.ts` is host provider code whose routes need a live Cordis
      // composition, so a package-wide threshold would demand coverage no unit
      // test can honestly produce. The two pure modules the launch arguments
      // live in are measured completely.
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
