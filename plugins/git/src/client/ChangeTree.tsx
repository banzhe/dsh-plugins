import { useState, type ReactNode } from 'react'
import {
  FileTypeIcon,
  IconChevronDownOutlineRegular,
  IconChevronRightOutlineRegular,
  IconFolderCloseRegular,
  IconFolderOpenRegular,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { GitChange, GitChangeStatus } from '../shared.ts'
import type { GitKey } from './locales.ts'
import css from './panel.module.css'
import { buildChangeTree, type ChangeNode } from './tree.ts'

const STATUS_MARK: Record<GitChangeStatus, string> = {
  added: 'A',
  modified: 'M',
  deleted: 'D',
  renamed: 'R',
  untracked: 'U',
}

const STATUS_KEY: Record<GitChangeStatus, GitKey> = {
  added: 'status.added',
  modified: 'status.modified',
  deleted: 'status.deleted',
  renamed: 'status.renamed',
  untracked: 'status.untracked',
}

function DirectoryRow({ node, depth, t }: { node: ChangeNode; depth: number; t: (key: GitKey) => string }): ReactNode {
  const [open, setOpen] = useState(true)
  const Icon = open ? IconFolderOpenRegular : IconFolderCloseRegular
  const Chevron = open ? IconChevronDownOutlineRegular : IconChevronRightOutlineRegular
  return (
    <li>
      <button
        type="button"
        className={`${css.row} ${css.disclosure}`}
        style={{ paddingInlineStart: 8 + depth * 16 }}
        aria-expanded={open}
        onClick={() => { setOpen((current) => !current) }}
      >
        <Chevron size={12} className={css.chevron} />
        <Icon size={16} />
        <span className={css.name}>{node.name}</span>
      </button>
      {open
        ? (
          <ul className={css.level}>
            {node.children.map((child) => (
              <ChangeRow key={child.name} node={child} depth={depth + 1} t={t} />
            ))}
          </ul>
        )
        : null}
    </li>
  )
}

function FileRow({ node, depth, t }: { node: ChangeNode; depth: number; t: (key: GitKey) => string }): ReactNode {
  const status = node.status ?? 'modified'
  return (
    <li>
      <div className={css.row} style={{ paddingInlineStart: 8 + depth * 16 }}>
        <FileTypeIcon path={node.name} size={16} />
        <span className={css.name}>{node.name}</span>
        <span className={css.mark} data-status={status} aria-label={t(STATUS_KEY[status])}>
          {STATUS_MARK[status]}
        </span>
      </div>
    </li>
  )
}

function ChangeRow({ node, depth, t }: { node: ChangeNode; depth: number; t: (key: GitKey) => string }): ReactNode {
  return node.status === undefined
    ? <DirectoryRow node={node} depth={depth} t={t} />
    : <FileRow node={node} depth={depth} t={t} />
}

export function ChangeTree({ changes, t }: {
  changes: readonly GitChange[]
  t: (key: GitKey) => string
}): ReactNode {
  if (changes.length === 0) return <p className={css.note}>{t('panel.empty')}</p>
  const tree = buildChangeTree(changes)
  return (
    <ul className={css.changes}>
      {tree.map((node) => <ChangeRow key={node.name} node={node} depth={0} t={t} />)}
    </ul>
  )
}
