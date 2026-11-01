import { describe, expect, it } from 'vitest'
import { en, zh } from '../src/client/locales.ts'

/** The keys one dictionary publishes, in declaration order. */
function keysOf(dictionary: Record<string, string>): string[] {
  return Object.keys(dictionary)
}

describe('preset-visibility dictionaries', () => {
  it('publishes the same keys in both languages', () => {
    expect(keysOf(zh)).toEqual(keysOf(en))
  })

  it('leaves no copy empty or untranslated', () => {
    for (const [key, value] of Object.entries(en)) {
      expect(value.trim(), key).not.toBe('')
      expect(zh[key as keyof typeof zh].trim(), key).not.toBe('')
      // A Chinese entry that still carries the English sentence is a missed
      // translation, not a translation.
      expect(zh[key as keyof typeof zh], key).not.toBe(value)
    }
  })

  it('keeps the count placeholder in the one entry that takes a parameter', () => {
    expect(en.hiddenCount).toContain('{count}')
    expect(zh.hiddenCount).toContain('{count}')
  })
})
