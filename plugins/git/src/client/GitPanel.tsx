import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { IconBranchOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: merges sessionId and useSessions onto the session standard kit.
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type { GitMessageLanguage, GitStatus } from '../shared.ts'
import { commitWorkspace, draftWorkspaceMessage, readWorkspaceStatus } from './api.ts'
import { ChangeTree } from './ChangeTree.tsx'
import { CommitBox } from './CommitBox.tsx'
import type { GitKey } from './locales.ts'
import css from './panel.module.css'

interface GitTabInfo {
  tab: { title: string }
}

/**
 * The `sidebar.right.pane.tab` seat, restated for this package's own type check.
 *
 * ui-sidebar-right owns both keys and declares them as keyed session slots.
 * `inject.hooks.tabInfo` is a factory: the seat calls it with the occurrence
 * and the returned function is the component's `useTabInfo`. That package
 * ships no types and is not a workspace dependency, so the contract is
 * restated here. The body's hook context is supplied by the seat, not by
 * this registration.
 *
 * `sessionId` and `useSessions` come from the session standard kit, merged by
 * `@deepseek-ai/dsh-client-ui-session`. This module imports that package's
 * client entry for the merge and does not restate the kit.
 */
declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    'sidebar.right.pane.tab': {
      kind: 'keyed'
      scope: 'session'
      keyProps: Record<string, object>
      hookContext: unknown
      inject: { hooks: { tabInfo: (standard: object, hookContext: unknown) => () => GitTabInfo } }
    }
    'sidebar.right.pane.tab.title': {
      kind: 'keyed'
      scope: 'session'
      keyProps: Record<string, object>
      hookContext: unknown
      inject: { hooks: { tabInfo: (standard: object, hookContext: unknown) => () => GitTabInfo } }
    }
  }

  interface LocaleNamespaceMap {
    git: GitKey
  }
}

export type GitPanelProps =
  PropsRuntime<'sidebar.right.pane.tab'>
  & PropsLocale<'git'>

export type GitTitleProps = PropsRuntime<'sidebar.right.pane.tab.title'>

/** `idle` covers the moment before the first read. */
type PanelState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'loading' }
  | { readonly kind: 'ready'; readonly status: GitStatus }
  | { readonly kind: 'failed'; readonly message: string }

export function GitPanel({ t, sessionId, useSessions }: GitPanelProps): ReactNode {
  const cwd = useSessions((state) => state.byId[sessionId]?.cwd)
  const [panel, setPanel] = useState<PanelState>({ kind: 'idle' })
  const [message, setMessage] = useState('')
  const [pending, setPending] = useState(false)
  const [drafting, setDrafting] = useState<GitMessageLanguage | null>(null)
  const [notice, setNotice] = useState<{ text: string; failed: boolean } | null>(null)
  const stopDraft = useRef<(() => void) | null>(null)
  const stopStatus = useRef<(() => void) | null>(null)

  const load = useCallback((root: string) => {
    stopStatus.current?.()
    const controller = new AbortController()
    stopStatus.current = () => { controller.abort() }
    setPanel((current) => current.kind === 'ready' ? current : { kind: 'loading' })
    void readWorkspaceStatus(root, controller.signal).then((result) => {
      if (controller.signal.aborted) return
      setPanel(result.ok
        ? { kind: 'ready', status: result.status }
        : { kind: 'failed', message: result.message ?? t('panel.notRepository') })
    })
  }, [t])

  useEffect(() => {
    if (cwd !== undefined && cwd !== '') load(cwd)
    return () => { stopStatus.current?.() }
  }, [cwd, load])

  useEffect(() => () => { stopDraft.current?.() }, [])

  const draft = useCallback((language: GitMessageLanguage) => {
    if (cwd === undefined || cwd === '' || drafting !== null || pending) return
    const controller = new AbortController()
    stopDraft.current = () => { controller.abort() }
    setDrafting(language)
    setNotice(null)
    void draftWorkspaceMessage(cwd, language, sessionId, controller.signal).then((result) => {
      if (controller.signal.aborted) return
      stopDraft.current = null
      setDrafting(null)
      if (!result.ok) {
        setNotice({ text: result.message ?? t('draft.failed'), failed: true })
        return
      }
      setMessage(result.message)
    })
  }, [cwd, drafting, pending, sessionId, t])

  const commit = useCallback(() => {
    if (cwd === undefined || cwd === '' || message.trim() === '' || pending) return
    setPending(true)
    setNotice(null)
    void commitWorkspace(cwd, message).then((result) => {
      setPending(false)
      if (!result.ok) {
        setNotice({ text: result.message ?? t('panel.notRepository'), failed: true })
        return
      }
      setMessage('')
      setNotice({ text: t('commit.done').replace('{hash}', result.hash), failed: false })
      load(cwd)
    })
  }, [cwd, message, pending, t, load])

  if (cwd === undefined || cwd === '') return <p className={css.note}>{t('panel.noWorkspace')}</p>
  if (panel.kind === 'failed') return <p className={css.note}>{panel.message}</p>

  const status = panel.kind === 'ready' ? panel.status : null
  const branch = status === null ? t('panel.loading') : (status.branch ?? t('panel.detached'))
  return (
    <div className={css.root}>
      <div className={css.branch}>
        <IconBranchOutlineRegular size={14} />
        <span className={css.branchName}>{branch}</span>
      </div>
      <CommitBox
        message={message}
        pending={pending}
        drafting={drafting}
        disabled={pending || drafting !== null || status === null}
        notice={notice}
        t={t}
        onChange={setMessage}
        onDraft={draft}
        onSubmit={commit}
      />
      {status === null
        ? <p className={css.note}>{t('panel.loading')}</p>
        : <ChangeTree changes={status.changes} t={t} />}
    </div>
  )
}

export function GitTitle({ useTabInfo }: GitTitleProps): ReactNode {
  const { tab } = useTabInfo()
  return (
    <>
      <IconBranchOutlineRegular size={16} className={css.titleIcon} />
      {tab.title}
    </>
  )
}
