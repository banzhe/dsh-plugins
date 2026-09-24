/**
 * The `shell.overlay` entry for this plugin's notices: the shipped `Toast`
 * primitive driven by the plugin's notice store, exactly as the shipped
 * Workspace row-toast entry is driven by its own.
 *
 * The component renders nothing while no notice is pending, so an idle page
 * contributes an empty entry. When one is pending it mounts `Toast` under a
 * `key` of the notice's `seq`: a repeat of the same text is a NEW showing and
 * must restart the banner's hold rather than extend the previous one, and the
 * primitive only restarts on remount. `onDone` fires after the fade, which is
 * when the store drops the notice and this entry unmounts.
 */
import { Toast } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ReactNode } from 'react'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { Notice } from './noticeStore.ts'

/**
 * The `shell.overlay` seat, restated for this package's own type check.
 *
 * ui-layout owns this key and declares it as `{ kind: 'list'; scope: 'root' }`:
 * a frame-wide list slot above every column, additive (a fresh `id` sits beside
 * the shipped entries) and click-through until an entry opts into pointer
 * events. ui-layout is NOT reachable from this standalone plugin — the
 * workspace catalog has no entry for `@deepseek-ai/dsh-client-ui-layout` and
 * the package is not installed — so the owner's contract is restated here
 * verbatim. Without it neither `PropsRuntime<'shell.overlay'>` below nor
 * `ctx.slots.register({ name: 'shell.overlay', … })` can resolve, because both
 * are constrained to `keyof SlotMap`. If ui-layout is ever added as a
 * dependency, this declaration is textually identical to the owner's and
 * merges with it.
 */
declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    /** Frame-wide floating layer above every column; entries order among themselves. */
    'shell.overlay': { kind: 'list'; scope: 'root' }
  }
}

/** Business face the plugin injects into the entry: the pending notice and how to drop it. */
export interface NoticeToastInjected {
  /** The notice on display, or null. Bound to the plugin's store during render. */
  useNotice: () => Notice | null
  /**
   * Take the notice shown under `seq` down.
   * @param seq - the showing that finished fading.
   */
  dismiss: (seq: number) => void
}

/** Full component props: runtime share + locale seat + injected business face. */
export type NoticeToastProps =
  PropsRuntime<'shell.overlay'>
  & PropsLocale<'menu-actions'>
  & InjectFace<NoticeToastInjected>

/**
 * Render the pending notice.
 * @param props - composed slot props (the store hook and its dismissal).
 * @returns the floating banner, or null while nothing is pending.
 */
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
