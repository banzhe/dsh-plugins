/**
 * Workspace pick/add flow. WorkspacePickFlow is the reusable core (menu +
 * path error dialog) consumed directly by WorkspaceBrowser (same package) and
 * wrapped by WorkspacePicker for the conversation empty-state slot
 * registration. Directory picking itself lives in the composed flow package's
 * slot occupant (see the contract module doc): this core only opens the flow,
 * adopts the picked path, and owns the error surface. Adding a workspace has
 * exactly one route — pick a host directory, new or existing — because the
 * occupant's own create-folder affordance already covers creating one.
 *
 * The list is the sidebar's Workspace tree in a popover: same ancestor rule,
 * same registry order, same `groupExpansion` record (this flow's entry
 * declares that store), so folding a Workspace in one surface folds it in the
 * other. The disclosure is its own button beside the row, which keeps "select
 * this Workspace" and "show what is under it" separate gestures.
 */
import type { ReactNode, RefObject } from 'react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import clsx from 'clsx'
import {
  Button, IconCheckOutlineRegular, IconFolderCloseRegular, IconPlusOutlineRegular,
  IconTriangleRightFillRegular, Menu, MenuItemButton, Modal, type MenuEntry,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type {
  WorkspaceId, WorkspaceSnapshot, WorkspaceView,
} from '@deepseek-ai/dsh-api-workspace-controller/client'
import { workspaceDisplayTitle } from '@deepseek-ai/dsh-api-workspace-controller/default-workspace'
import type { SnapshotSelectorHook } from '@deepseek-ai/dsh-client-ui-slots'
import type { DirectoryFlowOwnerProps, WorkspacePickerProps } from './contract/slots.ts'
import { distinguishingPathSuffixes } from './path-suffix.ts'
import { owningParentFolder } from './tree.ts'
import css from './WorkspacePicker.module.css'

const ADD_WORKSPACE = '::add-workspace'

/** One nesting step's indent; the sidebar tree indents by the same step. */
const INDENT_STEP_PX = 12

/** One listed Workspace as its row renders it, before nesting. */
interface PickListRow {
  readonly id: WorkspaceId
  readonly title: string
  readonly path: string
  /** Shortest path tail that tells same-titled rows apart; absent when the title already does. */
  readonly suffix: string | undefined
}

/** One rendered pick row: identity plus its place in the nested list. */
interface PickRow extends PickListRow {
  readonly depth: number
  readonly hasChildren: boolean
  readonly expanded: boolean
}

/**
 * Order the listed Workspaces the way the sidebar's tree draws them: each one
 * sits directly under its nearest registered ancestor, siblings keep the
 * registry order, and a parent always precedes its children. A collapsed row
 * takes its whole subtree out of the list. A row with no explicit expansion is
 * expanded, which is the default the sidebar reads as well.
 * @param listed - Workspaces in registry order, each with its disambiguating suffix.
 * @param expansion - persisted expansion by Workspace id (the sidebar's own key).
 * @returns rows in render order, each carrying its nesting depth.
 */
function nestPickRows(
  listed: readonly PickListRow[],
  expansion: Readonly<Record<string, boolean>>,
): readonly PickRow[] {
  // Same ancestor rule as the sidebar: the nearest registered path that
  // contains this one. A parent is always a strict path prefix, so walking
  // down the chain always terminates.
  const idByPath = new Map(listed.map(row => [row.path, row.id]))
  const paths = [...idByPath.keys()]
  const children = new Map<WorkspaceId | undefined, PickListRow[]>()
  for (const row of listed) {
    const parentPath = owningParentFolder(row.path, paths)
    const parent = parentPath === undefined ? undefined : idByPath.get(parentPath)
    const siblings = children.get(parent)
    if (siblings === undefined) children.set(parent, [row])
    else siblings.push(row)
  }
  const rows: PickRow[] = []
  const walk = (parent: WorkspaceId | undefined, depth: number): void => {
    for (const row of children.get(parent) ?? []) {
      const hasChildren = (children.get(row.id)?.length ?? 0) > 0
      const expanded = expansion[row.id] ?? hasChildren
      rows.push({ ...row, depth, hasChildren, expanded })
      if (expanded) walk(row.id, depth + 1)
    }
  }
  walk(undefined, 0)
  return rows
}

/** Core flow props: the owner supplies popover control and pick semantics. */
export interface WorkspacePickFlowProps {
  /** The standard locale seat, forwarded by whichever slot entry hosts the flow. */
  t: WorkspacePickerProps['t']
  /** Popover visibility (anchor button toggle state, owner-local). */
  open: boolean
  /** The anchor button element — the popover's placement anchor. */
  anchorRef?: RefObject<HTMLElement | null> | undefined
  /** Selector hook over the workspace list (framework standard hook). */
  useWorkspaces: <S>(selector: (state: WorkspaceSnapshot) => S) => S
  /** Adopt a picked host directory as a real Workspace. */
  createWorkspace: (input: { path: string }) => Promise<WorkspaceView>
  /** Bound occupancy selector hook for this surface's directory-flow hole (empty leaves the surface with no add action). */
  useDirectoryFlow: SnapshotSelectorHook<boolean>
  /** Render this surface's directory-flow hole with the owner conversation (the entry's narrowed renderSlot). */
  renderDirectoryFlow: (owner: DirectoryFlowOwnerProps) => ReactNode
  /** A real Workspace was picked or created. */
  onPick: (workspaceId: WorkspaceId) => void
  /** Close the popover (outside click / Escape / post-pick). */
  onClose: () => void
  /** Report the picking interaction and adoption occupancy. */
  onBusyChange?: (busy: boolean) => void
  /** Only offer the add action, hide existing workspaces. */
  addOnly?: boolean
  /** Menu opening direction relative to the anchor. */
  side?: 'bottom' | 'top' | 'right'
  /** Currently active workspace (trailing check in the picker list). */
  selectedId?: WorkspaceId | undefined
  /** Selector hook over the shared viewing store (the expansion the sidebar's tree also reads). */
  useStore: WorkspacePickerProps['useStore']
  /** Persist one Workspace's expansion into that same store. */
  setGroupExpanded: WorkspacePickerProps['actions']['setGroupExpanded']
}

/**
 * Render the pick menu plus the adoption error dialog.
 * @param props - owner-controlled flow props.
 * @returns menu + dialog elements.
 */
export function WorkspacePickFlow({
  t,
  open,
  anchorRef,
  useWorkspaces,
  createWorkspace,
  useDirectoryFlow,
  renderDirectoryFlow,
  onPick,
  onClose,
  addOnly = false,
  onBusyChange,
  side = 'bottom',
  selectedId,
  useStore,
  setGroupExpanded,
}: WorkspacePickFlowProps) {
  // Without an owner-provided anchor, the menu remains hidden.
  const absentAnchor = useRef<HTMLElement>(null)
  const workspaceSnapshot = useWorkspaces(state => state)
  const workspaces = workspaceSnapshot.items
  const [errorOpen, setErrorOpen] = useState(false)
  const [modalError, setModalError] = useState<string | null>(null)
  const [flowOpen, setFlowOpen] = useState(false)
  const [pickingFolder, setPickingFolder] = useState(false)
  // One picking interaction at a time: while the flow is open (native chooser
  // pending, browse dialog up) or its pick is being adopted, every other
  // menu action stays disabled — a late outcome must not race a concurrent
  // selection or adoption.
  const flowBusy = flowOpen || pickingFolder
  useEffect(() => { onBusyChange?.(flowBusy) }, [flowBusy, onBusyChange])

  // The occupied hole gates the picking affordance: with no composed flow the
  // entry simply is not there (the seam's documented no-flow default). The
  // framework-bound hook keeps occupancy live: flow plugins activate (and
  // HMR-reload) independently of this menu's renders.
  const flowAvailable = useDirectoryFlow(occupied => occupied)
  // An occupant that unloads mid-interaction leaves nobody to cancel: an
  // open flow over an empty hole withdraws so the menu actions come back.
  // flowOpen is a dependency because the flow can also OPEN over an already
  // empty hole (Choose again after the occupant unloaded with the error
  // dialog up) — that transition must snap back too, not just occupancy loss.
  useEffect(() => {
    if (flowOpen && !flowAvailable) setFlowOpen(false)
  }, [flowOpen, flowAvailable])
  const addEntries: MenuEntry[] = flowAvailable
    ? [{ id: ADD_WORKSPACE, label: t('menu.addWorkspace'), icon: <IconPlusOutlineRegular size={16} />, disabled: flowBusy }]
    : []
  // With workspaces listed, the add action pins below the scroll region
  // (divider + always visible); otherwise it IS the menu.
  const pinAdd = !addOnly && workspaces.length > 0
  // The resolved name, not `t`, is the memo dependency: the bound seat keeps
  // its identity across a language switch.
  const defaultWorkspaceName = t('workspace.defaultName')
  // The expansion the sidebar's tree writes: one record, one set of keys, so
  // folding a Workspace here folds the same Workspace there.
  const groupExpansion = useStore(state => state.groupExpansion)
  const listed = useMemo(() => {
    if (!pinAdd) return []
    const rows = workspaces.map(workspace => ({
      id: workspace.workspaceId,
      title: workspaceDisplayTitle(workspace.title, defaultWorkspaceName),
      path: workspace.path,
    }))
    const suffixes = distinguishingPathSuffixes(rows)
    return nestPickRows(
      rows.map(row => ({ ...row, suffix: suffixes.get(row.id) })),
      groupExpansion,
    )
  }, [pinAdd, workspaces, defaultWorkspaceName, groupExpansion])
  // Listed Workspaces are nested rows of their own; the only data row left is
  // the add action, which either pins below the list or IS the menu.
  const items: MenuEntry[] = pinAdd ? [] : addEntries
  // Nothing listed and nothing to add with (a composition that mounts this
  // package without any directory-picker): an empty popover would claim a
  // choice that does not exist, so the anchor gesture shows nothing at all.
  const menuIsEmpty = items.length === 0 && listed.length === 0

  const closeModal = (): void => {
    setErrorOpen(false)
    setModalError(null)
  }

  /** Adopt a picked directory; failures land in the folder-error dialog (Choose again reopens the flow). */
  const adoptDirectory = (path: string): Promise<void> =>
    createWorkspace({ path }).then((workspace) => {
      setFlowOpen(false)
      onPick(workspace.workspaceId)
    }).catch((reason: unknown) => {
      setModalError(reason instanceof Error ? reason.message : String(reason))
      setFlowOpen(false)
      setErrorOpen(true)
    })

  const openDirectoryFlow = useCallback((): void => {
    onClose()
    setErrorOpen(false)
    setModalError(null)
    setFlowOpen(true)
  }, [onClose])

  // A menu exists to disambiguate between targets. With no workspaces listed
  // and the add action the only entry left, the anchor gesture IS that action:
  // a one-row popover would cost a click and offer nothing to choose between.
  // The owner's open request is consumed the same way selecting the entry
  // would consume it (close the popover, raise the flow). An empty list is
  // only final once the baseline lands — until then the menu stays up with its
  // loading status instead of jumping into a flow the arriving list would have
  // made unnecessary; the add-only surface lists nothing and never waits.
  const listSettled = addOnly || workspaceSnapshot.phase === 'ready'
  const addIsTheOnlyEntry = !pinAdd && listSettled && addEntries.length === 1
  // `flowBusy` gates this exactly as it disables the equivalent menu entry: a
  // pick still being adopted owns the surface until it settles.
  useEffect(() => {
    if (open && addIsTheOnlyEntry && !flowBusy) openDirectoryFlow()
  }, [open, addIsTheOnlyEntry, flowBusy, openDirectoryFlow])

  /** Owner side of the flow conversation: adopt keeps the flow open (busy) until the Host answers. */
  const flowOwner: DirectoryFlowOwnerProps = {
    open: flowOpen,
    busy: pickingFolder,
    onPicked: (path) => {
      setPickingFolder(true)
      void adoptDirectory(path).finally(() => { setPickingFolder(false) })
    },
    onCancel: () => { setFlowOpen(false) },
    onError: (message) => {
      setFlowOpen(false)
      setModalError(message)
      setErrorOpen(true)
    },
  }

  const handleSelect = (id: string): void => {
    if (id === ADD_WORKSPACE) {
      openDirectoryFlow()
      return
    }
    onPick(id as WorkspaceId)
  }

  return (
    <>
      <Menu
        open={open && !addIsTheOnlyEntry && !menuIsEmpty}
        anchor={null}
        items={items}
        {...pinAdd ? { footer: addEntries } : {}}
        onSelect={handleSelect}
        onClose={onClose}
        side={side}
        portal
        anchorRef={anchorRef ?? absentAnchor}
      >
        {listed.map(row => (
          // One nested Workspace: the disclosure is a button of its own beside
          // the row, so folding never selects and selecting never folds.
          <div key={row.id} className={css.treeRow} style={{ paddingLeft: row.depth * INDENT_STEP_PX }}>
            {row.hasChildren
              ? (
                <button
                  type="button"
                  role="menuitem"
                  className={css.disclosure}
                  aria-expanded={row.expanded}
                  aria-label={t(row.expanded ? 'group.collapse' : 'group.expand', { name: row.title })}
                  onClick={() => { setGroupExpanded(row.id, !row.expanded) }}
                >
                  <IconTriangleRightFillRegular size={14} className={clsx(css.arrow, row.expanded && css.arrowOpen)} />
                </button>
              )
              : <span className={css.disclosureSpacer} aria-hidden="true" />}
            <div className={css.rowBody}>
              <MenuItemButton
                icon={<IconFolderCloseRegular size={16} />}
                current={row.id === selectedId}
                disabled={flowBusy}
                onSelect={() => { handleSelect(row.id) }}
              >
                <span className={css.rowLine}>
                  {/* The title gives way first, so the suffix that tells the
                    * rows apart stays visible; the native tooltip carries the
                    * full path. */}
                  {row.suffix === undefined
                    ? <span className={css.title}>{row.title}</span>
                    : (
                      <span className={css.disambiguated} title={row.path}>
                        <span className={css.title}>{row.title}</span>
                        {' '}
                        <span className={css.pathSuffix}>{row.suffix}</span>
                      </span>
                    )}
                  {row.id === selectedId && <IconCheckOutlineRegular className={css.check} aria-hidden="true" />}
                </span>
              </MenuItemButton>
            </div>
          </div>
        ))}
      </Menu>
      {open && !addIsTheOnlyEntry && !menuIsEmpty && workspaceSnapshot.phase === 'pending' && <div className={css.menuStatus} role="status">{t('picker.loading')}</div>}
      {renderDirectoryFlow(flowOwner)}
      <Modal
        open={errorOpen}
        onClose={closeModal}
        closeLabel={t('close')}
        title={t('folderError.title')}
        footer={(
          <>
            <Button variant="outline" className={css.modalAction} onClick={closeModal}>{t('cancel')}</Button>
            {/* Retrying needs an occupant to serve the flow; without one the
              * button would open a flow nobody can answer or cancel. */}
            <Button variant="primary" className={css.modalAction} disabled={!flowAvailable} onClick={openDirectoryFlow}>{t('folderError.retry')}</Button>
          </>
        )}
      >
        <div className={css.modalError} role="alert">{modalError}</div>
      </Modal>
    </>
  )
}

/**
 * The conversation empty-state registration: adapts the owner share to the
 * core flow (all state and semantics live in the flow / the owner).
 * @param props - empty-state slot props (owner share + injected creation callback).
 * @returns the flow element.
 */
export function WorkspacePicker({
  open,
  anchorRef,
  useWorkspaces,
  useStore,
  actions,
  selectedId,
  onPick,
  onClose,
  createWorkspace,
  useDirectoryFlow,
  renderSlot,
  t,
}: WorkspacePickerProps) {
  return (
    <WorkspacePickFlow
      t={t}
      open={open}
      anchorRef={anchorRef}
      useWorkspaces={useWorkspaces}
      createWorkspace={createWorkspace}
      useDirectoryFlow={useDirectoryFlow}
      renderDirectoryFlow={owner => renderSlot('conversation.hero.workspace.directoryFlow', owner)}
      selectedId={selectedId}
      useStore={useStore}
      setGroupExpanded={actions.setGroupExpanded}
      onPick={onPick}
      onClose={onClose}
    />
  )
}
