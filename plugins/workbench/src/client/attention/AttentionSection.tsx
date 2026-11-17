/**
 * The In work region at the top of the browsing list: two independent, collapsible
 * groups — running Sessions and unread or pinned-idle Sessions — folded from state
 * other plugins already own. Each group header carries its own count; the region
 * draws no header of its own and renders nothing while both groups are empty.
 *
 * The region renders no state of its own beyond the two fold choices: opening a row
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
import type { AttentionModel, AttentionRow } from './model.ts'
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

type Group = 'running' | 'unread'

/**
 * The dot one row draws, or none. A container row stands for work below it, so it
 * carries no state of its own; a turn blocked on the user outranks the group's own
 * state; a running row spins and an unread row is done.
 */
function dotStateOf(group: Group, row: AttentionRow, waiting: ReadonlySet<SessionId>): StateDotState | undefined {
  if (row.container === true) return undefined
  if (waiting.has(row.id)) return 'warning'
  return group === 'running' ? 'ongoing' : 'done'
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
function Rows({ rows, group, waiting, open, unpin, label, unpinLabel, useSessionAccess }: {
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
                <Rows
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
 * One independent fold: a group header with its visible count, and its rows when
 * expanded. The count is part of the button's visible text, so it also names the
 * count to a screen reader.
 */
function GroupCollapse({ title, count, children }: {
  readonly title: string
  readonly count: number
  readonly children: ReactNode
}): ReactNode {
  const [expanded, setExpanded] = useState(true)
  return (
    <section className={css.group}>
      <button
        type="button"
        className={css.groupHeader}
        aria-expanded={expanded}
        onClick={() => { setExpanded(current => !current) }}
      >
        <span className={css.chevron} aria-hidden="true">
          {expanded ? <IconChevronDownOutlineRegular size={12} /> : <IconChevronRightOutlineRegular size={12} />}
        </span>
        <span className={css.groupLabel}>{title}</span>
        {' '}
        <span className={css.groupCount}>{count}</span>
      </button>
      {expanded && <div className={css.groupBody}>{children}</div>}
    </section>
  )
}

/**
 * The In work region: the two group folds that have entries, and nothing at all
 * while both are empty.
 * @param props - the model hook, the access hook, the two Host actions, and the locale seat.
 * @returns the region's folds, or null when neither group lists a Session.
 */
export function AttentionSection({ useAttention, useSessionAccess, open, unpin, t }: AttentionSectionProps): ReactNode {
  const model = useAttention(current => current)
  const waiting = useMemo(() => new Set<SessionId>(model.waiting.map(row => row.id)), [model])
  // The label names the row's own action only; the release control beside it
  // carries the pin's own name.
  const label = (title: string, pinned: boolean): string =>
    pinned ? t('attention.row.openPinned', { title }) : t('attention.row.open', { title })
  if (model.running.length === 0 && model.unread.length === 0) return null
  return (
    <section className={css.section} data-attention-section="">
      {model.running.length > 0 && (
        <GroupCollapse title={t('attention.section.running')} count={model.running.length}>
          <Rows
            rows={model.running}
            group="running"
            waiting={waiting}
            open={open}
            unpin={unpin}
            label={label}
            unpinLabel={t('attention.row.unpin')}
            useSessionAccess={useSessionAccess}
          />
        </GroupCollapse>
      )}
      {model.unread.length > 0 && (
        <GroupCollapse title={t('attention.section.unread')} count={model.unread.length}>
          <Rows
            rows={model.unread}
            group="unread"
            waiting={waiting}
            open={open}
            unpin={unpin}
            label={label}
            unpinLabel={t('attention.row.unpin')}
            useSessionAccess={useSessionAccess}
          />
        </GroupCollapse>
      )}
    </section>
  )
}
