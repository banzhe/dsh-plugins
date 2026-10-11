import { useLayoutEffect, useRef, type ReactNode } from 'react'
import { Button, StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import type { GitMessageLanguage } from '../shared.ts'
import type { GitKey } from './locales.ts'
import css from './panel.module.css'

/**
 * The commit message field. A textarea, because a single-line input drops
 * newlines. Its height follows the text up to the cap in the stylesheet,
 * after which it scrolls. Enter submits; Shift+Enter breaks the line.
 */
function MessageField({ value, label, placeholder, disabled, onChange, onSubmit }: {
  value: string
  label: string
  placeholder: string
  disabled: boolean
  onChange: (value: string) => void
  onSubmit: () => void
}): ReactNode {
  const ref = useRef<HTMLTextAreaElement>(null)
  useLayoutEffect(() => {
    const node = ref.current
    if (node === null) return
    const fit = (): void => {
      node.style.height = 'auto'
      node.style.height = `${node.scrollHeight + node.offsetHeight - node.clientHeight}px`
    }
    fit()
    const observer = new ResizeObserver(fit)
    observer.observe(node)
    return () => { observer.disconnect() }
  }, [value])
  return (
    <textarea
      ref={ref}
      rows={1}
      className={css.message}
      aria-label={label}
      placeholder={placeholder}
      value={value}
      disabled={disabled}
      onChange={(event) => { onChange(event.currentTarget.value) }}
      onKeyDown={(event) => {
        const composing = event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229
        if (event.key !== 'Enter' || event.shiftKey || composing) return
        event.preventDefault()
        onSubmit()
      }}
    />
  )
}

/** The message, the two draft buttons, and the button that commits it. The commit stays at the top corner. */
export function CommitBox({ message, pending, drafting, disabled, notice, t, onChange, onDraft, onSubmit }: {
  message: string
  pending: boolean
  /** The language whose button is drafting, or null while neither is. */
  drafting: GitMessageLanguage | null
  disabled: boolean
  notice: { text: string; failed: boolean } | null
  t: (key: GitKey) => string
  onChange: (message: string) => void
  onDraft: (language: GitMessageLanguage) => void
  onSubmit: () => void
}): ReactNode {
  return (
    <>
      <form
        className={css.commit}
        onSubmit={(event) => {
          event.preventDefault()
          onSubmit()
        }}
      >
        <MessageField
          value={message}
          label={t('commit.label')}
          placeholder={t('commit.placeholder')}
          disabled={disabled}
          onChange={onChange}
          onSubmit={onSubmit}
        />
        <div className={css.actions}>
          <DraftButton language="zh" label={t('draft.zh')} drafting={drafting} disabled={disabled} onDraft={onDraft} />
          <DraftButton language="en" label={t('draft.en')} drafting={drafting} disabled={disabled} onDraft={onDraft} />
          <Button type="submit" variant="primary" size="sm" disabled={disabled || message.trim() === ''}>
            {t(pending ? 'commit.pending' : 'commit.action')}
          </Button>
        </div>
      </form>
      {notice === null
        ? null
        : <p className={css.notice} role="status" data-failed={notice.failed ? '' : undefined}>{notice.text}</p>}
    </>
  )
}

/** One language's draft button. While it drafts, its label gives way to the spinner. */
function DraftButton({ language, label, drafting, disabled, onDraft }: {
  language: GitMessageLanguage
  label: string
  drafting: GitMessageLanguage | null
  disabled: boolean
  onDraft: (language: GitMessageLanguage) => void
}): ReactNode {
  const active = drafting === language
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      className={css.draft}
      disabled={disabled}
      aria-busy={active}
      onClick={() => { onDraft(language) }}
    >
      {active
        ? <StateDot state="ongoing" size={14} className={css.drafting} />
        : label}
    </Button>
  )
}
