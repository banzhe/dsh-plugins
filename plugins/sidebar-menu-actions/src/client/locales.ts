/**
 * Dictionaries for both menu contributions and their toasts. One namespace
 * serves both rows so a locale switch moves them together — they are two
 * entries of one feature (sidebar row-menu extensions), not two features.
 */

/** Namespace registered on the locale service; also the registration's `locale` seat. */
export const NS = 'menu-actions'

export const zh = {
  'menu.openInVscode': '在 VS Code 中打开',
  'menu.copySessionId': '复制 Session ID',
  'toast.vscodeFailed': '无法在 VS Code 中打开：{detail}',
  'toast.copied': '已复制 Session ID',
  'toast.copyFailed': '复制失败：剪贴板不可用',
} as const

/** Closed key set: every dictionary access in the plugin resolves against it. */
export type MenuActionsKey = keyof typeof zh

export const en: Record<MenuActionsKey, string> = {
  'menu.openInVscode': 'Open in VS Code',
  'menu.copySessionId': 'Copy session ID',
  'toast.vscodeFailed': 'Could not open in VS Code: {detail}',
  'toast.copied': 'Session ID copied',
  'toast.copyFailed': 'Could not copy: the clipboard is unavailable',
}
