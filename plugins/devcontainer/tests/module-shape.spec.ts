import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import * as hostModule from '../src/index.ts'
import * as shellModule from '../src/shell.ts'
import * as fsModule from '../src/fs.ts'
import { Config as HostConfig } from '../src/index.ts'
import { hostMountFields, sandboxTemplateFields } from '../src/options.ts'

/**
 * The Loader normalizes a plugin through `unwrapExports`
 * (`vendor/loader/src/index.ts:209-216`): `exports.default ?? exports`. A module
 * that exports BOTH a default and named meta therefore loses the named meta — a
 * `default`-exported `apply` is the whole plugin, so `Config` never reaches
 * Cordis, the row activates with the raw (absent) config, and `config.presets`
 * throws at boot. These checks pin the export shape each row must keep.
 */
describe('plugin module shape', () => {
  it('the host row exports no default, so its schema and name survive unwrapping', () => {
    expect('default' in hostModule).toBe(false)
    expect(typeof hostModule.apply).toBe('function')
    expect(hostModule.name).toBe('devcontainer')
    expect(hostModule.Config).toBeDefined()
  })

  it('the shell row is a class plugin whose schema is a static', () => {
    expect(typeof shellModule.default).toBe('function')
    const plugin = shellModule.default as unknown as { Config?: unknown, inject?: unknown }
    expect(plugin.Config).toBeDefined()
    expect(plugin.inject).toEqual(['subprocess', 'sandbox', 'sandboxPolicy'])
    // The static must be the schema the row actually needs, not the inherited one.
    const resolved = resolveSchema(plugin.Config)
    expect(resolved['requireContainer']).toBe(false)
    expect(resolved['containerTimeoutMs']).toBe(300_000)
  })

  it('the fs row is a class plugin whose schema carries the container knobs', () => {
    const plugin = fsModule.default as unknown as { Config?: unknown }
    expect(plugin.Config).toBeDefined()
    const resolved = resolveSchema(plugin.Config)
    expect(resolved['requireContainer']).toBe(false)
    expect(resolved['diffBasisMaxBytes']).toBe(10 * 1024 * 1024)
    expect(resolved['rpcTimeoutMs']).toBe(60_000)
  })
})

/** Resolve one schema with no input, as the Loader does for a row without config. */
function resolveSchema(Config: unknown): Record<string, unknown> {
  const standard = (Config as { '~standard': { validate(value: unknown): { value: Record<string, unknown> } } })['~standard']
  return standard.validate(undefined).value
}

/** A context with nothing composed: the row must still load. */
function bare(): Context {
  return new Context()
}

describe('the host row loads without a config', () => {
  it('accepts an absent config (a row inserted with no config: writes none)', () => {
    const ctx = bare()
    expect(() => { hostModule.apply(ctx) }).not.toThrow()
    expect(() => { hostModule.apply(ctx, undefined) }).not.toThrow()
  })

  it('accepts an empty object', () => {
    const ctx = bare()
    expect(() => { hostModule.apply(ctx, {} as never) }).not.toThrow()
  })

  it('accepts a config that names only presets', () => {
    const ctx = bare()
    expect(() => { hostModule.apply(ctx, { presets: { win32Only: false } } as never) }).not.toThrow()
  })

  it('accepts the schema output, including a missing sources reference', () => {
    const ctx = bare()
    const resolved = HostConfig({}) as NonNullable<Parameters<typeof hostModule.apply>[1]>
    expect(resolved.sources).toBeDefined()
    expect(() => { hostModule.apply(ctx, resolved) }).not.toThrow()
  })
})

describe('the fields a settings page writes', () => {
  /** The schemastery flag a Loader row needs to see a settings write without reloading. */
  function volatileOf(schema: unknown): boolean {
    return (schema as { meta?: { volatile?: boolean } }).meta?.volatile === true
  }

  it('marks the image and the extra mounts volatile, so a write lands before a reload', () => {
    // The resolved config carries a live reference for such a field, so the flag is
    // read from the schema the Loader validates.
    expect(volatileOf(hostMountFields().hostMounts)).toBe(true)
    expect(volatileOf(sandboxTemplateFields().sbxTemplate)).toBe(true)
  })
})

describe('the sandbox image field', () => {
  it('defaults to no image, so a created sandbox keeps the CLI template', () => {
    expect(HostConfig({}).sbxTemplate.get()).toBe('')
  })

  it('accepts a registry reference, a digest, and a local template name', () => {
    for (const value of [
      'docker.io/org/img:tag',
      'docker.io/org/img@sha256:6f9e3f0c0d0f4f0e8f7a1b2c3d4e5f60718293a4b5c6d7e8f90102130405060',
      'my-template:v1',
      'img',
    ]) {
      expect(HostConfig({ sbxTemplate: value }).sbxTemplate.get()).toBe(value)
    }
  })

  it('refuses a value it could not pass as one argv token', () => {
    for (const value of ['--rm', 'org/img latest', 'img\t2']) {
      expect(() => HostConfig({ sbxTemplate: value })).toThrow()
    }
  })
})
