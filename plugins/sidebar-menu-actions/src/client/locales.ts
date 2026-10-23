/**
 * Dictionaries for every menu contribution and its toasts. One namespace serves
 * all rows so a locale switch moves them together — they are entries of one
 * feature, not separate features.
 */

export const NS = 'menu-actions'

export const zh = {
  'menu.openInVscode': '在 VS Code 中打开',
  'menu.openInFileBrowser': '在文件浏览器中打开',
  'menu.copyWorkspacePath': '复制工作区路径',
  'toast.vscodeFailed': '无法在 VS Code 中打开：{detail}',
  'toast.fileBrowserFailed': '无法打开文件浏览器：{detail}',
  'toast.pathCopied': '已复制工作区路径',
  'toast.copyFailed': '复制失败：剪贴板不可用',
} as const

export type MenuActionsKey = keyof typeof zh

export const en: Record<MenuActionsKey, string> = {
  'menu.openInVscode': 'Open in VS Code',
  'menu.openInFileBrowser': 'Open in File Browser',
  'menu.copyWorkspacePath': 'Copy workspace path',
  'toast.vscodeFailed': 'Could not open in VS Code: {detail}',
  'toast.fileBrowserFailed': 'Could not open the file browser: {detail}',
  'toast.pathCopied': 'Workspace path copied',
  'toast.copyFailed': 'Could not copy: the clipboard is unavailable',
}
