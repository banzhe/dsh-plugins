import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
// The real sheet as text. Vitest stubs CSS to an empty module unless `test.css`
// is on, so this import is also what proves that switch is live.
import visibilityCss from '../src/client/visibility.css?inline'

const COMPONENT = new URL('../src/client/PresetVisibilitySection.tsx', import.meta.url)

/** Every `apv-` class the page puts on an element. */
function classesUsed(): string[] {
  const source = readFileSync(COMPONENT, 'utf8')
  const found = new Set<string>()
  for (const match of source.matchAll(/className="([^"]+)"/g)) {
    for (const name of (match[1] ?? '').split(/\s+/)) {
      if (name.startsWith('apv-')) found.add(name)
    }
  }
  return [...found].sort()
}

describe('the page stylesheet', () => {
  it('arrives as text rather than an empty stub', () => {
    expect(visibilityCss.length).toBeGreaterThan(0)
    expect(visibilityCss).toContain('.apv-section')
  })

  it('defines every class the page renders', () => {
    expect(classesUsed().length).toBeGreaterThan(0)
    for (const name of classesUsed()) {
      expect(visibilityCss, name).toMatch(new RegExp('\\.' + name + '(?![\\w-])'))
    }
  })

  it('paints only through the shell tokens, never a literal colour', () => {
    expect(visibilityCss).not.toMatch(/#[0-9a-fA-F]{3,8}\b/)
    expect(visibilityCss).not.toMatch(/\b(?:rgba?|hsla?)\(/)
    for (const match of visibilityCss.matchAll(/color:\s*([^;]+);/g)) {
      expect(match[1], match[0]).toContain('var(--dsw-')
    }
  })
})
