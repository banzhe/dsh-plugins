/**
 * Dictionaries for the header control and the notices it raises. One namespace
 * serves both, so a language switch moves the button label, the menu's
 * accessible name, and every failure message together.
 */

export const NS = 'open-in-select'

/** Simplified Chinese dictionary (the key-set source of truth). */
export const zh = {
  'action.open': '用 {app} 打开',
  'action.more': '更多打开方式',
  'error.invalid': '无法打开：请求无效',
  'error.missing': '无法打开：应用或路径不可用',
  'error.tooLong': '无法打开：路径过长',
  'error.unsupported': '无法打开：该应用不能打开这个路径',
  'error.launch': '无法打开：系统启动失败',
  'error.status': '无法打开（HTTP {status}）',
  'error.unreachable': '无法打开：连接不到 DSH',
} as const

/** Key domain of the `open-in-select` namespace. */
export type OpenInSelectKey = keyof typeof zh

/** English dictionary, key-identical to the Chinese source of truth. */
export const en: Record<OpenInSelectKey, string> = {
  'action.open': 'Open in {app}',
  'action.more': 'More ways to open',
  'error.invalid': 'Could not open: the request was rejected',
  'error.missing': 'Could not open: the application or the path is unavailable',
  'error.tooLong': 'Could not open: the path is too long',
  'error.unsupported': 'Could not open: the application cannot open this path',
  'error.launch': 'Could not open: the system launcher failed',
  'error.status': 'Could not open (HTTP {status})',
  'error.unreachable': 'Could not open: DSH could not be reached',
}
