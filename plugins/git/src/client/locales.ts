/** Namespace registered on the locale service; also the registration's `locale` seat. */
export const NS = 'git'

export const zh = {
  'type.label': 'Git',
  'guide.title': 'Git',
  'guide.description': '查看当前工作区的变更',
  'panel.noWorkspace': '这个会话还没有工作区。',
  'panel.loading': '正在读取变更…',
  'panel.empty': '没有文件变更。',
  'panel.notRepository': '这个工作区还不是 Git 仓库。',
  'panel.detached': '游离 HEAD',
  'commit.label': '提交说明',
  'commit.placeholder': '提交说明',
  'commit.action': '提交',
  'commit.pending': '正在提交…',
  'commit.done': '已提交 {hash}',
  'draft.zh': '中文',
  'draft.en': 'English',
  'draft.failed': '没能生成提交说明。',
  'status.added': '新增',
  'status.modified': '修改',
  'status.deleted': '删除',
  'status.renamed': '重命名',
  'status.untracked': '未跟踪',
} as const

/** Closed key set: every dictionary access in the plugin resolves against it. */
export type GitKey = keyof typeof zh

export const en: Record<GitKey, string> = {
  'type.label': 'Git',
  'guide.title': 'Git',
  'guide.description': 'View changes in the current workspace',
  'panel.noWorkspace': 'This session has no workspace.',
  'panel.loading': 'Reading changes…',
  'panel.empty': 'No file changes.',
  'panel.notRepository': 'This workspace is not a Git repository.',
  'panel.detached': 'Detached HEAD',
  'commit.label': 'Commit message',
  'commit.placeholder': 'Commit message',
  'commit.action': 'Commit',
  'commit.pending': 'Committing…',
  'commit.done': 'Committed {hash}',
  'draft.zh': '中文',
  'draft.en': 'English',
  'draft.failed': 'Could not draft a commit message.',
  'status.added': 'Added',
  'status.modified': 'Modified',
  'status.deleted': 'Deleted',
  'status.renamed': 'Renamed',
  'status.untracked': 'Untracked',
}
