/**
 * The rescue wrapper, driven through the plugin's real `apply` over a real
 * Cordis context. The registry double attaches `resolve`/`retain` to a
 * prototype (a class instance's shape), so the tests prove the own-property
 * patch reaches both direct readers and `mount`-style `this.retain` dispatch —
 * and that uninstall restores prototype behaviour.
 */
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { apply, inject, name } from '../src/index.ts'

interface RegistryShape {
  defaultId: string
  resolve(wanted?: string): Promise<{ id: string }>
  retain(wanted?: string): Promise<{ id: string }>
}

function notFound(wanted: string) {
  return Object.assign(new Error(`Unknown agent preset: ${wanted}`), {
    code: 'agent-preset/not-found',
    details: { agentPreset: wanted, available: ['standard'] },
  })
}

function invalid(wanted: string) {
  return Object.assign(new Error(`Preset ${wanted} cannot compose`), {
    code: 'agent-preset/invalid',
    details: { agentPreset: wanted, reason: 'activation failed' },
  })
}

function locked(sessionId: string) {
  return Object.assign(new Error('This session has already started'), {
    code: 'agent-preset/locked',
    details: { sessionId, agentPreset: 'code' },
  })
}

/** A stand-in whose methods live on the prototype, like `AgentPresetRegistry`. */
class RegistryDouble implements RegistryShape {
  defaultId = 'standard'
  definitions = new Set(['standard'])

  async resolve(wanted?: string) {
    return this.retain(wanted) as unknown as { id: string }
  }

  async retain(wanted?: string) {
    const id = wanted ?? this.defaultId
    if (!this.definitions.has(id)) throw notFound(id)
    return { id }
  }
}

interface Bench {
  ctx: Context
  registry: RegistryDouble
}

/** Whether `apply` patched the prototype-typed instance with own properties. */
function ownPatched(bench: Bench): boolean {
  return Object.getOwnPropertyDescriptor(bench.registry, 'resolve') !== undefined
    && Object.getOwnPropertyDescriptor(bench.registry, 'retain') !== undefined
}

const disposers: Array<{ dispose(): Promise<void> }> = []

afterEach(async () => {
  while (disposers.length > 0) await disposers.pop()?.dispose()
})

async function bench(options: { definitions?: Set<string>, defaultId?: string } = {}): Promise<Bench> {
  const ctx = new Context()
  const registry = new RegistryDouble()
  if (options.defaultId !== undefined) registry.defaultId = options.defaultId
  if (options.definitions !== undefined) registry.definitions = options.definitions
  ctx.provide('agentPresets', registry as never)
  const fiber = ctx.plugin({ inject: [...inject], apply })
  await (fiber as unknown as { await(): Promise<void> }).await()
  disposers.push({ dispose: () => fiber.dispose() })
  return { ctx, registry }
}

describe('patching', () => {
  it('installs own properties over the prototype methods', async () => {
    const b = await bench()
    expect(ownPatched(b)).toBe(true)
  })

  it('restores the prototype methods on unload', async () => {
    const b = await bench()
    const fiber = disposers.pop()!
    await fiber.dispose()

    expect(ownPatched(b)).toBe(false)
    await expect(b.registry.resolve('standard')).resolves.toEqual({ id: 'standard' })
  })

  it('leaves resolve untouched when resolve is already an own property', async () => {
    const ctx = new Context()
    const registry = new RegistryDouble()
    const guarded = vi.fn(async (wanted?: string) => ({ id: wanted ?? registry.defaultId }))
    Object.defineProperty(registry, 'resolve', { value: guarded, configurable: true, writable: true })
    ctx.provide('agentPresets', registry as never)
    const fiber = ctx.plugin({ inject: [...inject], apply })
    await (fiber as unknown as { await(): Promise<void> }).await()
    disposers.push({ dispose: () => fiber.dispose() })

    guardCheck(registry, 'resolve', guarded)
    await fiber.dispose()
  })

  it('leaves retain untouched when retain is already an own property', async () => {
    const ctx = new Context()
    const registry = new RegistryDouble()
    const guarded = vi.fn(async (wanted?: string) => ({ id: wanted ?? registry.defaultId }))
    Object.defineProperty(registry, 'retain', { value: guarded, configurable: true, writable: true })
    ctx.provide('agentPresets', registry as never)
    const fiber = ctx.plugin({ inject: [...inject], apply })
    await (fiber as unknown as { await(): Promise<void> }).await()
    disposers.push({ dispose: () => fiber.dispose() })

    guardCheck(registry, 'retain', guarded)
    await fiber.dispose()
  })

  function guardCheck(registry: RegistryDouble, method: 'resolve' | 'retain', guarded: unknown): void {
    const descriptor = Object.getOwnPropertyDescriptor(registry, method)
    expect(descriptor).toBeDefined()
    expect(descriptor?.value).toBe(guarded)
  }
})

describe('rescuing resolve', () => {
  it('falls back to the default for a preset that no longer exists', async () => {
    const b = await bench()
    const warn = vi.spyOn(b.ctx.logger, 'warn').mockImplementation(() => {})

    await expect(b.registry.resolve('fragile-test')).resolves.toEqual({ id: 'standard' })
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('preset "fragile-test" is gone'),
    )
  })

  it('falls back to the default for a preset whose composition fails', async () => {
    const b = await bench()
    const warn = vi.spyOn(b.ctx.logger, 'warn').mockImplementation(() => {})
    b.registry.definitions.add('broken')
    const originalRetain = b.registry.retain.bind(b.registry)
    b.registry.retain = async (wanted?: string) => {
      if (wanted === 'broken') throw invalid('broken')
      return originalRetain(wanted)
    }

    // resolve routes through this.retain, so the patched retain rescues it.
    await expect(b.registry.resolve('broken')).resolves.toEqual({ id: 'standard' })
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('is broken'))
  })

  it('rescues failures surfaced directly by each wrapper', async () => {
    class DirectThrow extends RegistryDouble {
      override async resolve(wanted?: string) {
        if (wanted === 'broken') throw invalid(wanted)
        if (wanted === 'gone') throw notFound(wanted)
        return { id: wanted ?? this.defaultId }
      }

      override async retain(wanted?: string) {
        if (wanted === 'broken') throw invalid(wanted)
        return { id: wanted ?? this.defaultId }
      }
    }
    const ctx = new Context()
    const registry = new DirectThrow()
    ctx.provide('agentPresets', registry as never)
    const fiber = ctx.plugin({ inject: [...inject], apply })
    await (fiber as unknown as { await(): Promise<void> }).await()
    disposers.push({ dispose: () => fiber.dispose() })
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})

    await expect(registry.resolve('broken')).resolves.toEqual({ id: 'standard' })
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('is broken'))
    await expect(registry.resolve('gone')).resolves.toEqual({ id: 'standard' })
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('is gone'))
    await expect(registry.retain('broken')).resolves.toEqual({ id: 'standard' })
    expect(warn).toHaveBeenCalledTimes(3)

    class ShapelessRetain extends DirectThrow {
      override async retain(wanted?: string) {
        if (wanted === 'shapeless') throw new TypeError('not a remote error')
        return super.retain(wanted)
      }
    }
    const ctx2 = new Context()
    const registry2 = new ShapelessRetain()
    ctx2.provide('agentPresets', registry2 as never)
    const fiber2 = ctx2.plugin({ inject: [...inject], apply })
    await (fiber2 as unknown as { await(): Promise<void> }).await()
    disposers.push({ dispose: () => fiber2.dispose() })

    await expect(registry2.retain('shapeless')).rejects.toBeInstanceOf(TypeError)
  })

  it('propagates codes outside the rescue set', async () => {
    const b = await bench()
    vi.spyOn(b.ctx.logger, 'warn').mockImplementation(() => {})
    const originalRetain = b.registry.retain.bind(b.registry)
    b.registry.retain = async (wanted?: string) => {
      if (wanted === 'code') throw locked('session-1')
      return originalRetain(wanted)
    }

    await expect(b.registry.resolve('code')).rejects.toMatchObject({ code: 'agent-preset/locked' })
  })

  it('does not rescue the default itself, which must surface its own failure', async () => {
    const b = await bench({ defaultId: 'gone-default', definitions: new Set() })

    await expect(b.registry.resolve('gone-default')).rejects.toMatchObject({ code: 'agent-preset/not-found' })
  })

  it('lets the no-id default lookup keep its own not-found', async () => {
    const b = await bench({ defaultId: 'gone-default', definitions: new Set() })

    await expect(b.registry.resolve()).rejects.toMatchObject({ code: 'agent-preset/not-found' })
  })

  it('propagates errors that are not RemoteError-shaped', async () => {
    const b = await bench()
    vi.spyOn(b.ctx.logger, 'warn').mockImplementation(() => {})
    b.registry.definitions.add('weird')
    const originalRetain = b.registry.retain.bind(b.registry)
    b.registry.retain = async (wanted?: string) => {
      if (wanted === 'weird') throw new TypeError('not a remote error')
      return originalRetain(wanted)
    }

    await expect(b.registry.resolve('weird')).rejects.toBeInstanceOf(TypeError)
  })
})

describe('rescuing retain through internal dispatch', () => {
  it('intercepts a mount-style this.retain for a gone preset', async () => {
    const b = await bench()
    const warn = vi.spyOn(b.ctx.logger, 'warn').mockImplementation(() => {})

    await expect(b.registry.retain('fragile-test')).resolves.toEqual({ id: 'standard' })
    expect(warn).toHaveBeenCalledTimes(1)
  })

  it('propagates invalid for the default id reached without an argument', async () => {
    const b = await bench({ defaultId: 'standard' })
    vi.spyOn(b.ctx.logger, 'warn').mockImplementation(() => {})
    b.registry.definitions.clear()

    await expect(b.registry.retain()).rejects.toMatchObject({ code: 'agent-preset/not-found' })
  })
})

describe('identity', () => {
  it('exports the loader-facing name', () => {
    expect(name).toBe('agent-preset-fallback')
  })
})