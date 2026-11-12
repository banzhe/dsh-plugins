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
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { Notice } from './noticeStore.ts'
import { NS } from './locales.ts'

/**
 * The `shell.overlay` seat, restated for this package's own type check.
 *
 * ui-layout owns this key and declares it as `{ kind: 'list'; scope: 'root' }`.
 * ui-layout is not a dependency of this Bundle, so the owner's declaration is
 * repeated here verbatim; without it neither `PropsRuntime<'shell.overlay'>`
 * below nor `ctx.slots.register({ name: 'shell.overlay', … })` can resolve.
 */
declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    'shell.overlay': { kind: 'list'; scope: 'root' }
  }
}

/** Business face of the notice overlay, closed over the plugin's notice store. */
export interface NoticeToastInjected {
  hooks: {
    /** The pending notice; null while nothing is pending. */
    notice: ObservableSnapshot<Notice | null>
  }
  /** Report the fade of the notice shown under one sequence. */
  dismiss: (seq: number) => void
}

/** Complete props of the notice overlay entry. */
export type NoticeToastProps =
  PropsRuntime<'shell.overlay'>
  & PropsLocale<typeof NS>
  & InjectFace<NoticeToastInjected>

/**
 * Render the pending notice, or nothing.
 * @param props.useNotice - selector hook over the pending notice.
 * @param props.dismiss - report the fade of the notice shown under one sequence.
 * @returns the banner, or null while no notice is pending.
 */
export function NoticeToast({ useNotice, dismiss }: NoticeToastProps): ReactNode {
  const notice = useNotice(current => current)
  if (notice === null) return null
  return (
    <Toast
      key={notice.seq}
      text={notice.text}
      onDone={() => { dismiss(notice.seq) }}
    />
  )
}
