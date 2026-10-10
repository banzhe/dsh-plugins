/**
 * Plan-toggle plugin, browser half: `Shift+Tab` in the Composer claims
 * `/plan` the same way the slash menu does. Plan mode changes when that
 * command is sent, not when the key is pressed. An open trigger menu keeps
 * the shortcut.
 *
 * The gesture is a **fixed** shortcut row rather than a configurable command.
 * On Web the shortcut service rejects any chord whose only modifier is Shift
 * (`modifier-required`) and reserves the bare `Tab` code, so a `web:*` default
 * of Shift+Tab cannot be registered as an editable command: `register()`
 * would throw while mounting. `registerFixed()` validates physical codes only,
 * which admits Shift+Tab, and the row still reaches the user through the
 * shortcut reference. The cost is that Settings cannot rebind it.
 */

import type { Context } from '@deepseek-ai/cordis'
import type { ISessions, SessionFace, SessionListState } from '@deepseek-ai/dsh-api-session-controller/client'
import type { ShortcutCommandId, ShortcutFixedInput } from '@deepseek-ai/dsh-client-shortcuts/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
// Type-only: the `mainView` member of a row's `retainedBy` merge, read below.
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type {
  CommandClaim, IConversation, SessionInput, SubmitOutcome,
} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { en, NS, type PlanToggleKey, zh } from './locales.ts'

/** Wait on the current Session, the Composer input machine, the keymap, and locale. */
export const inject = ['sessions', 'conversation', 'shortcuts', 'locale']

/** Catalog command name this plugin claims; also the token's leading text. */
const PLAN_COMMAND = 'plan'

const PLAN_TOKEN = `/${PLAN_COMMAND} `

/** Row id in the shortcut reference, matching the `feature.action` grammar. */
const SHORTCUT_ID = 'plan.toggle' as ShortcutCommandId

/** Physical gesture: Shift held, Tab pressed, no other modifier. */
const SHIFT_TAB = { code: 'Tab', modifiers: ['shift'] } as const

/** Readable keycaps for the fixed row, mirroring how the service presents them. */
const SHIFT_TAB_KEYS = ['Shift', 'Tab'] as const

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    'plan-toggle': PlanToggleKey
  }
}

/** The keydown arm of the fixed-input union. */
type FixedKeydown = Extract<ShortcutFixedInput, { type: 'keydown' }>

/** True when `input` is the plain Shift+Tab this plugin owns. */
function isPlanToggleGesture(input: FixedKeydown): boolean {
  const { code, control, alt, meta, shift, repeat, composing, defaultPrevented } = input.gesture
  if (composing || defaultPrevented || repeat) return false
  return code === 'Tab' && shift && !control && !alt && !meta
}

/** Composer host under `target`, or null when the event is outside it. */
function composerFrom(target: EventTarget | null): HTMLElement | null {
  if (!(target instanceof Node)) return null
  const el = target instanceof Element ? target : target.parentElement
  if (el === null) return null
  const composer = el.closest('[data-composer-input]')
  return composer instanceof HTMLElement ? composer : null
}

/**
 * The Session the main view holds: the row whose `mainView` retention is
 * positive. This duplicates the resolution ui-session performs internally
 * (`publishMain`), which exposes no public accessor for it.
 */
function mainSessionId(list: SessionListState): SessionId | undefined {
  return Object.values(list.byId).find(session => (session.retainedBy.mainView ?? 0) > 0)?.id
}

/** True when the Composer's card currently hosts a trigger menu. */
function triggerMenuOpen(composer: HTMLElement): boolean {
  const card = composer.closest('[data-composer-card]')
  return card?.querySelector('[data-trigger-menu]') != null
}

/**
 * Plan target folded from the host `plan` projection, or undefined when
 * plan-mode is not composed (key absent / malformed).
 */
function planTargetOf(value: unknown): boolean | undefined {
  if (value === null || typeof value !== 'object') return undefined
  if (!('active' in value) || !('pending' in value)) return undefined
  const { active, pending } = value
  if (typeof active !== 'boolean' || typeof pending !== 'boolean') return undefined
  return pending ? !active : active
}

function argsAfter(draft: string): string {
  const text = draft.trimStart()
  return text.startsWith(PLAN_TOKEN) ? text.slice(PLAN_TOKEN.length) : ''
}

/** `/plan` claim whose submit runs through the Session command channel. */
function planClaim(session: SessionFace): CommandClaim {
  return {
    name: PLAN_COMMAND,
    token: PLAN_TOKEN,
    hint: '[off|message]',
    attachments: true,
    submit: async (args): Promise<SubmitOutcome> => {
      const line = args === '' ? `/${PLAN_COMMAND}` : `${PLAN_TOKEN}${args}`
      try {
        const result = await session.command(line)
        if (!result.ok) return { kind: 'error', text: result.error.message }
        if (!result.value.matched) return { kind: 'error', text: `unknown command: ${line}` }
        return { kind: 'success' }
      } catch (reason: unknown) {
        return { kind: 'error', text: reason instanceof Error ? reason.message : String(reason) }
      }
    },
  }
}

/** Insert `/plan ` at the draft start without replacing existing text. */
function beginPlan(input: SessionInput, session: SessionFace): boolean {
  const { draftRev } = input.state.getSnapshot()
  return input.beginCommand(planClaim(session), { start: 0, end: 0, draftRev })
}

export function apply(ctx: Context): void {
  const sessions = ctx.get('sessions') as ISessions
  const conversation = ctx.get('conversation') as IConversation

  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'plan-toggle: dictionaries')

  ctx.effect(() => ctx.shortcuts.registerFixed({
    id: SHORTCUT_ID,
    label: () => ctx.locale.bind(NS)('shortcut.toggle'),
    keys: SHIFT_TAB_KEYS,
    bindings: [SHIFT_TAB],
    group: 'input',
  }), 'plan-toggle: fixed shortcut row')

  ctx.effect(() => ctx.shortcuts.observeFixedInput((input) => {
    if (input.type !== 'keydown') return
    if (!isPlanToggleGesture(input)) return

    const composer = composerFrom(input.context.target)
    if (composer === null) return
    if (triggerMenuOpen(composer)) return

    const sessionId = mainSessionId(sessions.list.getSnapshot())
    if (sessionId === undefined) return
    const binding = sessions.binding(sessionId)
    const actx = sessions.scope(sessionId)
    if (binding === undefined || actx === undefined) return
    const target = planTargetOf(binding.session.projections.faceOf('plan').getSnapshot())
    if (target === undefined) return

    const sessionInput = conversation.input.for(actx)
    const state = sessionInput.state.getSnapshot()
    if (state.phase === 'adjudicating' || state.phase === 'submitting') return
    if (state.phase === 'claimed' && state.claim?.token === PLAN_TOKEN) {
      // The claim already owns this gesture: take Shift+Tab so it cannot move
      // focus, then keep or drop the claim.
      input.consume()
      const args = argsAfter(state.draft)
      sessionInput.setDraft(args.trim() === 'off' ? '' : args)
      return
    }
    if (state.phase !== 'plain') return

    // A refused claim must leave Tab's native focus move alone, so the
    // gesture is consumed only once the Composer accepted it.
    if (target) {
      sessionInput.setDraft('off')
      if (beginPlan(sessionInput, binding.session)) {
        input.consume()
        return
      }
      sessionInput.setDraft(state.draft)
      return
    }
    if (beginPlan(sessionInput, binding.session)) {
      input.consume()
      return
    }
    console.warn('plan toggle rejected: composer refused the /plan claim')
  }), 'plan-toggle: fixed input observer')
}
