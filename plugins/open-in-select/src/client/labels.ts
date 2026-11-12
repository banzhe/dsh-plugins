/**
 * Display names for the application ids the Host catalog can resolve. The Host
 * answers with ids alone (no display name, no enabled flag), so the name a user
 * reads is this Bundle's own table; an id that is not listed here renders as
 * itself rather than disappearing from the list.
 *
 * Product names are not translated. `finder`, `explorer`, and `terminal` are
 * platform applications, listed under the name each product ships with.
 *
 * The ids come from the Host's `open-in-app` catalog
 * (`@deepseek-ai/dsh-host-open-in-app`). A few entries name ids that catalog has
 * not declared yet: a Host that starts answering one renders its name instead of
 * the raw id, and an id missing here already falls back to itself.
 */
const APP_LABELS: Readonly<Record<string, string>> = {
  finder: 'Finder',
  explorer: 'File Explorer',
  filemanager: 'Files',
  terminal: 'Terminal',
  windowsterminal: 'Windows Terminal',
  gitbash: 'Git Bash',
  gnometerminal: 'GNOME Terminal',
  konsole: 'Konsole',
  iterm: 'iTerm2',
  kitty: 'kitty',
  ghostty: 'Ghostty',
  warp: 'Warp',
  vscode: 'VS Code',
  vscodeinsiders: 'VS Code Insiders',
  cursor: 'Cursor',
  windsurf: 'Windsurf',
  zed: 'Zed',
  sublime: 'Sublime Text',
  sublimetext: 'Sublime Text',
  sublimemerge: 'Sublime Merge',
  idea: 'IntelliJ IDEA',
  intellij: 'IntelliJ IDEA',
  pycharm: 'PyCharm',
  webstorm: 'WebStorm',
  phpstorm: 'PhpStorm',
  goland: 'GoLand',
  rider: 'Rider',
  rustrover: 'RustRover',
  androidstudio: 'Android Studio',
  xcode: 'Xcode',
  fork: 'Fork',
  sourcetree: 'Sourcetree',
  github: 'GitHub Desktop',
  tower: 'Tower',
  gitkraken: 'GitKraken',
  smartgit: 'SmartGit',
}

/**
 * Resolve the name shown for one catalog id.
 * @param appId - catalog id from the Host's application list.
 * @returns the display name, or the id itself when this Bundle has no name for it.
 */
export function appLabel(appId: string): string {
  return APP_LABELS[appId] ?? appId
}
