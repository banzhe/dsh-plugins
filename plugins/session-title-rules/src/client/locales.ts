/**
 * Locale bundles for the title-model settings page.
 *
 * The page rides an existing locale namespace (`menu-actions` is NOT reused):
 * this Bundle owns `session-title-rules`, registered in `index.ts`.
 */

import type { SettingsFormLabels } from '@deepseek-ai/dsh-client-ui-primitives'

/** Locale keys the page renders. */
export type TitleModelLocaleKey =
  | 'overridden' | 'reset' | 'readOnly' | 'unavailable'
  | 'save' | 'saving' | 'saveFailed'
  | 'title' | 'description'
  | 'modelLabel' | 'modelHint' | 'modelInherited'
  | 'effortLabel' | 'effortHint' | 'effortInherited'
  | 'catalogLoading' | 'catalogFailed' | 'catalogRetry' | 'catalogPartial' | 'catalogEmpty'
  | 'unavailableRoute'
  | 'invalidPair'

/** English copy. */
export const en: Record<TitleModelLocaleKey, string> = {
  overridden: 'Overridden',
  reset: 'Reset to default',
  readOnly: 'This deployment stores settings read-only.',
  unavailable: 'This plugin is not loaded, so it cannot be configured right now.',
  save: 'Save',
  saving: 'Saving…',
  saveFailed: 'The deployment did not accept these values; they were left for you to correct.',
  title: 'Session title model',
  description: 'Choose which model generates this plugin\'s session titles.',
  modelLabel: 'Title model',
  modelHint: 'The model that derives session titles. Pick the session\'s own route to follow it, or fix one model for every title.',
  modelInherited: 'Follow the session model',
  effortLabel: 'Reasoning effort',
  effortHint: 'Some models spend their whole output budget on hidden reasoning before writing a title. Choose a level this model supports, or leave it at the default.',
  effortInherited: 'Route default',
  catalogLoading: 'Loading models…',
  catalogFailed: 'Models could not be loaded.',
  catalogRetry: 'Retry',
  catalogPartial: 'Some model providers could not be loaded; a saved route stays selectable.',
  catalogEmpty: 'No model provider currently advertises a model.',
  unavailableRoute: 'Saved but currently unavailable',
  invalidPair: 'Choose both a model and a provider before saving.',
}

/** Simplified Chinese copy. */
export const zh: Record<TitleModelLocaleKey, string> = {
  overridden: '已覆盖',
  reset: '恢复默认',
  readOnly: '本部署的设置为只读。',
  unavailable: '该插件当前未加载，暂时无法配置。',
  save: '保存',
  saving: '保存中…',
  saveFailed: '本部署没有接受这些值，已保留供你修改。',
  title: '会话标题模型',
  description: '选择用哪个模型生成本插件的会话标题。',
  modelLabel: '标题模型',
  modelHint: '用于提炼会话标题的模型。可选「跟随会话模型」，或为所有标题固定一个模型。',
  modelInherited: '跟随会话模型',
  effortLabel: '推理强度',
  effortHint: '部分模型会把全部输出预算花在隐藏推理上，导致写不出标题。请选择该模型支持的水平，或保持默认。',
  effortInherited: '路由默认',
  catalogLoading: '正在加载模型…',
  catalogFailed: '无法加载模型。',
  catalogRetry: '重试',
  catalogPartial: '部分模型提供方暂时无法加载；已保存的路由仍可选择。',
  catalogEmpty: '当前没有模型提供方公布模型。',
  unavailableRoute: '已保存但当前不可用',
  invalidPair: '保存前请同时选择模型和提供方。',
}

/**
 * The form frame's copy, read from this page's dictionary.
 * @param t - the page's locale reader.
 * @returns the labels the shared settings form renders.
 */
export function formLabels(t: (key: TitleModelLocaleKey) => string): SettingsFormLabels {
  return {
    unavailable: t('unavailable'),
    readOnly: t('readOnly'),
    saveFailed: t('saveFailed'),
    save: t('save'),
    saving: t('saving'),
  }
}
