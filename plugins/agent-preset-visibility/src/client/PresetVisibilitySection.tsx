/**
 * The preset-visibility page: one checkbox per declared preset.
 *
 * A checkbox, not the shell's dropdown, because this is a SET rather than one
 * choice, and `Checkbox` is the primitive the shipped settings rows already use
 * for the same shape. Checked means "shown", which is what a person is choosing:
 * clearing a row hides it.
 *
 * The page lists a hidden preset deliberately — it reads the roster before this
 * plugin filters it — so hiding is always reversible here, and this page is the
 * only place a hidden row still appears.
 */
import { useEffect, type ReactNode } from 'react'
import { Button, Checkbox, Tag } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { PresetVisibilityFace } from './controller.ts'
import type { PresetVisibilityKey } from './locales.ts'

export type PresetVisibilitySectionProps =
  PropsRuntime<'settings.section'>
  & PropsLocale<'agent-preset-visibility'>
  & InjectFace<PresetVisibilityFace>

/**
 * Render the roster with one visibility toggle per row.
 * @param props - settings actions, the page snapshot hook, and localized copy.
 * @returns The preset-visibility settings section.
 */
export function PresetVisibilitySection(props: PresetVisibilitySectionProps): ReactNode {
  const { t, load } = props
  const state = props.usePresetVisibility(snapshot => snapshot)
  useEffect(() => { void load() }, [load])
  // A write in flight does not lock the rows: the controller queues a toggle that
  // lands mid-write, so a person clearing several rows in a row keeps every click.
  const disabled = !state.writable
  return (
    <section className="apv-section">
      <h2 className="apv-title">{t('nav')}</h2>
      <p className="apv-intro">{t('intro')}</p>
      {state.failure === 'load'
        ? (
          <p className="apv-notice" data-failed="true" role="alert">
            {t('failed')}{' '}
            <Button variant="ghost" disabled={disabled} onClick={() => { void load() }}>{t('retry')}</Button>
          </p>
        )
        : null}
      {state.failure === 'write'
        ? <p className="apv-notice" data-failed="true" role="alert">{t('writeFailed')}</p>
        : null}
      {state.status === 'unavailable' ? <p className="apv-notice">{t('unavailable')}</p> : null}
      {state.status === 'loading' ? <p className="apv-notice" role="status">{t('loading')}</p> : null}
      {state.status === 'ready' && !state.writable ? <p className="apv-notice">{t('readOnly')}</p> : null}
      {state.status === 'ready'
        ? (
          <>
            <p className="apv-count">
              {state.hiddenCount === 0 ? t('allShown') : t('hiddenCount', { count: state.hiddenCount })}
            </p>
            <ul className="apv-rows">
              {state.rows.map(row => (
                <li key={row.id} className="apv-row" data-hidden={row.hidden ? 'true' : undefined}>
                  <Checkbox
                    checked={!row.hidden}
                    disabled={disabled}
                    label={row.name}
                    title={t(row.hidden ? 'hidden' : 'shown')}
                    onChange={(next) => { props.setHidden(row.id, !next) }}
                  />
                  <span className="apv-tail">
                    {row.name === row.id ? null : <code className="apv-id">{row.id}</code>}
                    {row.isDefault ? <Tag tone="solid">{t('defaultBadge')}</Tag> : null}
                    {row.broken ? <Tag tone="danger">{t('brokenBadge')}</Tag> : null}
                    <span className="apv-state" data-hidden={row.hidden ? 'true' : undefined}>
                      {t(row.hidden ? 'hidden' : 'shown')}
                    </span>
                  </span>
                </li>
              ))}
            </ul>
            <p className="apv-notice">{t('refreshHint')}</p>
          </>
        )
        : null}
    </section>
  )
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    'agent-preset-visibility': PresetVisibilityKey
  }
}
