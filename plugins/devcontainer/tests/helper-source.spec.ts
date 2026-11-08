import { existsSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { HELPER_CONTAINER_DIRECTORY, HELPER_CONTAINER_PATH, helperSource, helperSourcePath } from '../src/helper-source.ts'

describe('the packaged helper source', () => {
  it('points at the program next to the module, not at a compiled artifact', () => {
    expect(helperSourcePath().endsWith(`helper${process.platform === 'win32' ? '\\' : '/'}main.mjs`)).toBe(true)
    expect(existsSync(helperSourcePath())).toBe(true)
  })

  it('returns the program the container runs', () => {
    const source = helperSource()
    expect(source).toBe(readFileSync(helperSourcePath(), 'utf8'))
    expect(source).toContain('export async function handle')
    expect(source).toContain('if (process.argv[1] !== undefined')
    expect(source).not.toContain('require(')
  })

  it('reads the file once per process', () => {
    expect(helperSource()).toBe(helperSource())
  })

  it('stages the program under /tmp and runs it with the container node', () => {
    expect(HELPER_CONTAINER_DIRECTORY).toBe('/tmp/.dsh-devcontainer')
    expect(HELPER_CONTAINER_PATH).toBe('/tmp/.dsh-devcontainer/helper.mjs')
  })
})
