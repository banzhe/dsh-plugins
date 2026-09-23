/**
 * Plan-toggle plugin, browser half: Shift+Tab in the Composer claims `/plan`
 * the same way the slash menu does. Plan mode changes when that command is
 * sent, not when the key is pressed. An open trigger menu keeps the shortcut.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { ISessions, SessionFace, SessionListState } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
// Type-only: the `mainView` member of a row's `retainedBy` merge, read below.
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type {
  CommandClaim, IConversation, SessionInput, SubmitOutcome,
} from '@deepseek-ai/dsh-client-ui-conversation/client'

/** Wait on the current Session and the Composer input machine. */
export const inject = ['sessions', 'conversation']

/** Catalog command name this plugin claims; also the token's leading text. */
const PLAN_COMMAND = 'plan'

const PLAN_TOKEN = `/${PLAN_COMMAND} `

/** True when this keydown is Shift+Tab with no other modifiers, first press only. */
function isPlanToggleKey(event: KeyboardEvent): boolean {
  if (event.repeat || event.isComposing) return false
  if (event.ctrlKey || event.altKey || event.metaKey) return false
  if (!event.shiftKey) return false
  return event.key === 'Tab'
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
 * @param list - sessions list snapshot.
 * @returns the displayed Session id, or undefined when none is open.
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

/** Strip the claimed `/plan ` token from the Composer draft. */
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

/**
 * Bind a document listener that claims `/plan` on Shift+Tab in the Composer.
 * @param ctx - client root context, with sessions and conversation already injected.
 */
export function apply(ctx: Context): void {
  const sessions = ctx.get('sessions') as ISessions
  const conversation = ctx.get('conversation') as IConversation

  ctx.effect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (!isPlanToggleKey(event)) return
      const composer = composerFrom(event.target)
      if (composer === null) return
      if (triggerMenuOpen(composer)) return
      // Capture + stopImmediate: steal Shift+Tab from Lexical's Tab keymap
      // and from native reverse focus traversal.
      event.preventDefault()
      event.stopImmediatePropagation()

      const sessionId = mainSessionId(sessions.list.getSnapshot())
      if (sessionId === undefined) return
      const binding = sessions.binding(sessionId)
      const actx = sessions.scope(sessionId)
      if (binding === undefined || actx === undefined) return
      const target = planTargetOf(binding.session.projections.faceOf('plan').getSnapshot())
      if (target === undefined) return

      const input = conversation.input.for(actx)
      const state = input.state.getSnapshot()
      if (state.phase === 'adjudicating' || state.phase === 'submitting') return
      if (state.phase === 'claimed' && state.claim?.token === PLAN_TOKEN) {
        const args = argsAfter(state.draft)
        input.setDraft(args.trim() === 'off' ? '' : args)
        return
      }
      if (state.phase !== 'plain') return

      if (target) {
        input.setDraft('off')
        if (!beginPlan(input, binding.session)) input.setDraft(state.draft)
        return
      }
      if (!beginPlan(input, binding.session)) {
        console.warn('plan toggle rejected: composer refused the /plan claim')
      }
    }

    document.addEventListener('keydown', onKeyDown, true)
    return () => {
      document.removeEventListener('keydown', onKeyDown, true)
    }
  }, 'plan-toggle: document listeners')
}
