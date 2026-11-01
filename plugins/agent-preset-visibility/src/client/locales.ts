/** Locale bundles for the preset-visibility settings page (namespace `agent-preset-visibility`). */

export type PresetVisibilityKey =
  | 'nav' | 'intro'
  | 'shown' | 'hidden' | 'defaultBadge' | 'brokenBadge'
  | 'allShown' | 'hiddenCount'
  | 'loading' | 'failed' | 'retry' | 'unavailable' | 'readOnly'
  | 'writeFailed' | 'refreshHint'

export const en: Record<PresetVisibilityKey, string> = {
  nav: 'Preset visibility',
  intro: 'Clear a preset to keep it out of the preset picker. Hiding only changes the list: a hidden preset still registers, still composes the sessions that already run it, and still serves any delegation that names it.',
  shown: 'Shown',
  hidden: 'Hidden',
  defaultBadge: 'Default',
  brokenBadge: 'Unavailable',
  allShown: 'Every preset is shown.',
  hiddenCount: '{count} hidden',
  loading: 'Loading presets…',
  failed: 'Presets could not be loaded.',
  retry: 'Retry',
  unavailable: 'This plugin is not loaded, so there is nothing to configure.',
  readOnly: 'This deployment stores settings read-only.',
  writeFailed: 'The deployment did not accept this change.',
  refreshHint: 'Pickers re-read the roster the next time one opens.',
}

export const zh: Record<PresetVisibilityKey, string> = {
  nav: '预设可见性',
  intro: '取消勾选即可把该预设从预设选择器里隐藏。隐藏只改变列表：被隐藏的预设仍然注册，仍然支撑已经在用它的会话，也仍然服务任何指名调用它的委派。',
  shown: '显示',
  hidden: '已隐藏',
  defaultBadge: '默认',
  brokenBadge: '不可用',
  allShown: '所有预设都显示。',
  hiddenCount: '已隐藏 {count} 项',
  loading: '正在加载预设…',
  failed: '无法加载预设。',
  retry: '重试',
  unavailable: '该插件当前未加载，无需配置。',
  readOnly: '本部署的设置为只读。',
  writeFailed: '本部署没有接受这次修改。',
  refreshHint: '选择器下次打开时会重新读取清单。',
}
