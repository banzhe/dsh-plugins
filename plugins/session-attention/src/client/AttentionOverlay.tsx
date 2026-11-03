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
import { useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import {
  IconChecklistOutlineRegular, IconCloseOutlineRegular, IconPinOutlineRegular, StateDot,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { StateDotState } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { formatDuration, hasRunningActivity, runElapsed, type AttentionModel, type AttentionRow } from './attention.ts'
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
 * A Session listed only because it is pinned is in the running section but has
 * no work to report: the outline stays quiet for it, exactly like the badge.
 */
export function outlineFor(model: AttentionModel): AttentionOutline | undefined {
  if (model.waiting.length > 0) return 'waiting'
  if (hasRunningActivity(model)) return 'running'
  if (model.unread.length > 0) return 'unread'
  return undefined
}

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

function Duration({ row, now }: {
  readonly row: AttentionRow
  readonly now: number
}): ReactNode {
  const elapsed = runElapsed(row, now) ?? 0
  return (
    <span className="sa-row-duration" data-duration-ms={elapsed}>
      {formatDuration(elapsed)}
    </span>
  )
}

/**
 * The lead slot of one row: the pin mark on a row listed only because its
 * Session is pinned, the shipped state dot on a row with work to report, and
 * nothing on an idle container whose running descendants carry the activity.
 * The mark sits where the dot would, so a pinned row keeps the title indent of
 * the rows around it. It is decorative: the row's own label already says the
 * Session is pinned, and only the hover tooltip needs the text.
 */
function RowLead({ row, state, pinLabel }: {
  readonly row: AttentionRow
  readonly state: StateDotState
  readonly pinLabel: string
}): ReactNode {
  if (row.pinned === true) {
    return (
      <span className="sa-row-pin" title={pinLabel} aria-hidden>
        <IconPinOutlineRegular size={12} />
      </span>
    )
  }
  return row.container === true ? null : <StateDot state={state} size={10} />
}

/**
 * The indented block under one row: its mounted subagent descendants, each a
 * jump target of its own, nested one list per delegation hop. A container node
 * holds no turn of its own, so it draws no dot and no duration; the running
 * descendant below it carries both. The lead slot and the row label follow the
 * section's own rule, so a pinned row reads the same at any depth.
 */
function Children({ rows, state, now, open, rowLabel, pinLabel }: {
  readonly rows: readonly AttentionRow[]
  readonly state: StateDotState
  readonly now: number
  readonly open: (id: SessionId) => void
  readonly rowLabel: (title: string, pinned: boolean) => string
  readonly pinLabel: string
}): ReactNode {
  return (
    <ul className="sa-list sa-children">
      {rows.map(row => (
        <li key={row.id}>
          <button
            type="button"
            className="sa-row sa-child-row"
            data-container={row.container === true || undefined}
            aria-label={rowLabel(row.title, row.pinned === true)}
            onClick={() => { open(row.id) }}
          >
            <RowLead row={row} state={state} pinLabel={pinLabel} />
            <span className="sa-row-title">{row.title}</span>
            {row.turnedAt !== undefined && row.container !== true && (
              <Duration row={row} now={now} />
            )}
          </button>
          {row.children !== undefined && (
            <Children
              rows={row.children}
              state={state}
              now={now}
              open={open}
              rowLabel={rowLabel}
              pinLabel={pinLabel}
            />
          )}
        </li>
      ))}
    </ul>
  )
}

function Section({ title, rows, state, waiting, now, open, rowLabel, pinLabel }: {
  readonly title: string
  readonly rows: readonly AttentionRow[]
  /** The shipped indicator: the running spinner, or the finished-unread dot. */
  readonly state: StateDotState
  /** Ids whose turn is blocked on the user, and so wear the amber dot instead. */
  readonly waiting: ReadonlySet<string>
  /**
   * The shared clock sample the panel re-renders every second: one number so
   * every row's duration moves in the same update.
   */
  readonly now: number
  readonly open: (id: SessionId) => void
  readonly rowLabel: (title: string, pinned: boolean) => string
  /** The pin mark's hover text, on a row listed only because it is pinned. */
  readonly pinLabel: string
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
              data-container={row.container === true || undefined}
              aria-label={rowLabel(row.title, row.pinned === true)}
              onClick={() => { open(row.id) }}
            >
              {/* Blocked on the user: the amber `warning` dot, the color the
                  toggle's `waiting` ring is drawn in. Waiting for an answer is
                  not activity, so the spinner would be a lie — and in the unread
                  section the same rule outranks the green completion dot. A
                  container row holds no turn of its own: its children carry the
                  activity, so it draws no dot at all — and a row listed only for
                  its pin says so with the pin mark instead. */}
              <RowLead
                row={row}
                state={waiting.has(row.id) ? 'warning' : state}
                pinLabel={pinLabel}
              />
              <span className="sa-row-title">{row.title}</span>
              {/* Counted from the latest human prompt the list projection
                  carries; absent until that projection has been read. The
                  panel's own one-second tick re-renders the number. A container
                  row may still carry an old prompt time in the durable facts,
                  but its run is not its own work, so no cell. */}
              {row.lastPromptAt !== undefined && row.container !== true && (
                <Duration row={row} now={now} />
              )}
            </button>
            {/* The row's mounted subagent descendants, catalog order first,
                each a jump target of its own. A container row's descendants
                are the only activity the row reports; an idle one between the
                row and the running work nests that work one level deeper. A
                child's own duration counts from its open turn (`turnedAt`),
                not its parent's prompt. */}
            {row.children !== undefined && (
              <Children
                rows={row.children}
                state={state}
                now={now}
                open={open}
                rowLabel={rowLabel}
                pinLabel={pinLabel}
              />
            )}
          </li>
        ))}
      </ul>
    </section>
  )
}

export function AttentionOverlay({ useAttention, open, t }: AttentionOverlayProps): ReactNode {
  const model = useAttention()
  const [showing, setShowing] = useState(false)
  // The wall-clock sample the running rows' durations are formatted against.
  // It ticks only while the panel is open: the toggle's badge and outline are
  // content-driven, and nothing visible in the closed state moves with time.
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!showing) return
    setNow(Date.now())
    const timer = window.setInterval(() => { setNow(Date.now()) }, 1000)
    return () => { window.clearInterval(timer) }
  }, [showing])
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
  const jump = (id: SessionId): void => {
    open(id)
    setShowing(false)
  }
  // A pinned row is listed for the pin, not for work, so its own label says so:
  // it is the accessible name of the row, and the mark inside it is decorative.
  const label = (title: string, pinned: boolean): string =>
    pinned ? t('row.openPinned', { title }) : t('row.open', { title })
  const pinLabel = t('row.pinned')
  // Both derive from the model alone, so the open panel's one-second clock tick
  // repaints rows without recomputing them.
  const outline = useMemo(() => outlineFor(model), [model])
  const waiting = useMemo(() => new Set<SessionId>(model.waiting.map(row => row.id)), [model])
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
          {/* The empty state answers "is there a row to show", not "is
              anything counting": a pinned Session at rest renders in the running
              section while the badge still reads zero. */}
          {model.running.length === 0 && model.unread.length === 0
            ? <p className="sa-empty">{t('panel.empty')}</p>
            : (
                <div className="sa-body">
                  {model.running.length > 0 && (
                    <Section
                      title={t('section.running')}
                      rows={model.running}
                      state="ongoing"
                      waiting={waiting}
                      now={now}
                      open={jump}
                      rowLabel={label}
                      pinLabel={pinLabel}
                    />
                  )}
                  {model.unread.length > 0 && (
                    <Section
                      title={t('section.unread')}
                      rows={model.unread}
                      state="done"
                      waiting={waiting}
                      now={now}
                      open={jump}
                      rowLabel={label}
                      pinLabel={pinLabel}
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
