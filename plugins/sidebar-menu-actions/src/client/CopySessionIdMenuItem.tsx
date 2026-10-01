/**
 * The "Copy session ID" row: one `sidebar.workspaces.session.menu.item`
 * contribution. The row owns no Host state — the id arrives on the owner share —
 * so its injected face is the single `copy` callback.
 *
 * It dismisses the menu **before** acting, as every shipped row does: the menu
 * closes on click, Enter, or Tab identically, and the notice that answers the
 * action is not trapped behind an open list.
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

export type CopySessionIdMenuItemProps =
  PropsRuntime<'sidebar.workspaces.session.menu.item'>
  & PropsLocale<'menu-actions'>
  & InjectFace<CopySessionIdInjected>

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
