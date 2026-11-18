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
 *
 * Headers and rows are the browsing list's own boxes: their classes come from
 * rows/Rows.module.css, so a Session here measures, paints and aligns exactly like
 * the same Session in the list below — including the leading 16x20 cell, the
 * trailing resting cell that carries the pinned mark, and the hover action strip
 * that holds the release control.
 */
import clsx from 'clsx'
import { type ReactNode, useMemo, useState } from 'react'
import {
  IconChevronDownOutlineRegular, IconChevronRightOutlineRegular, IconPinFillRegular, StateDot, Tooltip,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { StateDotState } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, SnapshotSelectorHook } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { WorkspaceBrowserProps } from '../contract/slots.ts'
import type { AttentionModel, AttentionRow } from './model.ts'
import rowStyles from '../rows/Rows.module.css'
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
 * The dot one row draws, or none. A pinned Session at rest has no live work to
 * show; a turn blocked on the user outranks the group's own state; a running row
 * spins and an unread row is done.
 */
function dotStateOf(group: Group, row: AttentionRow, waiting: ReadonlySet<SessionId>): StateDotState | undefined {
  if (row.container === true) return undefined
  if (waiting.has(row.id)) return 'warning'
  return group === 'running' ? 'ongoing' : 'done'
}

/**
 * One row in a fold: the list's own row box, its click target, the resting mark a
 * pinned Session carries at rest, and the hover action strip that releases the
 * pin. The access gate is asked once per row — the same gate the list row's pin
 * button uses — so a refused Session keeps its resting mark and never renders an
 * empty action strip.
 * @param props - the Session, its group, the callbacks it needs, and the gate.
 * @returns the row item.
 */
function AttentionRowItem({ row, group, waiting, open, unpin, label, unpinLabel, unpinTitle, useSessionAccess }: {
  readonly row: AttentionRow
  readonly group: Group
  readonly waiting: ReadonlySet<SessionId>
  readonly open: (id: SessionId) => void
  readonly unpin: (id: SessionId) => void
  readonly label: (title: string, pinned: boolean) => string
  readonly unpinLabel: string
  readonly unpinTitle: string
  readonly useSessionAccess: WorkspaceBrowserProps['useSessionAccess']
}): ReactNode {
  const canUnpin = useSessionAccess(row.id, 'workspace/unpinSession')
  const pinned = row.pinned === true
  const dot = dotStateOf(group, row, waiting)
  return (
    <li>
      <div className={rowStyles.sessionRow}>
        <button
          type="button"
          className={css.rowButton}
          aria-label={label(row.title, pinned)}
          onClick={() => { open(row.id) }}
        >
          {/* The list keeps its leading cell even without a dot, so a quiet pinned
              row starts on the same edge as every other title. */}
          <span className={rowStyles.slot}>
            {dot !== undefined && <StateDot state={dot} size={7} />}
          </span>
          <span className={rowStyles.title}>{row.title}</span>
        </button>
        {pinned && (
          // Resting state carries the mark the list gives a pinned row; hover swaps
          // the cell for the action strip, exactly as in the list.
          <span className={rowStyles.rowResting}>
            <span className={rowStyles.pinIndicator} aria-hidden="true">
              <IconPinFillRegular size={14} />
            </span>
          </span>
        )}
        {pinned && canUnpin && (
          <span className={rowStyles.rowActions}>
            <Tooltip label={unpinTitle} side="bottom" align="end" delayMs={500} portal>
              <button
                type="button"
                className={clsx(rowStyles.iconButton, rowStyles.pinnedAction)}
                aria-label={unpinLabel}
                onClick={() => { unpin(row.id) }}
              >
                <IconPinFillRegular size={14} />
              </button>
            </Tooltip>
          </span>
        )}
      </div>
    </li>
  )
}

/**
 * One group's rows, each a Session the fold listed.
 * @param props - the rows, the group they belong to, and the callbacks they need.
 * @returns the group's list.
 */
function Rows({ rows, group, waiting, open, unpin, label, unpinLabel, unpinTitle, useSessionAccess }: {
  readonly rows: readonly AttentionRow[]
  readonly group: Group
  readonly waiting: ReadonlySet<SessionId>
  readonly open: (id: SessionId) => void
  readonly unpin: (id: SessionId) => void
  readonly label: (title: string, pinned: boolean) => string
  readonly unpinLabel: string
  readonly unpinTitle: string
  readonly useSessionAccess: WorkspaceBrowserProps['useSessionAccess']
}): ReactNode {
  return (
    <ul className={css.list}>
      {rows.map(row => (
        <AttentionRowItem
          key={row.id}
          row={row}
          group={group}
          waiting={waiting}
          open={open}
          unpin={unpin}
          label={label}
          unpinLabel={unpinLabel}
          unpinTitle={unpinTitle}
          useSessionAccess={useSessionAccess}
        />
      ))}
    </ul>
  )
}

/**
 * One independent fold: a group header with its visible count, and its rows when
 * expanded. The count is part of the button's visible text, so it also names the
 * count to a screen reader. The header is the list's own row box with the fold
 * glyph in its leading cell, so header labels and row titles share an edge.
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
        className={clsx(rowStyles.sessionRow, css.groupHeader)}
        aria-expanded={expanded}
        onClick={() => { setExpanded(current => !current) }}
      >
        <span className={clsx(rowStyles.slot, rowStyles.chevron)} aria-hidden="true">
          {expanded ? <IconChevronDownOutlineRegular size={12} /> : <IconChevronRightOutlineRegular size={12} />}
        </span>
        <span className={rowStyles.title}>{title}</span>
        {' '}
        <span className={rowStyles.time}>{count}</span>
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
            unpinTitle={t('actions.unpin')}
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
            unpinTitle={t('actions.unpin')}
            useSessionAccess={useSessionAccess}
          />
        </GroupCollapse>
      )}
    </section>
  )
}
