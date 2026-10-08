/**
 * The `shell.overlay` entry: one always-present toggle plus the panel it opens.
 *
 * Nothing is self-owned beyond the stylesheet the plugin injects: the entry is
 * the only React surface, the open/closed state lives in this component, and
 * the content is read from the plugin's attention store through the injected
 * `useAttention` hook (so a list or status push re-renders the panel without
 * the entry knowing either source).
 *
 * Placement: bottom-right. The overlay layer spans the whole frame, and on
 * Windows its top band is the draggable caption strip — a trigger there would
 * be unclickable. The wrapper itself stays click-through; only the trigger, the
 * panel, and their controls take pointer events.
 */
import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import {
  IconChecklistOutlineRegular, IconCloseOutlineRegular, StateDot,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { StateDotState } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { AttentionModel, AttentionRow } from './attention.ts'
import type { AttentionKey } from './locales.ts'

/**
 * The `shell.overlay` seat, restated for this package's own type check.
 *
 * ui-layout owns this key and declares it as `{ kind: 'list'; scope: 'root' }`.
 * ui-layout is NOT reachable from this standalone plugin — the workspace
 * catalog has no entry for it and the package is not installed — so the owner's
 * contract is restated here verbatim. Without it neither `PropsRuntime<
 * 'shell.overlay'>` below nor `ctx.slots.register({ name: 'shell.overlay', … })`
 * can resolve, because both are constrained to `keyof SlotMap`. If ui-layout is
 * ever added as a dependency, this declaration merges with the owner's.
 */
declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    'shell.overlay': { kind: 'list'; scope: 'root' }
  }

  interface LocaleNamespaceMap {
    'session-attention': AttentionKey
  }
}

/** DOM id tying the toggle to the panel it controls. */
export const PANEL_ID = 'session-attention-panel'

/**
 * What the toggle's outer outline reports. `waiting` wears the amber ring, the
 * same color the sidebar's warning dot uses for a Session blocked on the user —
 * and the same the blocked row's own dot wears in the panel; `running` wears the
 * DS blue sweep; `unread` the completion green. No attention at all means no
 * outline.
 */
export type AttentionOutline = 'waiting' | 'running' | 'unread'

/**
 * Which outline the current content earns, if any, in strict priority:
 *
 * 1. `waiting` — something is blocked on the user, and nothing else matters
 *    until they answer.
 * 2. `running` — work is in flight.
 * 3. `unread` — work finished and nobody has looked.
 *
 * An empty list earns nothing, so the resting toggle keeps its plain surface.
 */
export function outlineFor(model: AttentionModel): AttentionOutline | undefined {
  if (model.waiting.length > 0) return 'waiting'
  if (model.running.length > 0) return 'running'
  if (model.unread.length > 0) return 'unread'
  return undefined
}

/** Business face the plugin injects into the entry. */
export interface AttentionInjected {
  /** The current running/unread content. Bound to the plugin's store during render. */
  useAttention: () => AttentionModel
  /** Show one Session as the main view. */
  open: (id: SessionId) => void
}

export type AttentionOverlayProps =
  PropsRuntime<'shell.overlay'>
  & PropsLocale<'session-attention'>
  & InjectFace<AttentionInjected>

/** One section's rows, newest first, each a jump target. */
function Section({ title, rows, state, waiting, open, rowLabel }: {
  readonly title: string
  readonly rows: readonly AttentionRow[]
  /** The shipped indicator: the running spinner, or the finished-unread dot. */
  readonly state: StateDotState
  /** Ids whose turn is blocked on the user, and so wear the amber dot instead. */
  readonly waiting: ReadonlySet<string>
  readonly open: (id: SessionId) => void
  readonly rowLabel: (title: string) => string
}): ReactNode {
  return (
    <section className="sa-section">
      <h3 className="sa-section-title">{title}</h3>
      <ul className="sa-list">
        {rows.map(row => (
          <li key={row.id}>
            <button
              type="button"
              className="sa-row"
              aria-label={rowLabel(row.title)}
              onClick={() => { open(row.id) }}
            >
              {/* Blocked on the user: the amber `warning` dot, the color the
                  toggle's `waiting` ring is drawn in. Waiting for an answer is
                  not activity, so the spinner would be a lie — and in the unread
                  section the same rule outranks the green completion dot. */}
              <StateDot state={waiting.has(row.id) ? 'warning' : state} size={10} />
              <span className="sa-row-title">{row.title}</span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  )
}

/** Render the toggle, and the panel while it is open. */
export function AttentionOverlay({ useAttention, open, t }: AttentionOverlayProps): ReactNode {
  const model = useAttention()
  const [showing, setShowing] = useState(false)
  // Escape closes the panel, and only while it is open: the listener rides the
  // panel's own lifetime instead of the page's.
  useEffect(() => {
    if (!showing) return
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setShowing(false)
    }
    document.addEventListener('keydown', onKeyDown)
    return () => { document.removeEventListener('keydown', onKeyDown) }
  }, [showing])
  /** Jump to one Session and take the panel down behind it. */
  const jump = (id: SessionId): void => {
    open(id)
    setShowing(false)
  }
  const label = (title: string): string => t('row.open', { title })
  // The outline is derived, never stored: a source push that changes what is
  // running or unread re-renders the trigger with the matching attribute, and an
  // attribute React leaves off entirely when the list is empty.
  const outline = outlineFor(model)
  // The same derived set the outline reads, restated for row lookup: `waiting` is
  // already the subset of the listed rows that is blocked on the user.
  const waiting = new Set<string>(model.waiting.map(row => row.id))
  return (
    <div className="sa-root">
      {showing && (
        <div className="sa-panel" id={PANEL_ID} role="dialog" aria-label={t('panel.title')}>
          <div className="sa-head">
            <span className="sa-title">{t('panel.title')}</span>
            <button
              type="button"
              className="sa-close"
              aria-label={t('panel.close')}
              onClick={() => { setShowing(false) }}
            >
              <IconCloseOutlineRegular size={16} />
            </button>
          </div>
          {model.total === 0
            ? <p className="sa-empty">{t('panel.empty')}</p>
            : (
                <div className="sa-body">
                  {model.running.length > 0 && (
                    <Section
                      title={t('section.running')}
                      rows={model.running}
                      state="ongoing"
                      waiting={waiting}
                      open={jump}
                      rowLabel={label}
                    />
                  )}
                  {model.unread.length > 0 && (
                    <Section
                      title={t('section.unread')}
                      rows={model.unread}
                      state="done"
                      waiting={waiting}
                      open={jump}
                      rowLabel={label}
                    />
                  )}
                </div>
              )}
        </div>
      )}
      <button
        type="button"
        className="sa-trigger"
        data-attention={outline}
        aria-label={t('trigger.label')}
        aria-expanded={showing}
        aria-controls={PANEL_ID}
        onClick={() => { setShowing(current => !current) }}
      >
        <IconChecklistOutlineRegular size={16} />
        {/* Always rendered: a zero is the readout that the toggle is alive and
            the list is simply empty, which a vanishing badge cannot say. */}
        <span className="sa-badge">{model.total}</span>
      </button>
    </div>
  )
}
