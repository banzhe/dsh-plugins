/** `app-badge` namespace dictionaries. */

/** Dictionary namespace owned by this plugin. */
export const NS = 'app-badge'

/** Simplified Chinese dictionary (the key-set source of truth). */
export const zh = {
  'notify.title': '会话已完成',
  'notify.body': '「{title}」已完成，点击查看',
  'test.title': '测试通知',
  'test.body': '如果你看到这条通知，说明完成提醒工作正常。',
  'settings.title': '完成提醒',
  'settings.description': '把已完成未读的会话数显示在已安装应用的图标角标上，并在会话完成时弹出系统通知。',
  'settings.permissionLabel': '通知权限',
  'settings.permission.granted': '已授权',
  'settings.permission.denied': '已被拒绝，请在浏览器站点设置里改回「允许」',
  'settings.permission.default': '未授权',
  'settings.permission.unsupported': '当前浏览器不支持通知',
  'settings.badgeLabel': '图标角标',
  'settings.badge.supported': '可用',
  'settings.badge.unsupported': '当前浏览器不支持角标（需要已安装的 Chromium 应用）',
  'settings.request': '申请通知权限',
  'settings.requesting': '申请中…',
  'settings.test': '发送测试通知',
  'settings.test.sent': '已发送：请查看系统通知。',
  'settings.test.failed': '没能发送，请先申请通知权限。',
} as const

/** English dictionary, key-identical to the Chinese source of truth. */
export const en: Record<AppBadgeKey, string> = {
  'notify.title': 'Session finished',
  'notify.body': '“{title}” finished. Open to review.',
  'test.title': 'Test notification',
  'test.body': 'If you can read this, completion attention is working.',
  'settings.title': 'Completion attention',
  'settings.description': 'Show the finished-unread Session count on the installed app’s icon badge and raise a system notification when a Session finishes.',
  'settings.permissionLabel': 'Notification permission',
  'settings.permission.granted': 'Granted',
  'settings.permission.denied': 'Denied — allow notifications in the browser’s site settings',
  'settings.permission.default': 'Not granted',
  'settings.permission.unsupported': 'This browser has no notification support',
  'settings.badgeLabel': 'Icon badge',
  'settings.badge.supported': 'Available',
  'settings.badge.unsupported': 'This browser has no badge support (needs an installed Chromium app)',
  'settings.request': 'Request permission',
  'settings.requesting': 'Requesting…',
  'settings.test': 'Send test notification',
  'settings.test.sent': 'Sent — check your system notifications.',
  'settings.test.failed': 'Not sent — grant notification permission first.',
}

/** Key domain of the `app-badge` namespace (zh is the source of truth). */
export type AppBadgeKey = keyof typeof zh
