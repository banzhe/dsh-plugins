import { defineConfig } from 'vitest/config'

/**
 * Suite for the Host half: one spec drives the repository seams against real
 * scratch repositories, the other the HTTP route handlers with a Cordis context
 * and Node request/response doubles. The browser half has its own specs; no build
 * step and no jsdom are involved, because every subject here is Node code that
 * shells out to `git` — the components are rendered through the same harness.
 *
 * Coverage is measured over every shipped source, component files included, so
 * the number describes the package rather than the files the specs happen to
 * touch. The global thresholds are a floor, not a target: they sit under what the
 * suite reached when the gate was introduced, and the intent is that they ratchet
 * upward as the browser half fills in — never downward to make a run pass.
 *
 * The two modules the Host half exists for are pinned higher on their own
 * (`git.ts` and `routes.ts` at 90/85/90/90), so a regression in repository
 * handling or in a route cannot hide behind the rest of the package. `shared.ts`
 * carries the route constants and wire types both specs exercise, so all four of
 * its thresholds are 100.
 */
export default defineConfig({
  test: {
    include: ['tests/**/*.spec.ts'],
    pool: 'forks',
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts', 'src/**/*.tsx'],
      reporter: ['text'],
      thresholds: {
        statements: 60,
        branches: 50,
        functions: 50,
        lines: 65,
        'src/git.ts': { statements: 90, branches: 85, functions: 90, lines: 90 },
        'src/routes.ts': { statements: 90, branches: 85, functions: 90, lines: 90 },
        'src/shared.ts': { statements: 100, branches: 100, functions: 100, lines: 100 },
      },
    },
  },
})