import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

/**
 * Standalone suite for the forked browser half. The specs here drive the pure
 * modules and the attention region directly; the upstream component specs are not
 * copied because they run on '@deepseek-ai/dsh-client-test-runtime', whose peer
 * closure this workspace does not install. The browser half itself resolves the
 * shell's module table at run time, so only the static ui-primitives library needs
 * a stand-in for the Node run: importing the real module eagerly evaluates the
 * markdown and code-highlighting tree.
 *
 * Coverage is measured over every shipped source, so the number describes the
 * package rather than the files the specs happen to touch. The global thresholds
 * are a floor, not a target: they sit just under the measured global number — the
 * fork ships several hundred lines of copied UI whose specs were not copied with
 * it — and the intent is that they ratchet upward as that surface gains tests. The
 * floor follows the shipped code's size: deleting covered lines lowers the package
 * ratio without adding untested logic, so the floor is re-measured whenever the
 * shipped code shrinks, and a run is never made to pass by relaxing it.
 *
 * The attention region is the half this fork owns end to end, so it is pinned
 * separately: its thresholds sit just under the coverage this suite reaches today
 * (98 statements / 95 branches / 100 functions / 100 lines), which keeps a
 * regression in the fold or the region from hiding behind the copied code.
 */
export default defineConfig({
  resolve: {
    alias: {
      '@deepseek-ai/dsh-client-ui-primitives': fileURLToPath(
        new URL('./tests/ui-primitives-double.tsx', import.meta.url),
      ),
    },
  },
  test: {
    include: ['tests/**/*.spec.ts', 'tests/**/*.spec.tsx'],
    pool: 'forks',
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts', 'src/**/*.tsx'],
      exclude: ['src/**/*.d.ts'],
      reporter: ['text'],
      thresholds: {
        statements: 19,
        branches: 18,
        functions: 16,
        lines: 19,
        'src/client/attention/**': { statements: 95, branches: 85, functions: 95, lines: 95 },
      },
    },
  },
})
