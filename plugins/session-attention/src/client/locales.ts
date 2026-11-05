export const NS = 'session-attention'

export const zh = {
  'trigger.label': '进行中、置顶与未读会话',
  'panel.title': '进行中、置顶与未读',
  'panel.close': '关闭',
  'panel.empty': '当前没有进行中、置顶或未读的会话',
  'section.running': '进行中与置顶',
  'section.unread': '未读',
  'row.open': '打开会话 {title}',
  'row.openPinned': '打开置顶会话 {title}',
  'row.pinned': '置顶',
  'row.unpin': '取消置顶',
} as const

export type AttentionKey = keyof typeof zh

export const en: Record<AttentionKey, string> = {
  'trigger.label': 'Running, pinned and unread sessions',
  'panel.title': 'Running, pinned and unread',
  'panel.close': 'Close',
  'panel.empty': 'No running, pinned or unread sessions',
  'section.running': 'Running and pinned',
  'section.unread': 'Unread',
  'row.open': 'Open session {title}',
  'row.openPinned': 'Open pinned session {title}',
  'row.pinned': 'Pinned',
  'row.unpin': 'Unpin session',
}
