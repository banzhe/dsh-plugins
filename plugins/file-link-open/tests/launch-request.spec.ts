/**
 * `parseBody` is the only gate between an HTTP body and the resolver, so a
 * malformed `line` is REJECTED rather than dropped: silently opening at the top
 * would hide a client bug behind a plausible-looking launch.
 */
import { describe, expect, it } from 'vitest'
import { parseBody } from '../src/index.ts'

/** The request body text for one value. */
const body = (value: unknown) => JSON.stringify(value)

/** A well-formed request whose only variable is `line`. */
const request = (line?: unknown) => ({ app: 'vscode', path: '/tmp/a.ts', ...(line === undefined ? {} : { line }) })

describe('parseBody', () => {
  it('accepts an app and a path', () => {
    expect(parseBody(body({ app: 'vscode', path: '/tmp/a.ts' })))
      .toEqual({ app: 'vscode', path: '/tmp/a.ts' })
  })

  it('accepts a positive integer line', () => {
    expect(parseBody(body(request(24))))
      .toEqual({ app: 'vscode', path: '/tmp/a.ts', line: 24 })
  })

  it('ignores fields the route does not define', () => {
    expect(parseBody(body({ app: 'vscode', path: '/tmp/a.ts', cwd: '/tmp' })))
      .toEqual({ app: 'vscode', path: '/tmp/a.ts' })
  })

  it.each([
    ['not JSON at all', 'not json'],
    ['a JSON scalar', '42'],
    ['JSON null', 'null'],
    ['a JSON array', '[]'],
  ])('rejects %s', (_why, text) => {
    expect(parseBody(text)).toBeNull()
  })

  it.each([
    ['a non-string app', { app: 7, path: '/tmp/a.ts' }],
    ['a missing app', { path: '/tmp/a.ts' }],
    ['a non-string path', { app: 'vscode', path: 7 }],
    ['a missing path', { app: 'vscode' }],
  ])('rejects %s', (_why, value) => {
    expect(parseBody(body(value))).toBeNull()
  })

  it.each([
    ['zero', 0],
    ['negative', -1],
    ['fractional', 1.5],
    ['a string', '24'],
    ['null', null],
    ['not a safe integer', Number.MAX_SAFE_INTEGER + 1],
  ])('rejects a %s line instead of dropping it', (_why, line) => {
    expect(parseBody(body(request(line)))).toBeNull()
  })
})
