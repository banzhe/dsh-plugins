import { defineConfig } from 'vitest/config'

/**
 * Suite for title derivation and the `/title-refresh` command. Coverage is
 * scoped to the three modules the specs reach through their own interfaces:
 * `src/title.ts` (the derivation), `src/prompt.ts` (its internal formatting
 * seam), and `src/command.ts`. `src/index.ts` is Loader row glue whose live
 * reads are covered by the adapter block in `title-route.spec.ts` but whose
 * registration needs a live Cordis composition, so a package-wide threshold
 * would demand coverage no unit test can honestly produce.
 */
export default defineConfig({
  test: {
    include: ['tests/**/*.spec.ts'],
    pool: 'forks',
    // The browser half imports its sheet as `title-model.css?inline`. Vitest
    // stubs CSS to an empty module by default, which would hand the plugin an
    // empty `<style>` and let any stylesheet assertion pass vacuously.
    css: true,
    coverage: {
      provider: 'v8',
      include: ['src/title.ts', 'src/prompt.ts', 'src/command.ts'],
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
