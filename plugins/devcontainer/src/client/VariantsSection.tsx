/**
 * The Dev Container variants page: two independent tracks, one checkbox per
 * source preset on each.
 *
 * A checkbox, not a dropdown, because each track is a SET rather than one
 * choice, and `Checkbox` is the primitive the shipped settings rows already use
 * for the same shape. Checked means "derive my copy on this track".
 *
 * The row's tail carries the truth from the Host: a checked box whose variant is
 * not in the roster yet says so (`pendingBadge`), and a preset the registry could
 * not mount says so too (`brokenBadge`) — its variant could not mount either, so
 * it is offered read-only rather than stranding the person with a pending row.
 */
import { useEffect, useState, type ReactNode } from 'react'
import { Button, Checkbox, Input, Tag } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { variantNameSuffixOf, type VariantKind } from '../ids.ts'
import type { VariantRow, VariantsFace, VariantsState } from './controller.ts'
import { selectable } from './variants.ts'
import type { DevcontainerVariantsKey } from './locales.ts'

export type DevcontainerVariantsSectionProps =
  PropsRuntime<'settings.section'>
  & PropsLocale<'devcontainer'>
  & InjectFace<VariantsFace>

/** The translating seat the section and its track groups receive. */
type Translate = DevcontainerVariantsSectionProps['t']

/** The dictionary keys one track reads for its own copy. */
interface TrackCopy {
  readonly title: DevcontainerVariantsKey
  readonly description: DevcontainerVariantsKey
  readonly empty: DevcontainerVariantsKey
  readonly none: DevcontainerVariantsKey
  readonly count: DevcontainerVariantsKey
}

/** Copy per track: the two groups differ only in their words and their suffix. */
const COPY: Record<VariantKind, TrackCopy> = {
  devcontainer: {
    title: 'devcontainerTitle',
    description: 'devcontainerDescription',
    empty: 'empty',
    none: 'noneChecked',
    count: 'checkedCount',
  },
  sbx: {
    title: 'sbxTitle',
    description: 'sbxDescription',
    empty: 'sbxEmpty',
    none: 'sbxNoneChecked',
    count: 'sbxCheckedCount',
  },
}

/** One track's rendered rows and the toggle they call. */
interface TrackInput {
  readonly kind: VariantKind
  readonly rows: VariantsState['rows']
  readonly checkedCount: number
  readonly disabled: boolean
  readonly onToggle: (id: string, checked: boolean) => void
}

/**
 * Render the selectable presets on both tracks, each with one derivation toggle
 * per row.
 * @param props - settings actions, the page snapshot hook, and localized copy.
 * @returns The Dev Container variants settings section.
 */
export function DevcontainerVariantsSection(props: DevcontainerVariantsSectionProps): ReactNode {
  const { t, load } = props
  const state = props.useDevcontainerVariants(snapshot => snapshot)
  useEffect(() => { void load() }, [load])
  // A write in flight does not lock the rows: the controller queues a toggle that
  // lands mid-write, so a person checking several rows keeps every click.
  const disabled = !state.writable
  return (
    <section className="dcv-section">
      <h2 className="dcv-title">{t('nav')}</h2>
      <p className="dcv-intro">{t('intro')}</p>
      {state.failure === 'load'
        ? (
          <p className="dcv-notice" data-failed="true" role="alert">
            {t('failed')}{' '}
            <Button variant="ghost" disabled={disabled} onClick={() => { void load() }}>{t('retry')}</Button>
          </p>
        )
        : null}
      {state.failure === 'write'
        ? <p className="dcv-notice" data-failed="true" role="alert">{t('writeFailed')}</p>
        : null}
      {state.status === 'unavailable' ? <p className="dcv-notice">{t('unavailable')}</p> : null}
      {state.status === 'loading' ? <p className="dcv-notice" role="status">{t('loading')}</p> : null}
      {state.status === 'ready' && !state.writable ? <p className="dcv-notice">{t('readOnly')}</p> : null}
      {state.status === 'ready'
        ? (
          <>
            {renderTrack(t, {
              kind: 'devcontainer',
              rows: state.rows,
              checkedCount: state.checkedCount,
              disabled,
              onToggle: (id, checked) => { props.setChecked(id, checked) },
            })}
            {renderTrack(t, {
              kind: 'sbx',
              rows: state.sbxRows,
              checkedCount: state.sbxCheckedCount,
              disabled,
              // The sbx box renders the effective list, so flipping it is the
              // whole intent: the controller derives the target state itself.
              onToggle: (id) => { props.toggleSbxSource(id) },
            })}
            <SandboxImageField
              t={t}
              value={state.sbxTemplate}
              invalid={state.failure === 'template'}
              disabled={disabled}
              onSave={props.setSbxTemplate}
            />
            <p className="dcv-notice">{t('refreshHint')}</p>
          </>
        )
        : null}
    </section>
  )
}

/**
 * The image a created Docker Sandbox runs (`sbxTemplate`), as one text field.
 *
 * The box holds a local draft and writes on blur or Enter, so an unfinished value —
 * a leading `-`, a half-typed registry — is never sent; the value it shows reverts to
 * the stored one whenever no draft is in progress, which keeps a write from another
 * editor visible without an effect mirroring state.
 */
function SandboxImageField(props: {
  readonly t: Translate
  readonly value: string
  readonly invalid: boolean
  readonly disabled: boolean
  readonly onSave: (next: string) => void
}): ReactNode {
  const { t, value, invalid, disabled, onSave } = props
  const [draft, setDraft] = useState<string | null>(null)
  const commit = (): void => {
    if (draft === null) return
    onSave(draft)
    setDraft(null)
  }
  return (
    <div className="dcv-group" data-image="true">
      <label className="dcv-group-title" htmlFor="dcv-sbx-template">{t('imageTitle')}</label>
      <Input
        id="dcv-sbx-template"
        className="dcv-image-input"
        value={draft ?? value}
        disabled={disabled}
        placeholder={t('imagePlaceholder')}
        spellCheck={false}
        autoComplete="off"
        onChange={(event) => { setDraft(event.target.value) }}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key !== 'Enter') return
          event.preventDefault()
          commit()
        }}
      />
      <p className="dcv-group-description">{t('imageDescription')}</p>
      {invalid
        ? <p className="dcv-notice" data-failed="true" role="alert">{t('imageInvalid')}</p>
        : null}
    </div>
  )
}

/**
 * One track's card: its heading with the preset-name suffix, what the track is,
 * how much of it is derived, and the rows themselves.
 * @param t - the localized copy seat.
 * @param input - the track, its rows, and its toggle.
 * @returns The rendered group.
 */
function renderTrack(t: Translate, input: TrackInput): ReactNode {
  const copy = COPY[input.kind]
  return (
    <div className="dcv-group" data-track={input.kind}>
      <h3 className="dcv-group-title">
        {t(copy.title)}
        <code className="dcv-suffix">{variantNameSuffixOf(input.kind).trim()}</code>
      </h3>
      <p className="dcv-group-description">{t(copy.description)}</p>
      <p className="dcv-count">
        {input.rows.length === 0
          ? t(copy.empty)
          : input.checkedCount === 0 ? t(copy.none) : t(copy.count, { count: input.checkedCount })}
      </p>
      {input.rows.length === 0 ? null : (
        <ul className="dcv-rows">
          {input.rows.map(row => renderRow(t, input.kind, row, input.disabled, input.onToggle))}
        </ul>
      )}
    </div>
  )
}

/**
 * One preset row: the checkbox, the preset's own description, and the Host's
 * verdict on this track's variant.
 * @param t - the localized copy seat.
 * @param kind - the derivative track this row belongs to.
 * @param row - the row to render.
 * @param disabled - whether the deployment refuses writes.
 * @param onToggle - the toggle for this row.
 * @returns The rendered row.
 */
function renderRow(
  t: Translate,
  kind: VariantKind,
  row: VariantRow,
  disabled: boolean,
  onToggle: (id: string, checked: boolean) => void,
): ReactNode {
  const broken = row.broken !== undefined
  return (
    <li
      key={row.id}
      className="dcv-row"
      data-checked={row.checked ? 'true' : undefined}
      data-broken={broken ? 'true' : undefined}
    >
      <span className="dcv-main">
        <Checkbox
          checked={row.checked}
          disabled={disabled || !selectable(row)}
          label={row.name}
          title={broken
            ? `${t('brokenBadge')}: ${row.broken ?? ''}`
            : row.variantBroken === undefined
              ? t(row.checked ? 'checked' : 'unchecked')
              : `${t('variantBrokenBadge')}: ${row.variantBroken}`}
          onChange={(next) => { onToggle(row.id, next) }}
        />
        {row.description === '' ? null : (
          // Both tracks list the same preset ids, so the anchor carries the track.
          <span className="dcv-description" id={`dcv-description-${kind}-${row.id}`}>{row.description}</span>
        )}
      </span>
      <span className="dcv-tail">
        {row.name === row.id ? null : <code className="dcv-id">{row.id}</code>}
        {broken ? <Tag tone="danger">{t('brokenBadge')}</Tag> : null}
        {row.checked
          ? row.variantBroken === undefined
            ? <Tag tone={row.derived ? 'success' : 'warning'}>{t(row.derived ? 'derivedBadge' : 'pendingBadge')}</Tag>
            : <Tag tone="danger">{t('variantBrokenBadge')}</Tag>
          : null}
        <span className="dcv-state" data-checked={row.checked ? 'true' : undefined}>
          {t(row.checked ? 'checked' : 'unchecked')}
        </span>
      </span>
    </li>
  )
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    devcontainer: DevcontainerVariantsKey
  }
}
