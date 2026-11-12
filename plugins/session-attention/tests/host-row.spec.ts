/**
 * The Host half of the row: it exists so the Loader has a row to mount and the
 * client half has a name to hang on. It contributes no services, no hooks, and
 * no configuration of its own.
 */
import { describe, expect, it } from 'vitest'
import * as host from '../src/index.ts'

describe('the Host row', () => {
  it('carries the Loader row id the client half is paired with', () => {
    expect(host.name).toBe('session-attention')
    expect(typeof host.apply).toBe('function')
  })

  it('mounts as a no-op, so applying it twice neither throws nor registers', () => {
    // The row takes no context and has nothing to install: the only observable
    // is that mounting it is inert.
    expect(() => {
      host.apply()
      host.apply()
    }).not.toThrow()
  })
})
