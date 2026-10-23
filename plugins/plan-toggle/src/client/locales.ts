/**
 * Dictionaries for the one fixed shortcut row this plugin contributes. The
 * label is what the shortcut reference lists, so it follows the active locale
 * like every other registered command.
 */

export const NS = 'plan-toggle'

export const zh = {
  'shortcut.toggle': '切换计划模式',
} as const

export type PlanToggleKey = keyof typeof zh

export const en: Record<PlanToggleKey, string> = {
  'shortcut.toggle': 'Toggle plan mode',
}
