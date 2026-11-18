/**
 * The browsing region's four folds: the three quick groups the In work model lists
 * — unread, pinned, running — and the workspace tree itself. Each fold is an
 * independent, labelled section with its own header button and fold state; the
 * region draws no title or total above them.
 *
 * The three quick groups render the browsing list's own Session rows
 * (rows/Rows.tsx), not a private row shape: focus, hover, the row menu trigger,
 * the hover card, the pin mark, the relative time and the row's action strip are
 * the same code the tree below runs. The menu and the hover actions are the shared
 * `contextMenu.button` factory and the `sidebar.workspaces.session.row.action`
 * list, so pin/unpin, archive, rename and fork behave here exactly as they do in
 * the tree — this region copies no menu, no Host write, no access gate and no copy.
 *
 * A Session can list here and in the tree at once, so each quick-group row takes
 * its own row key (`quick:<group>:<id>`) and the two occurrences stay distinct in
 * the DOM. Everything else follows the Session, not the occurrence: opening,
 * renaming and every row action are addressed by Session id, so either occurrence
 * raises the same navigation, the same dialog and the same Host call, and the
 * shared context-menu target reports the menu open on both — the same fact either
 * way. Row dragging is the one behaviour the quick groups leave out: reordering
 * belongs to the tree, which owns the account order.
 *
 * Opening a row goes through the Workspace owner's guarded open (the same call the
 * tree rows make), which selects the Session as the main view and lets ui-session
 * clear its unread flag. The region persists nothing and writes nothing.
 */
import clsx from 'clsx'
import { type ReactNode, useMemo, useState } from 'react'
import { HoverCardGroup, IconTriangleRightFillRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, SnapshotSelectorHook } from '@deepseek-ai/dsh-client-ui-slots'
import type { WorkspaceView } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { WorkspaceBrowserProps } from '../contract/slots.ts'
import type { WorkspaceKey } from '../locales.ts'
import type { AttentionModel, AttentionRow } from './model.ts'
import { sessionWorkspaceLabel, workspaceLabelsBySession, type WorkspaceLabelsBySession } from '../tree.ts'
import { SessionNodeItem } from '../rows/Rows.tsx'
import rowStyles from '../rows/Rows.module.css'
import css from './AttentionSection.module.css'

/** Props the browsing region hands down; every member is already bound to its source. */
export interface AttentionSectionProps {
  /** The current model, bound to the plugin's store during render. */
  readonly useAttention: SnapshotSelectorHook<AttentionModel>
  /** The row actions' access hook: every row gate is asked where the tree asks it. */
  readonly useSessionAccess: WorkspaceBrowserProps['useSessionAccess']
  /** Show one Session as the main view (also clears its unread flag in ui-session). */
  readonly open: (id: SessionId) => void
  /** Open the rename dialog from a row title double-click, as in the tree. */
  readonly onSessionRenameRequest: (sessionId: SessionId, currentTitle: string) => void
  /** The Session the main view shows, so a listed row highlights like its tree row. */
  readonly currentId?: SessionId | undefined
  /** Host account home for POSIX hover-path abbreviation. */
  readonly home?: string | undefined
  /**
   * Localized title of the fourth fold, which holds the browsing list itself:
   * "All workspaces", or "All sessions" in the one-list view. It names that fold,
   * not the region, so it never repeats the toolbar's own section label above.
   */
  readonly workspacesTitle: string
  readonly renderSlot: WorkspaceBrowserProps['renderSlot']
  readonly renderFactorySlot: WorkspaceBrowserProps['renderFactorySlot']
  readonly useContextMenuTarget: WorkspaceBrowserProps['useContextMenuTarget']
  readonly useContextMenu: WorkspaceBrowserProps['useContextMenu']
  readonly t: PropsLocale<'workspace'>['t']
  /** Workspaces in Host group order: the quick-group rows name their owning Workspace. */
  readonly workspaces: readonly WorkspaceView[]
  /** The browsing body under the list's fold: the grouped tree or the flat list. */
  readonly children?: ReactNode
}

type QuickGroup = 'unread' | 'pinned' | 'running'
type FoldKey = QuickGroup | 'workspaces'

/** The three quick groups, in display order, each with the dictionary key naming it. */
const QUICK_GROUPS: readonly { readonly fold: QuickGroup; readonly labelKey: WorkspaceKey }[] = [
  { fold: 'unread', labelKey: 'attention.section.unread' },
  { fold: 'pinned', labelKey: 'attention.section.pinned' },
  { fold: 'running', labelKey: 'attention.section.running' },
]

/**
 * The quick groups whose fold renders even while they hold nothing: the two the
 * user scans for activity always say how much of it there is, so "Running 0" is a
 * fact rather than a missing group. The pin group holds only what the user filed
 * there, so it stays hidden until something is.
 */
const ALWAYS_SHOWN_QUICK_GROUPS: ReadonlySet<QuickGroup> = new Set(['unread', 'running'])

/**
 * One fold: a header button that owns the fold state, and its body. The header is
 * the session rows' own 32px box with the tree's filled triangle in the leading
 * cell, so a fold label starts on the same edge as the titles under it. The
 * header's text names the fold and, for a quick group, its count; the button's
 * `aria-expanded`/`aria-controls` pair is what makes the fold reachable and
 * operable from the keyboard and from a screen reader.
 *
 * A quick group's rows are cheap and stateless, so its body leaves the tree on
 * collapse. The browsing list's fold is the opposite: the list holds its own
 * view state — the "Show more" watermarks, group expansion, and the scroll
 * position of a revealed Session — so its body stays mounted and is hidden
 * instead, keeping that state and keeping `aria-controls` pointing at a real
 * element whether the fold is open or closed.
 * @param props.fold - the fold's stable key, also its id stem.
 * @param props.title - localized fold name.
 * @param props.count - entries in the fold, for a quick group; the list reports its own.
 * @param props.keepMounted - keep the body mounted while folded, hiding it instead.
 * @param props.children - the fold's body content.
 * @returns the fold section.
 */
function Fold({ fold, title, count, keepMounted = false, children }: {
  readonly fold: FoldKey
  readonly title: string
  readonly count?: number | undefined
  readonly keepMounted?: boolean | undefined
  readonly children: ReactNode
}): ReactNode {
  const [expanded, setExpanded] = useState(true)
  const headerId = `workspace-fold-${fold}-header`
  const bodyId = `workspace-fold-${fold}-body`
  // A folded body that leaves the tree cannot be named as the header's control;
  // a folded body that stays mounted is merely hidden, and stays nameable.
  const mounted = keepMounted || expanded
  const controls = mounted ? bodyId : undefined
  return (
    <section className={css.group} data-browser-fold={fold} aria-labelledby={headerId}>
      <button
        id={headerId}
        type="button"
        className={clsx(rowStyles.sessionRow, css.groupHeader)}
        aria-expanded={expanded}
        aria-controls={controls}
        onClick={() => { setExpanded(current => !current) }}
      >
        <span className={clsx(rowStyles.slot, rowStyles.chevron)} aria-hidden="true">
          <IconTriangleRightFillRegular size={14} className={clsx(rowStyles.arrow, expanded && rowStyles.arrowOpen)} />
        </span>
        <span className={rowStyles.title}>{title}</span>
        {count !== undefined && <>{' '}<span className={rowStyles.time}>{count}</span></>}
      </button>
      {mounted && (
        <div id={bodyId} className={css.groupBody} data-browser-fold-body="" hidden={!expanded}>
          {children}
        </div>
      )}
    </section>
  )
}

/**
 * The quick-group row's second line: the Workspace label a row passes on, or
 * nothing when the Session resolves to no name at all.
 * @param label - the Session's Workspace label.
 * @returns that label, or nothing for an empty one.
 */
function workspaceLine(label: string): string | undefined {
  return label === '' ? undefined : label
}

/** The row seats every quick-group row shares with the tree. */
type RowSeats = Pick<
  AttentionSectionProps,
  | 'currentId' | 'home' | 'open' | 'onSessionRenameRequest' | 'useSessionAccess'
  | 'renderSlot' | 'renderFactorySlot' | 'useContextMenuTarget' | 'useContextMenu' | 't'
> & { readonly now: number }

/**
 * One quick group's rows: the browsing list's own session rows, each carrying the
 * group's row key so it never collides with the same Session's tree row. The rows
 * sit in the shell's own hover-card group, so the group shares the tree's dwell
 * and one-card-at-a-time coordination instead of reimplementing it; the list
 * itself keeps the tree's role and label. Each row carries a second line naming
 * the Session's Workspace — the same title the tree's group headers and the search
 * rows show — because the quick groups mix every Workspace in one list.
 * @param props.rows - the group's Sessions, in the model's order.
 * @param props.fold - the group, which scopes the row keys.
 * @param props.title - the group's localized name, used as the tree label.
 * @param props.workspaceLabels - Workspace titles by Session, the rows' second line.
 * @param props.seats - the row seats plus the render clock.
 * @returns the group's rows, in a hover-card group of their own.
 */
function GroupRows({ rows, fold, title, workspaceLabels, seats }: {
  readonly rows: readonly AttentionRow[]
  readonly fold: QuickGroup
  readonly title: string
  readonly workspaceLabels: WorkspaceLabelsBySession
  readonly seats: RowSeats
}): ReactNode {
  return (
    <HoverCardGroup>
      <div className={css.list} role="tree" aria-label={title}>
        {rows.map(row => (
          <SessionNodeItem
            key={row.id}
            rowKey={`quick:${fold}:${row.id}`}
            node={row}
            currentId={seats.currentId}
            now={seats.now}
            onOpen={seats.open}
            onRenameRequest={seats.onSessionRenameRequest}
            renderSlot={seats.renderSlot}
            renderFactorySlot={seats.renderFactorySlot}
            useContextMenu={seats.useContextMenu}
            useContextMenuTarget={seats.useContextMenuTarget}
            home={seats.home}
            useSessionAccess={seats.useSessionAccess}
            secondaryLabel={workspaceLine(sessionWorkspaceLabel(workspaceLabels, row.id, row.cwd))}
            t={seats.t}
          />
        ))}
      </div>
    </HoverCardGroup>
  )
}

/**
 * The four folds: the quick groups, then the browsing list's own fold, which always
 * renders, always starts open, and keeps its content mounted while folded. An empty
 * running or unread group still renders its header; an empty pin group does not.
 * @param props - the model hook, the row seats, the fourth fold's title, and the browsing body.
 * @returns the region's folds.
 */
export function AttentionSection({
  useAttention, useSessionAccess, open, onSessionRenameRequest, currentId, home, workspacesTitle, workspaces,
  renderSlot, renderFactorySlot, useContextMenuTarget, useContextMenu, t, children,
}: AttentionSectionProps): ReactNode {
  const model = useAttention(current => current)
  // Workspace titles are a rename-stable fact of the Workspace list, so the index
  // is rebuilt only when that list changes.
  const labels = useMemo(() => workspaceLabelsBySession(workspaces), [workspaces])
  // One clock per render, as the tree does: every row in the region reads the
  // same "now" so two occurrences of a Session label the same time.
  const now = Date.now()
  const seats: RowSeats = {
    currentId,
    home,
    open,
    onSessionRenameRequest,
    useSessionAccess,
    renderSlot,
    renderFactorySlot,
    useContextMenuTarget,
    useContextMenu,
    t,
    now,
  }
  return (
    <div className={css.section} data-browser-folds="">
      {QUICK_GROUPS.map(({ fold, labelKey }) => {
        const rows = model[fold]
        if (rows.length === 0 && !ALWAYS_SHOWN_QUICK_GROUPS.has(fold)) return null
        const label = t(labelKey)
        return (
          <Fold key={fold} fold={fold} title={label} count={rows.length}>
            <GroupRows rows={rows} fold={fold} title={label} workspaceLabels={labels} seats={seats} />
          </Fold>
        )
      })}
      <Fold fold="workspaces" title={workspacesTitle} keepMounted>
        {children}
      </Fold>
    </div>
  )
}
