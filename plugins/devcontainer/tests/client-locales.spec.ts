import { describe, expect, it } from 'vitest'
import { en, zh } from '../src/client/locales.ts'

describe('the Dev Container variants dictionaries', () => {
  it('cover the same keys in both languages', () => {
    expect(Object.keys(en).sort()).toEqual(Object.keys(zh).sort())
  })

  it('carry no empty copy', () => {
    for (const [key, value] of [...Object.entries(en), ...Object.entries(zh)]) {
      expect(value.trim(), key).not.toBe('')
    }
  })

  it('place every placeholder the page interpolates', () => {
    expect(en.checkedCount).toContain('{count}')
    expect(zh.checkedCount).toContain('{count}')
    expect(en.sbxCheckedCount).toContain('{count}')
    expect(zh.sbxCheckedCount).toContain('{count}')
  })

  it('names both tracks and their empty states on both languages', () => {
    for (const dictionary of [en, zh]) {
      expect(dictionary.devcontainerTitle).not.toBe(dictionary.sbxTitle)
      expect(dictionary.devcontainerDescription).not.toBe(dictionary.sbxDescription)
      expect(dictionary.noneChecked).not.toBe(dictionary.sbxNoneChecked)
      expect(dictionary.empty).not.toBe(dictionary.sbxEmpty)
    }
  })
})
