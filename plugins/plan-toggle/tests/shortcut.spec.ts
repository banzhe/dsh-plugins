/**
 * @vitest-environment jsdom
 *
 * Sealed-contract behavior suite for the plan-toggle composer shortcut.
 * Everything here is observed through the four public services the client half
 * injects; the production implementation is reached only through its plugin
 * entry and the claim it hands to the input machine.
 */
import { describe, expect, it } from 'vitest'
import * as host from '../src/index.ts'
import * as production from '../src/client/index.ts'
import {
  composerTarget,
  resolvePluginEntry,
  startPlugin,
  type GestureOverrides,
  type Harness,
  type HarnessOptions,
  type InputPhaseName,
  type PlanProjectionState,
  type SessionRow,
} from './doubles.ts'

const entry = resolvePluginEntry(production)

const PLAN_TOKEN = '/plan '
const PLAN_CLAIM = { name: 'plan', token: PLAN_TOKEN }
/** Plan mode is off, so the effective target is off. */
const PLAN_OFF: PlanProjectionState = { active: false, pending: false }
/** Plan mode is on, so the effective target is on. */
const PLAN_ON: PlanProjectionState = { active: true, pending: false }

/** Mount the client half with the plan projection the scenario needs. */
function open(options: HarnessOptions = {}): Promise<Harness> {
  return startPlugin(entry, { projection: PLAN_OFF, ...options })
}

/** Index of the first draft write (either consume channel) in the action log. */
function draftWriteIndex(harness: Harness): number {
  return harness.log.findIndex((entry) => entry.startsWith('setDraft') || entry === 'consume-token')
}

/** Settle the claimed command the press registered, through its own closure. */
async function submitClaim(
  harness: Harness,
  args: string,
): Promise<{ kind: unknown; text: unknown }> {
  const [call] = harness.beginCommands
  if (call === undefined) throw new Error('the press did not claim the plan command')
  const submit = call.claim.submit
  if (submit === undefined) throw new Error('the claim carries no submit()')
  const outcome: unknown = await submit(args, harness.scope, [])
  await harness.flush()
  const shaped = outcome as { kind?: unknown; text?: unknown }
  return { kind: shaped.kind, text: shaped.text }
}

describe('client contract', () => {
  it('injects the four services the composer shortcut depends on', () => {
    expect(entry.inject).toEqual(['sessions', 'conversation', 'shortcuts', 'locale'])
  })

  it('registers one fixed input action with its localized label', async () => {
    const harness = await open()
    expect(harness.listenerRegistrations).toBe(1)
    expect(harness.fixedCommands).toHaveLength(1)
    const [command] = harness.fixedCommands
    if (command === undefined) throw new Error('no fixed command registered')
    expect(command.id).toBe('plan.toggle')
    expect(command.group).toBe('input')
    expect(command.keys).toEqual(['Shift', 'Tab'])
    expect(command.bindings).toEqual([{ code: 'Tab', modifiers: ['shift'] }])
    expect(command.label?.()).toBe('plan-toggle:shortcut.toggle')
  })

  it('registers bilingual plan-toggle dictionaries', async () => {
    const harness = await open()
    const dictionaries = harness.dictionaries.get('plan-toggle')
    expect(dictionaries).toBeDefined()
    if (dictionaries === undefined) throw new Error('plan-toggle dictionaries missing')
    expect(Object.keys(dictionaries).sort()).toEqual(['en', 'zh'])
    expect(dictionaries.en?.['shortcut.toggle']?.length).toBeGreaterThan(0)
    expect(dictionaries.zh?.['shortcut.toggle']?.length).toBeGreaterThan(0)
    expect(Object.keys(dictionaries.en ?? {}).sort()).toEqual(Object.keys(dictionaries.zh ?? {}).sort())
  })
})

describe('ignored keyboard input', () => {
  const IGNORED: readonly (readonly [string, GestureOverrides])[] = [
    ['an IME composition', { composing: true }],
    ['an already prevented keydown', { defaultPrevented: true }],
    ['an auto-repeating keydown', { repeat: true }],
    ['another physical key', { code: 'KeyA' }],
    ['Control held', { control: true }],
    ['Alt held', { alt: true }],
    ['Meta held', { meta: true }],
  ]

  it.each(IGNORED)('ignores %s', async (_label, gesture) => {
    const harness = await open()
    const consumed = harness.press(gesture)
    await harness.flush()
    expect(consumed).toBe(false)
    expect(harness.log).toEqual([])
  })
})

describe('composer target', () => {
  it('ignores a keydown outside a composer input', async () => {
    const harness = await open()
    harness.press({ target: composerTarget({ insideInput: false, insideCard: false }) })
    await harness.flush()
    expect(harness.log).toEqual([])
  })

  it('ignores a composer card whose trigger menu is open', async () => {
    const harness = await open()
    harness.press({ dom: { triggerMenuOpen: true } })
    await harness.flush()
    expect(harness.log).toEqual([])
  })

  it('acts on a composer input whose card has no open trigger menu', async () => {
    const harness = await open()
    const consumed = harness.press({ dom: { insideCard: true } })
    await harness.flush()
    expect(consumed).toBe(true)
    expect(harness.beginCommands).toHaveLength(1)
  })
})

describe('session selection', () => {
  it('targets the first listed session retained by the main view', async () => {
    const rows: readonly SessionRow[] = [
      { id: 'idle', retainedBy: { controllerOperation: 2 } },
      { id: 'visible', retainedBy: { mainView: 1 } },
      { id: 'later', retainedBy: { mainView: 3 } },
    ]
    const harness = await open({ rows })
    harness.press()
    await harness.flush()
    expect(harness.projectionSessions).toEqual(['visible'])
    expect(harness.bindingIds).toContain('visible')
    expect(harness.scopeIds).toContain('visible')
    expect(harness.beginCommands).toHaveLength(1)
  })

  it('does nothing without a session retained by the main view', async () => {
    const harness = await open({ rows: [{ id: 'idle', retainedBy: { controllerOperation: 1 } }] })
    harness.press()
    await harness.flush()
    expect(harness.log).toEqual([])
    expect(harness.projectionSessions).toEqual([])
  })

  it('does nothing when the retained session has no binding', async () => {
    const harness = await open({ rows: [{ id: 'session-1', retainedBy: { mainView: 1 }, binding: false }] })
    harness.press()
    await harness.flush()
    expect(harness.log).toEqual([])
  })

  it('does nothing when the retained session has no scope', async () => {
    const harness = await open({ rows: [{ id: 'session-1', retainedBy: { mainView: 1 }, scope: false }] })
    harness.press()
    await harness.flush()
    expect(harness.log).toEqual([])
  })
})

describe('plan target', () => {
  const TARGETS: readonly (readonly [string, PlanProjectionState, boolean])[] = [
    ['claims plainly while plan mode is off', PLAN_OFF, false],
    ['claims plainly while a plan activation is pending', { active: true, pending: true }, false],
    ['prefills the off spelling while plan mode is on', PLAN_ON, true],
    ['prefills the off spelling while a plan deactivation is pending', { active: false, pending: true }, true],
  ]

  it.each(TARGETS)('%s', async (_label, projection, prefillsOff) => {
    const harness = await open({ projection })
    const consumed = harness.press()
    await harness.flush()
    expect(harness.projectionKeys).toEqual(['plan'])
    expect(consumed).toBe(true)
    expect(harness.beginCommands).toHaveLength(1)
    expect(harness.commands).toEqual([])
    if (prefillsOff) {
      expect(harness.drafts).toEqual(['off'])
      expect(harness.log).toEqual(['setDraft:off', 'beginCommand', 'consume'])
    } else {
      expect(harness.drafts).toEqual([])
      expect(harness.log).toEqual(['beginCommand', 'consume'])
    }
  })

  it('does nothing while the plan projection is absent', async () => {
    const harness = await open({ projection: undefined })
    harness.press()
    await harness.flush()
    expect(harness.log).toEqual([])
  })

  it('does nothing while the plan projection carries no booleans', async () => {
    const harness = await open({ projection: {} })
    harness.press()
    await harness.flush()
    expect(harness.log).toEqual([])
  })
})

describe('busy composer', () => {
  const BUSY: readonly InputPhaseName[] = ['adjudicating', 'submitting']

  it.each(BUSY)('does nothing while the composer is %s', async (phase) => {
    const harness = await open({ phase, projection: PLAN_ON })
    harness.press()
    await harness.flush()
    expect(harness.log).toEqual([])
  })
})

describe('claiming the plan command', () => {
  it('keeps the typed draft and claims the bare command', async () => {
    const harness = await open({ draft: 'wip text' })
    harness.press()
    await harness.flush()
    expect(harness.drafts).toEqual([])
    expect(harness.currentDraft()).toBe('wip text')
    expect(harness.beginCommands).toHaveLength(1)
    const [call] = harness.beginCommands
    expect(call?.claim).toMatchObject({
      name: 'plan',
      token: PLAN_TOKEN,
      hint: '[off|message]',
      attachments: true,
    })
    expect(call?.span).toEqual({ start: 0, end: 0, draftRev: 7 })
    expect(call?.result).toBe(true)
  })

  it('prefills the off spelling before claiming, then consumes the key', async () => {
    const harness = await open({ projection: PLAN_ON })
    const consumed = harness.press()
    await harness.flush()
    expect(harness.drafts).toEqual(['off'])
    expect(harness.log.indexOf('setDraft:off')).toBeLessThan(harness.log.indexOf('beginCommand'))
    expect(harness.log.indexOf('beginCommand')).toBeLessThan(harness.log.indexOf('consume'))
    expect(consumed).toBe(true)
    expect(harness.commands).toEqual([])
    expect(harness.notices).toEqual([])
  })

  it('restores the previous draft when the composer refuses the claim', async () => {
    const harness = await open({ draft: 'wip text', beginCommandResult: false, projection: PLAN_ON })
    const consumed = harness.press()
    await harness.flush()
    expect(harness.drafts).toEqual(['off', 'wip text'])
    expect(harness.currentDraft()).toBe('wip text')
    expect(consumed).toBe(false)
    expect(harness.commands).toEqual([])
    expect(harness.log).toEqual(['setDraft:off', 'beginCommand', 'setDraft:wip text'])
  })

  it('restores an empty draft when the composer refuses the claim', async () => {
    const harness = await open({ beginCommandResult: false, projection: PLAN_ON })
    harness.press()
    await harness.flush()
    expect(harness.drafts).toEqual(['off', ''])
    expect(harness.currentDraft()).toBe('')
    expect(harness.log).toEqual(['setDraft:off', 'beginCommand', 'setDraft:'])
  })
})

describe('claimed plan command', () => {
  it('drops the token and keeps the argument as the draft', async () => {
    const harness = await open({
      phase: 'claimed',
      claim: PLAN_CLAIM,
      draft: '/plan hello world',
      projection: PLAN_OFF,
    })
    const consumed = harness.press()
    await harness.flush()
    expect(consumed).toBe(true)
    expect(harness.currentDraft()).toBe('hello world')
    expect(harness.log.indexOf('consume')).toBeLessThan(draftWriteIndex(harness))
    expect(harness.commands).toEqual([])
    expect(harness.notices).toEqual([])
  })

  it('empties the draft when the claimed command has no arguments', async () => {
    const harness = await open({ phase: 'claimed', claim: PLAN_CLAIM, draft: PLAN_TOKEN, projection: PLAN_OFF })
    const consumed = harness.press()
    await harness.flush()
    expect(consumed).toBe(true)
    expect(harness.currentDraft()).toBe('')
    expect(harness.commands).toEqual([])
  })

  it('empties the draft when the claimed argument is the off spelling', async () => {
    const harness = await open({ phase: 'claimed', claim: PLAN_CLAIM, draft: '/plan off', projection: PLAN_ON })
    const consumed = harness.press()
    await harness.flush()
    expect(consumed).toBe(true)
    expect(harness.currentDraft()).toBe('')
    expect(harness.commands).toEqual([])
  })

  it('leaves a foreign command claim alone', async () => {
    const harness = await open({
      phase: 'claimed',
      claim: { name: 'goal', token: '/goal ' },
      draft: '/goal ship it',
      projection: PLAN_OFF,
    })
    const consumed = harness.press()
    await harness.flush()
    expect(consumed).toBe(false)
    expect(harness.log).toEqual([])
  })
})

describe('command submission', () => {
  it('submits the bare plan line when no argument is typed', async () => {
    const harness = await open()
    harness.press()
    await harness.flush()
    const outcome = await submitClaim(harness, '')
    expect(harness.commands).toEqual(['/plan'])
    expect(outcome.kind).toBe('success')
    expect(outcome.text).toBeUndefined()
    expect(harness.notices).toEqual([])
  })

  it('submits the typed argument with the plan line', async () => {
    const harness = await open()
    harness.press()
    await harness.flush()
    const outcome = await submitClaim(harness, 'hello world')
    expect(harness.commands).toEqual(['/plan hello world'])
    expect(outcome.kind).toBe('success')
    expect(harness.notices).toEqual([])
  })

  const FAILURES: readonly (readonly [string, () => Promise<unknown>, string | undefined])[] = [
    ['a business failure', () => Promise.resolve({ ok: false, error: new Error('plan refused') }), 'plan refused'],
    ['an unmatched command', () => Promise.resolve({ ok: true, value: { matched: false } }), undefined],
    ['an unclassified settlement', () => Promise.resolve({ ok: true, value: {} }), undefined],
    ['a thrown Error', () => Promise.reject(new Error('channel exploded')), 'channel exploded'],
    [
      'a thrown non-Error',
      async () => {
        throw 'string failure'
      },
      undefined,
    ],
  ]

  it.each(FAILURES)('reports %s as error text', async (_label, commandResult, fragment) => {
    const harness = await open({ commandResult })
    harness.press()
    await harness.flush()
    const outcome = await submitClaim(harness, '')
    expect(harness.commands).toEqual(['/plan'])
    expect(outcome.kind).toBe('error')
    expect(typeof outcome.text).toBe('string')
    expect(String(outcome.text).length).toBeGreaterThan(0)
    if (fragment !== undefined) expect(String(outcome.text)).toContain(fragment)
    expect(harness.notices).toEqual([])
  })
})

describe('host module', () => {
  it('exports the plugin name and an apply with no observable effect', () => {
    expect(host.name).toBe('plan-toggle')
    const bodyBefore = document.body.innerHTML
    expect(() => {
      host.apply()
    }).not.toThrow()
    expect(document.body.innerHTML).toBe(bodyBefore)
  })
})
