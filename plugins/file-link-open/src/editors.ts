/**
 * @banzhe/dsh-file-link-open — The editors this plugin launches.
 *
 * The official open-in-app catalog carries more entries than this plugin uses
 * (the file managers among them); this is the whitelist the launch route checks
 * a request against and the id union every line-argv table is keyed by, so a
 * misspelled or unknown id fails to compile instead of silently dropping a line.
 */

/**
 * Official open-in-app catalog ids this plugin launches, with labels on the
 * browser side. File managers (finder/explorer/filemanager) are excluded: the
 * browser half offers them from the official probe alone and launches them
 * through the official POST /open-in-app/open route with the file's directory
 * — the exact call the session-header menu makes — because a file-manager
 * shell-open with the file path would open the file in its default app instead.
 */
export const EDITOR_IDS = [
  'cursor', 'vscode', 'vscodeinsiders', 'windsurf', 'zed', 'sublimetext',
  'androidstudio', 'intellij', 'pycharm', 'webstorm', 'phpstorm',
  'goland', 'rider', 'rustrover',
] as const

/** One editor this plugin launches, by official catalog id. */
export type EditorId = (typeof EDITOR_IDS)[number]
