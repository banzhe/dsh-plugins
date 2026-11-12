/**
 * Dictionaries for the rows this plugin contributes to the official file
 * context menu. One namespace serves the row labels, the application names they
 * select, and the failure copy the shared menu shows when a row's operation
 * rejects.
 *
 * Keys live in two kinds of domain: `row.*` and `error.*` name this plugin's own
 * copy, and `app.*` names one catalog application. The namespace matches the
 * package name and the plugin id, so a reader of a menu row's locale key knows
 * where to look.
 */

export const NS = 'file-link-open'

/** Simplified Chinese dictionary (the key-set source of truth). */
export const zh = {
  'row.line': '第 {line} 行',
  'row.copyRelativePath': '复制相对路径',
  'error.openFailed': '无法打开',
  'error.copyFailed': '无法复制路径',
  'app.vscode': 'VS Code',
  'app.vscodeinsiders': 'VS Code Insiders',
  'app.cursor': 'Cursor',
  'app.windsurf': 'Windsurf',
  'app.zed': 'Zed',
  'app.sublimetext': 'Sublime Text',
  'app.androidstudio': 'Android Studio',
  'app.intellij': 'IntelliJ IDEA',
  'app.pycharm': 'PyCharm',
  'app.webstorm': 'WebStorm',
  'app.phpstorm': 'PhpStorm',
  'app.goland': 'GoLand',
  'app.rider': 'Rider',
  'app.rustrover': 'RustRover',
} as const

/** Key domain of the `file-link-open` namespace. */
export type LocaleKey = keyof typeof zh

/** English dictionary, key-identical to the Chinese source of truth. */
export const en: Record<LocaleKey, string> = {
  'row.line': 'Line {line}',
  'row.copyRelativePath': 'Copy relative path',
  'error.openFailed': 'Could not open the file',
  'error.copyFailed': 'Could not copy the path',
  'app.vscode': 'VS Code',
  'app.vscodeinsiders': 'VS Code Insiders',
  'app.cursor': 'Cursor',
  'app.windsurf': 'Windsurf',
  'app.zed': 'Zed',
  'app.sublimetext': 'Sublime Text',
  'app.androidstudio': 'Android Studio',
  'app.intellij': 'IntelliJ IDEA',
  'app.pycharm': 'PyCharm',
  'app.webstorm': 'WebStorm',
  'app.phpstorm': 'PhpStorm',
  'app.goland': 'GoLand',
  'app.rider': 'Rider',
  'app.rustrover': 'RustRover',
}

/** The locale service's namespace-bound translate, as this plugin calls it. */
export type Translator = (key: LocaleKey, params?: Record<string, string>) => string
