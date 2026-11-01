import { describe, expect, it } from 'vitest'
import { apply, Config, name } from '../src/index.ts'

describe('the Host half', () => {
  it('is the Loader row whose id the settings page edits', () => {
    expect(name).toBe('agent-preset-visibility')
  })

  it('ships an empty hidden list, so an install hides nothing', () => {
    // `.volatile()` resolves the field to the live reference the Host hands the
    // plugin, so the stored list is what `.get()` returns.
    expect(Config({}).hidden.get()).toEqual([])
    expect(Config({ hidden: ['minimal'] }).hidden.get()).toEqual(['minimal'])
  })

  it('registers nothing: the Host roster stays complete', () => {
    // The Host half exists for its schema, so it must not touch the context at
    // all — one probe per property keeps that honest.
    const untouched = new Proxy({}, {
      get(_target, property) { throw new Error(`apply read ${String(property)} from the Host context`) },
    })
    apply(untouched as never)
  })
})
