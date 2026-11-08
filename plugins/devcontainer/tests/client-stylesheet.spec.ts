import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/**
 * The sheet is inlined into `lib/client.js` at build time, so the only thing a
 * unit test can hold is that it still describes the classes the page renders and
 * stays namespaced.
 */
const SHEET = readFileSync(new URL('../src/client/styles.css', import.meta.url), 'utf8')

describe('the Dev Container variants stylesheet', () => {
  it('styles every class the section renders', () => {
    for (const name of ['.dcv-section', '.dcv-title', '.dcv-intro', '.dcv-count', '.dcv-notice', '.dcv-group', '.dcv-group-title', '.dcv-suffix', '.dcv-group-description', '.dcv-rows', '.dcv-row', '.dcv-main', '.dcv-description', '.dcv-tail', '.dcv-id', '.dcv-state']) {
      expect(SHEET, name).toMatch(new RegExp(`\\${name}(?![\\w-])`))
    }
  })

  it('keeps every selector inside the plugin prefix', () => {
    const selectors = SHEET.replace(/\/\*[\s\S]*?\*\//g, '').match(/\.[a-z][a-z0-9-]*/g) ?? []
    const prefixed = selectors.filter(name => !name.startsWith('.dcv-'))
    expect(prefixed).toEqual([])
  })

  it('uses the shell tokens rather than raw colours', () => {
    expect(SHEET).toContain('var(--dsw-alias-label-primary)')
    expect(SHEET).not.toMatch(/#[0-9a-f]{3,6}/i)
  })
})
