/**
 * The `shell.overlay` entry: one always-present toggle plus the panel it opens.
 * The wrapper stays click-through; only the trigger, the panel and their
 * controls take pointer events. Placement is bottom-right: the overlay spans the
 * whole frame, and the top band of that frame is the draggable caption strip.
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
 * ui-layout owns this key but is not reachable from this standalone plugin, so
 * both contract maps are restated here; the declarations merge if it ever lands.
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
 * What the toggle's outer outline reports: `waiting` wears the amber ring of a
 * Session blocked on the user, `running` the DS blue sweep, `unread` the
 * completion green.
 */
export type AttentionOutline = 'waiting' | 'running' | 'unread'

/**
 * Strict priority: something blocked on the user outranks work in flight, which
 * outranks an unread finish. An empty list earns nothing.
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
  /** Release one Session's pin, which is the only reason its row is listed. */
  unpin: (id: SessionId) => void
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

/** The shipped state dot, absent on a container row whose descendants carry the activity. */
function RowLead({ row, state }: {
  readonly row: AttentionRow
  readonly state: StateDotState
}): ReactNode {
  return row.container === true ? null : <StateDot state={state} size={10} />
}

type PinSlot = 'lead' | 'trail'

/**
 * Which end of a pinned row has room for its release control: an idle container
 * row has an empty lead slot (where every other row wears its dot), while a row
 * already carrying a dot wears the pin at its trailing edge instead.
 */
function pinSlotOf(row: AttentionRow): PinSlot | undefined {
  if (row.pinned !== true) return undefined
  return row.container === true ? 'lead' : 'trail'
}

/**
 * The control that releases one Session's pin, in the slot {@link pinSlotOf}
 * reserved.
 *
 * A SIBLING of the row's own button, never a child: a button inside a button is
 * invalid HTML and the browser splits the outer element while parsing, so the
 * row's label would lose its single hit target. As a sibling it also cannot
 * bubble a click into the row's open handler.
 */
function UnpinButton({ row, slot, unpin, label }: {
  readonly row: AttentionRow
  readonly slot: PinSlot | undefined
  readonly unpin: (id: SessionId) => void
  readonly label: string
}): ReactNode {
  if (slot === undefined) return null
  return (
    <button
      type="button"
      className="sa-unpin"
      data-slot={slot}
      title={label}
      aria-label={label}
      onClick={() => { unpin(row.id) }}
    >
      <IconPinOutlineRegular size={12} />
    </button>
  )
}

/**
 * The indented block under one row: its mounted subagent descendants, one list
 * per delegation hop, following the section's own lead-slot and label rules so a
 * row reads the same at any depth. A child's duration counts from its open turn
 * (`turnedAt`), not its parent's prompt.
 */
function Children({ rows, state, now, open, rowLabel }: {
  readonly rows: readonly AttentionRow[]
  readonly state: StateDotState
  readonly now: number
  readonly open: (id: SessionId) => void
  readonly rowLabel: (title: string, pinned: boolean) => string
}): ReactNode {
  return (
    <ul className="sa-list sa-children">
      {rows.map(row => (
        <li key={row.id} className="sa-item">
          <button
            type="button"
            className="sa-row sa-child-row"
            data-container={row.container === true || undefined}
            aria-label={rowLabel(row.title, row.pinned === true)}
            onClick={() => { open(row.id) }}
          >
            <RowLead row={row} state={state} />
            <span className="sa-row-title">{row.title}</span>
            {row.container !== true && runElapsed(row, now) !== undefined && (
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
            />
          )}
        </li>
      ))}
    </ul>
  )
}

function Section({ title, rows, state, waiting, now, open, unpin, rowLabel, unpinLabel }: {
  readonly title: string
  readonly rows: readonly AttentionRow[]
  /** The shipped indicator: the running spinner, or the finished-unread dot. */
  readonly state: StateDotState
  /** Ids whose turn is blocked on the user, and so wear the amber dot instead. */
  readonly waiting: ReadonlySet<SessionId>
  /** The shared clock sample the panel re-renders every second. */
  readonly now: number
  readonly open: (id: SessionId) => void
  /** Release one Session's pin, which is the only reason its row is listed. */
  readonly unpin: (id: SessionId) => void
  readonly rowLabel: (title: string, pinned: boolean) => string
  /** The release control's accessible name and hover text. */
  readonly unpinLabel: string
}): ReactNode {
  return (
    <section className="sa-section">
      <h3 className="sa-section-title">{title}</h3>
      <ul className="sa-list">
        {rows.map((row) => {
          const pin = pinSlotOf(row)
          return (
            <li key={row.id} className="sa-item">
              {/* One positioned wrapper, so the release control centers on the row
                  itself rather than on the descendants mounted below it. */}
              <div className="sa-row-wrap">
                <UnpinButton row={row} slot={pin} unpin={unpin} label={unpinLabel} />
                <button
                  type="button"
                  className="sa-row"
                  data-container={row.container === true || undefined}
                  data-pin={pin}
                  aria-label={rowLabel(row.title, row.pinned === true)}
                  onClick={() => { open(row.id) }}
                >
                  {/* A turn blocked on the user is not activity, so the amber
                      `warning` dot outranks both the spinner and the green one. */}
                  <RowLead
                    row={row}
                    state={waiting.has(row.id) ? 'warning' : state}
                  />
                  <span className="sa-row-title">{row.title}</span>
                  {row.container !== true && runElapsed(row, now) !== undefined && (
                    <Duration row={row} now={now} />
                  )}
                </button>
              </div>
              {row.children !== undefined && (
                <Children
                  rows={row.children}
                  state={state}
                  now={now}
                  open={open}
                  rowLabel={rowLabel}
                />
              )}
            </li>
          )
        })}
      </ul>
    </section>
  )
}

export function AttentionOverlay({ useAttention, open, unpin, t }: AttentionOverlayProps): ReactNode {
  const model = useAttention()
  const [showing, setShowing] = useState(false)
  // The clock ticks only while the panel is open: nothing visible in the closed
  // state moves with time.
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!showing) return
    setNow(Date.now())
    const timer = window.setInterval(() => { setNow(Date.now()) }, 1000)
    return () => { window.clearInterval(timer) }
  }, [showing])
  // Escape closes the panel, and the listener rides the panel's own lifetime.
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
  // The label names the row's own action only; the release control beside it
  // carries the pin's own name.
  const label = (title: string, pinned: boolean): string =>
    pinned ? t('row.openPinned', { title }) : t('row.open', { title })
  const unpinLabel = t('row.unpin')
  // Both derive from the model alone, so the one-second tick repaints rows
  // without recomputing them.
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
          {/* The empty state answers "is there a row to show", not "is anything
              counting": a pinned Session at rest renders while the badge reads zero. */}
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
                      unpin={unpin}
                      rowLabel={label}
                      unpinLabel={unpinLabel}
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
                      unpin={unpin}
                      rowLabel={label}
                      unpinLabel={unpinLabel}
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
        {/* Always rendered: a zero is the readout that the toggle is alive and the
            list is simply empty, which a vanishing badge cannot say. */}
        <span className="sa-badge">{model.total}</span>
      </button>
    </div>
  )
}