/**
 * Dictionaries for every menu contribution and its toasts. One namespace serves
 * all rows so a locale switch moves them together — they are entries of one
 * feature, not separate features.
 */

/** Namespace registered on the locale service; also the registration's `locale` seat. */
export const NS = 'menu-actions'

export const zh = {
  'menu.openInVscode': '在 VS Code 中打开',
  'menu.copyWorkspacePath': '复制工作区路径',
  'toast.vscodeFailed': '无法在 VS Code 中打开：{detail}',
  'toast.pathCopied': '已复制工作区路径',
  'toast.copyFailed': '复制失败：剪贴板不可用',
} as const

/** Closed key set: every dictionary access in the plugin resolves against it. */
export type MenuActionsKey = keyof typeof zh

export const en: Record<MenuActionsKey, string> = {
  'menu.openInVscode': 'Open in VS Code',
  'menu.copyWorkspacePath': 'Copy workspace path',
  'toast.vscodeFailed': 'Could not open in VS Code: {detail}',
  'toast.pathCopied': 'Workspace path copied',
  'toast.copyFailed': 'Could not copy: the clipboard is unavailable',
}
