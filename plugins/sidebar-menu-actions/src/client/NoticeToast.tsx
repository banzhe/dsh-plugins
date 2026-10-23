/**
 * The `shell.overlay` entry for this plugin's notices: the shipped `Toast`
 * primitive driven by the plugin's notice store.
 *
 * The component renders nothing while no notice is pending. When one is pending
 * it mounts `Toast` under a `key` of the notice's `seq`: a repeat of the same
 * text is a NEW showing and must restart the banner's hold rather than extend
 * the previous one, and the primitive only restarts on remount.
 */
import { Toast } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ReactNode } from 'react'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { Notice } from './noticeStore.ts'

/**
 * The `shell.overlay` seat, restated for this package's own type check.
 *
 * ui-layout owns this key and declares it as `{ kind: 'list'; scope: 'root' }`.
 * ui-layout is NOT reachable from this standalone plugin — the workspace catalog
 * has no entry for it and the package is not installed — so the owner's contract
 * is restated here verbatim. Without it neither `PropsRuntime<'shell.overlay'>`
 * below nor `ctx.slots.register({ name: 'shell.overlay', … })` can resolve,
 * because both are constrained to `keyof SlotMap`. If ui-layout is ever added as
 * a dependency, this declaration merges with the owner's.
 */
declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    'shell.overlay': { kind: 'list'; scope: 'root' }
  }
}

export interface NoticeToastInjected {
  useNotice: () => Notice | null
  dismiss: (seq: number) => void
}

export type NoticeToastProps =
  PropsRuntime<'shell.overlay'>
  & PropsLocale<'menu-actions'>
  & InjectFace<NoticeToastInjected>

export function NoticeToast({ useNotice, dismiss }: NoticeToastProps): ReactNode {
  const notice = useNotice()
  if (notice === null) return null
  return (
    <Toast
      key={notice.seq}
      text={notice.text}
      onDone={() => { dismiss(notice.seq) }}
    />
  )
}
