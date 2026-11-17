/**
 * The attention region at the top of the browsing list: pinned Sessions, running
 * work, and finishes the user has not looked at yet, folded from state other
 * plugins already own. Collapsible; the header keeps the activity count visible
 * while the groups are folded away.
 *
 * The region renders no state of its own beyond that fold choice: opening a row
 * goes through the Workspace owner's guarded open (the same call the tree rows
 * make), which selects the Session as the main view and lets ui-session clear its
 * unread flag; releasing a pin is the same Host call the sidebar's row action
 * issues, behind the same access gate.
 */
import { type ReactNode, useMemo, useState } from 'react'
import {
  IconChevronDownOutlineRegular, IconChevronRightOutlineRegular, IconPinOutlineRegular, StateDot,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { StateDotState } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, SnapshotSelectorHook } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { WorkspaceBrowserProps } from '../contract/slots.ts'
import { attentionSections, type AttentionModel, type AttentionRow } from './model.ts'
import css from './AttentionSection.module.css'

/** Props the browsing region hands down; every member is already bound to its source. */
export interface AttentionSectionProps {
  /** The current model, bound to the plugin's store during render. */
  readonly useAttention: SnapshotSelectorHook<AttentionModel>
  /** The row actions' access hook: the pin toggle is offered only where it is allowed. */
  readonly useSessionAccess: WorkspaceBrowserProps['useSessionAccess']
  /** Show one Session as the main view (also clears its unread flag in ui-session). */
  readonly open: (id: SessionId) => void
  /** Release one Session's pin, which is the only reason its row is listed. */
  readonly unpin: (id: SessionId) => void
  readonly t: PropsLocale<'workspace'>['t']
}

type Group = 'pinned' | 'running' | 'unread'

/**
 * The dot one row draws, or none. A container row stands for work below it, so it
 * carries no state of its own; a turn blocked on the user outranks both the
 * spinner and the done dot.
 */
function dotStateOf(group: Group, row: AttentionRow, waiting: ReadonlySet<SessionId>): StateDotState | undefined {
  if (row.container === true) return undefined
  if (waiting.has(row.id)) return 'warning'
  if (group === 'running') return 'ongoing'
  // A pinned row is listed because the user pinned it, not because it reports
  // anything: nothing happened, so nothing is marked.
  return group === 'unread' ? 'done' : undefined
}

/**
 * The release control for one pinned row, rendered only where the Session's
 * access snapshot allows the toggle — the same gate the row's pin button uses, so
 * a refused Session never shows a button that can only fail.
 * @param props - the Session, the Host action, the label, and the access Hook.
 * @returns the button, or null when the toggle is not allowed here.
 */
function UnpinControl({ sessionId, unpin, label, useSessionAccess }: {
  readonly sessionId: SessionId
  readonly unpin: (id: SessionId) => void
  readonly label: string
  readonly useSessionAccess: WorkspaceBrowserProps['useSessionAccess']
}): ReactNode {
  const allowed = useSessionAccess(sessionId, 'workspace/unpinSession')
  if (!allowed) return null
  return (
    <button
      type="button"
      className={css.unpin}
      title={label}
      aria-label={label}
      onClick={() => { unpin(sessionId) }}
    >
      <IconPinOutlineRegular size={12} />
    </button>
  )
}

/**
 * Rows of one group, nested one level per delegation hop.
 * @param props - the rows, the group they belong to, and the callbacks they need.
 * @returns the group's list.
 */
function GroupRows({ rows, group, waiting, open, unpin, label, unpinLabel, useSessionAccess }: {
  readonly rows: readonly AttentionRow[]
  readonly group: Group
  readonly waiting: ReadonlySet<SessionId>
  readonly open: (id: SessionId) => void
  readonly unpin: (id: SessionId) => void
  readonly label: (title: string, pinned: boolean) => string
  readonly unpinLabel: string
  readonly useSessionAccess: WorkspaceBrowserProps['useSessionAccess']
}): ReactNode {
  return (
    <ul className={css.list}>
      {rows.map(row => {
        const dot = dotStateOf(group, row, waiting)
        return (
          <li key={row.id} className={css.item}>
            <div className={css.rowWrap}>
              <button
                type="button"
                className={css.row}
                aria-label={label(row.title, row.pinned === true)}
                onClick={() => { open(row.id) }}
              >
                {dot !== undefined && (
                  <span className={css.dot}>
                    <StateDot state={dot} size={10} />
                  </span>
                )}
                <span className={css.title}>{row.title}</span>
              </button>
              {row.pinned === true && (
                <UnpinControl
                  sessionId={row.id}
                  unpin={unpin}
                  label={unpinLabel}
                  useSessionAccess={useSessionAccess}
                />
              )}
            </div>
            {row.children !== undefined && (
              <div className={css.children}>
                <GroupRows
                  rows={row.children}
                  group={group}
                  waiting={waiting}
                  open={open}
                  unpin={unpin}
                  label={label}
                  unpinLabel={unpinLabel}
                  useSessionAccess={useSessionAccess}
                />
              </div>
            )}
          </li>
        )
      })}
    </ul>
  )
}

/**
 * The attention region.
 * @param props - the model hook, the access hook, the two Host actions, and the locale seat.
 * @returns the collapsible region, or its empty state.
 */
export function AttentionSection({ useAttention, useSessionAccess, open, unpin, t }: AttentionSectionProps): ReactNode {
  const model = useAttention(current => current)
  const [expanded, setExpanded] = useState(true)
  const groups = useMemo(() => attentionSections(model), [model])
  const waiting = useMemo(() => new Set<SessionId>(model.waiting.map(row => row.id)), [model])
  // The label names the row's own action only; the release control beside it
  // carries the pin's own name.
  const label = (title: string, pinned: boolean): string =>
    pinned ? t('attention.row.openPinned', { title }) : t('attention.row.open', { title })
  const entries: readonly { readonly group: Group; readonly title: string; readonly rows: readonly AttentionRow[] }[] = [
    { group: 'pinned', title: t('attention.section.pinned'), rows: groups.pinned },
    { group: 'running', title: t('attention.section.running'), rows: groups.running },
    { group: 'unread', title: t('attention.section.unread'), rows: groups.unread },
  ]
  const empty = model.running.length === 0 && model.unread.length === 0
  return (
    <section className={css.section} data-attention-section="">
      {/* The title and the count are the control's visible text, so they are also
          its accessible name; the fold state rides aria-expanded, not the name. */}
      <button
        type="button"
        className={css.header}
        aria-expanded={expanded}
        onClick={() => { setExpanded(current => !current) }}
      >
        <span className={css.chevron} aria-hidden="true">
          {expanded ? <IconChevronDownOutlineRegular size={12} /> : <IconChevronRightOutlineRegular size={12} />}
        </span>
        <span className={css.label}>{t('attention.title')}</span>
        {' '}
        {/* Always rendered: a zero is the readout that the region is alive and the
            list is simply empty, which a vanishing badge cannot say. */}
        <span className={css.badge}>{model.total}</span>
      </button>
      {expanded && (empty
        ? <p className={css.empty}>{t('attention.empty')}</p>
        : (
            <div className={css.groups}>
              {entries.filter(entry => entry.rows.length > 0).map(entry => (
                <section key={entry.group}>
                  {/* The count is decoration beside the group's name: a screen
                      reader announces the group, and the same number is already
                      in the header's total. */}
                  <h3 className={css.groupTitle}>
                    {entry.title}
                    {' '}
                    <span className={css.groupCount} aria-hidden="true">{entry.rows.length}</span>
                  </h3>
                  <GroupRows
                    rows={entry.rows}
                    group={entry.group}
                    waiting={waiting}
                    open={open}
                    unpin={unpin}
                    label={label}
                    unpinLabel={t('attention.row.unpin')}
                    useSessionAccess={useSessionAccess}
                  />
                </section>
              ))}
            </div>
          ))}
    </section>
  )
}
