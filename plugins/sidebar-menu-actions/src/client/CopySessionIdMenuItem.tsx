/**
 * The "Copy session ID" row: one `sidebar.workspaces.session.menu.item`
 * contribution over the plain act of writing the row's Session id to the
 * clipboard. The row owns no Host state — the id arrives on the owner share —
 * so its injected face is the single `copy` callback: how the clipboard is
 * driven and how success/failure surface belong to the plugin body, not here.
 *
 * Like every shipped row (pin/rename/fork/archive), it dismisses the menu it
 * sits in through the injected `useMenuOpenState` hook **before** acting: the
 * menu closes on click, Enter, or Tab identically, and the notice that answers
 * the action is not trapped behind an open list.
 */
import { IconCopyOutlineRegular, MenuItemButton } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: the `sidebar.workspaces.session.menu.item` SlotMap entry this
// component's runtime share (owner props + `useMenuOpenState`) composes from.
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
// Type-only: the `GlobalStandardProps` selectors the composed props require.
import type {} from '@deepseek-ai/dsh-client-ui-session/client'

/** Business face the plugin injects into the row (framework binds it to props). */
export interface CopySessionIdInjected {
  /** Write the Session id to the clipboard; reports its own outcome as a toast. */
  copy: (sessionId: string) => void
}

/** Full component props: runtime share + locale seat + injected business face. */
export type CopySessionIdMenuItemProps =
  PropsRuntime<'sidebar.workspaces.session.menu.item'>
  & PropsLocale<'menu-actions'>
  & InjectFace<CopySessionIdInjected>

/**
 * Render the Copy-session-ID menu row.
 * @param props - composed slot props (contract in ui-workspace/client).
 * @returns the row element, or the element tree of one menu-item button.
 */
export function CopySessionIdMenuItem({
  sessionId, useMenuOpenState, t, copy,
}: CopySessionIdMenuItemProps) {
  const [, setMenuOpen] = useMenuOpenState()
  return (
    <MenuItemButton
      icon={<IconCopyOutlineRegular />}
      onSelect={() => {
        setMenuOpen(false)
        copy(sessionId)
      }}
    >
      {t('menu.copySessionId')}
    </MenuItemButton>
  )
}
