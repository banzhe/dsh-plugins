import { describe, expect, it } from 'vitest'
import { parseJsonc, stripJsonComments } from '../src/jsonc.ts'

describe('parseJsonc', () => {
  it('accepts the Dev Container dialect: comments and trailing commas', () => {
    const text = [
      '{',
      '  // the image to build',
      '  "image": "mcr.microsoft.com/devcontainers/base:ubuntu",',
      '  /* block comment',
      '     spanning lines */',
      '  "features": { "ghcr.io/devcontainers/features/node:1": {} },',
      '  "remoteUser": "vscode",',
      '}',
    ].join('\n')
    expect(parseJsonc(text)).toEqual({
      image: 'mcr.microsoft.com/devcontainers/base:ubuntu',
      features: { 'ghcr.io/devcontainers/features/node:1': {} },
      remoteUser: 'vscode',
    })
  })

  it('keeps comment markers that live inside strings', () => {
    const text = [
      '{',
      '  "image": "ghcr.io/acme/tool:1 // pinned",',
      '  "postCreateCommand": "echo \'/* not a comment */\'",',
      '  "url": "https://example.test/path",',
      '}',
    ].join('\n')
    expect(parseJsonc(text)).toEqual({
      image: 'ghcr.io/acme/tool:1 // pinned',
      postCreateCommand: "echo '/* not a comment */'",
      url: 'https://example.test/path',
    })
  })

  it('keeps escaped quotes and backslashes inside strings', () => {
    expect(parseJsonc(String.raw`{ "cmd": "say \"hi\"" }`)).toEqual({ cmd: 'say "hi"' })
    expect(parseJsonc(String.raw`{ "path": "C:\\temp\\x" }`)).toEqual({ path: 'C:\\temp\\x' })
  })

  it('drops trailing commas in arrays as well as objects', () => {
    expect(parseJsonc('[1, 2, 3,]')).toEqual([1, 2, 3])
    expect(parseJsonc('{ "a": [1,], }')).toEqual({ a: [1] })
  })

  it('tolerates a leading byte-order mark and surrounding whitespace', () => {
    expect(parseJsonc('\uFEFF\n  { "a": 1 }\n')).toEqual({ a: 1 })
  })

  it('rejects a document that is not JSONC', () => {
    expect(() => parseJsonc('{ "a": }')).toThrow()
  })

  it('exposes the stripped text', () => {
    expect(stripJsonComments('{ // note\n "a": 1 }')).toBe('{ \n "a": 1 }')
  })
})
