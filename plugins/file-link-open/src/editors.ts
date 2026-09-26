/**
 * @banzhe/dsh-file-link-open — The editors this plugin launches: the launch
 * route's whitelist and the id union its line-argv tables are keyed by, so an
 * unknown id fails to compile rather than silently dropping a line.
 *
 * The ONE source for this list: the browser half imports it too, instead of
 * keeping a copy to filter the menu with. A second copy could drift, and a
 * drifted copy shows a menu item the host's whitelist then answers 400 for —
 * exactly the failure the menu's intersection with `available` claims to make
 * impossible. `app.<id>` labels are pinned to these ids by the template-literal
 * key the client's translator is called with, so a new id without a label is a
 * compile error rather than a menu reading `app.nvim`.
 *
 * The official catalog carries more entries. File managers (finder/explorer/
 * filemanager) are excluded on purpose: a file-manager shell-open with the file
 * path opens the file in its default app, so the browser half launches those
 * through the official route with the file's DIRECTORY instead.
 */
export const EDITOR_IDS = [
  'cursor', 'vscode', 'vscodeinsiders', 'windsurf', 'zed', 'sublimetext',
  'androidstudio', 'intellij', 'pycharm', 'webstorm', 'phpstorm',
  'goland', 'rider', 'rustrover',
] as const

export type EditorId = (typeof EDITOR_IDS)[number]
