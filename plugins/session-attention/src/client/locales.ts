export const NS = 'session-attention'

export const zh = {
  'trigger.label': '进行中与未读会话',
  'panel.title': '进行中与未读',
  'panel.close': '关闭',
  'panel.empty': '当前没有进行中或未读的会话',
  'section.running': '进行中',
  'section.unread': '未读',
  'row.open': '打开会话 {title}',
} as const

export type AttentionKey = keyof typeof zh

export const en: Record<AttentionKey, string> = {
  'trigger.label': 'Running and unread sessions',
  'panel.title': 'Running and unread',
  'panel.close': 'Close',
  'panel.empty': 'No running or unread sessions',
  'section.running': 'Running',
  'section.unread': 'Unread',
  'row.open': 'Open session {title}',
}
