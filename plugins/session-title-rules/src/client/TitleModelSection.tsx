/**
 * The Session title settings section: which model writes session titles, and at
 * what reasoning effort.
 *
 * Both choices render as the shell's own settings dropdown — a pill trigger that
 * opens the shared `Menu` — rather than a native `<select>`. That is not
 * cosmetic: a native select's popup is drawn by the operating system, so it can
 * never carry the theme, and the checkmarked card the General settings show is
 * reachable only through `Menu`. A free-text model id is in any case a value the
 * LLM seam rejects with `UNKNOWN_MODEL`, so both controls choose from a closed
 * set the Host publishes.
 *
 * Styling rides the injected token sheet in `title-model.css`, not inline styles:
 * the shell's controls are styled by class, so a control carrying an inline
 * `style` attribute can never match them. `Menu` brings its own sheet.
 */

import { useRef, useState } from 'react'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: the `settings.section` and `settings.section.icon` SlotMap entries these props compose from.
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import {
  IconChevronDownOutlineRegular, IconListPenOutlineMedium, Menu, SettingsForm, type MenuEntry,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { formLabels, type TitleModelLocaleKey } from './locales.ts'
import type { TitleModelCandidate, TitleModelSectionFace } from './controller.ts'
import { titleRouteKey } from './controller.ts'

export type TitleModelSectionProps =
  PropsRuntime<'settings.section'>
  & PropsLocale<'session-title-rules'>
  & InjectFace<TitleModelSectionFace>

/**
 * Menu ids for the two "inherit" choices. Both carry a NUL, which a route key
 * (`<len>:<provider><model>`, always digit-leading) and a reasoning-effort id
 * can never contain, so neither can be mistaken for a real value.
 */
const INHERIT_ID = '\u0000inherit'
const EFFORT_DEFAULT_ID = '\u0000effort-default'

/** One provider's selectable routes, in directory order. */
interface ProviderGroup {
  readonly provider: string
  readonly providerName: string
  readonly candidates: TitleModelCandidate[]
}

function groupByProvider(candidates: readonly TitleModelCandidate[]): ProviderGroup[] {
  const groups: ProviderGroup[] = []
  for (const candidate of candidates) {
    if (!candidate.available) continue
    const found = groups.find(group => group.provider === candidate.provider)
    if (found === undefined) {
      groups.push({ provider: candidate.provider, providerName: candidate.providerName, candidates: [candidate] })
    } else {
      found.candidates.push(candidate)
    }
  }
  return groups
}

/**
 * Nav glyph for this section. The shell addresses it by the section id, so the
 * two registrations in `index.ts` must carry the same one.
 */
export function TitleModelSectionIcon({ size }: PropsRuntime<'settings.section.icon'>) {
  return <IconListPenOutlineMedium size={size} />
}

function PreferenceRow({ title, description, label, disabled, items, selectedId, onSelect }: {
  readonly title: string
  readonly description: string
  readonly label: string
  readonly disabled: boolean
  readonly items: readonly MenuEntry[]
  readonly selectedId: string
  readonly onSelect: (id: string) => void
}) {
  const [open, setOpen] = useState(false)
  const triggerRef = useRef<HTMLButtonElement>(null)
  return (
    <div className="str-row">
      <div className="str-rowText">
        <div className="str-title">{title}</div>
        <div className="str-desc">{description}</div>
      </div>
      <Menu
        open={open}
        items={items}
        selectedId={selectedId}
        align="end"
        portal
        onClose={() => { setOpen(false) }}
        onSelect={(id) => {
          // Match the reference row: hand the keyboard back before publishing,
          // so focus never lands on the body when the rows unmount.
          triggerRef.current?.focus({ preventScroll: true })
          setOpen(false)
          onSelect(id)
        }}
        anchor={(
          <button
            ref={triggerRef}
            type="button"
            className="str-trigger"
            aria-haspopup="menu"
            aria-expanded={open}
            // The visible text is the current value, so the row's own title has
            // to be named here; a screen reader would otherwise hear a model
            // name with nothing saying which setting it belongs to.
            aria-label={`${title}: ${label}`}
            disabled={disabled}
            onClick={() => { setOpen(value => !value) }}
          >
            <span className="str-triggerLabel">{label}</span>
            <IconChevronDownOutlineRegular className="str-chevron" />
          </button>
        )}
      />
    </div>
  )
}

export function TitleModelSection(props: TitleModelSectionProps) {
  const { t } = props
  const state = props.useTitleModelSection(snapshot => snapshot)

  const disabled = !state.writable || state.saving
  const groups = groupByProvider(state.candidates)
  const unavailable = state.candidates.find(candidate => !candidate.available)
  const selectedKey = state.route === undefined ? INHERIT_ID : titleRouteKey(state.route)
  const chosen = state.candidates.find(candidate => candidate.key === selectedKey)
  // Levels come from the controller's projection, which prunes a draft the
  // chosen model cannot take with the very same join.
  const chosenEffort = state.effortChoices.find(effort => effort.id === state.effort)

  // Each provider is a non-selectable heading, as an `<optgroup>` was.
  const modelItems: MenuEntry[] = [
    { id: INHERIT_ID, label: t('modelInherited') },
    ...groups.flatMap(group => [
      { type: 'label' as const, id: `provider:${group.provider}`, text: group.providerName },
      ...group.candidates.map(candidate => ({ id: candidate.key, label: candidate.modelName })),
    ]),
    ...unavailable === undefined
      ? []
      : [
        { type: 'label' as const, id: 'provider:unavailable', text: t('unavailableRoute') },
        { id: unavailable.key, label: unavailable.modelName },
      ],
  ]

  const effortItems: MenuEntry[] = [
    { id: EFFORT_DEFAULT_ID, label: t('effortInherited') },
    ...state.effortChoices.map(effort => ({ id: effort.id, label: effort.name })),
  ]

  return (
    <section className="str-section">
      <h2 className="str-heading">{t('nav')}</h2>
      <p className="str-intro">{t('description')}</p>

      <SettingsForm labels={formLabels(t)} state={state} onSave={props.save} onDiscard={props.discard}>
        <PreferenceRow
          title={t('modelLabel')}
          description={t('modelHint')}
          label={chosen?.modelName ?? t('modelInherited')}
          disabled={disabled}
          items={modelItems}
          selectedId={selectedKey}
          onSelect={(id) => { props.selectRoute(id === INHERIT_ID ? undefined : id) }}
        />

        <PreferenceRow
          title={t('effortLabel')}
          description={t('effortHint')}
          label={chosenEffort?.name ?? t('effortInherited')}
          disabled={disabled}
          items={effortItems}
          selectedId={state.effort ?? EFFORT_DEFAULT_ID}
          onSelect={(id) => { props.selectEffort(id === EFFORT_DEFAULT_ID ? undefined : id) }}
        />

        {state.catalogStatus === 'loading'
          ? <p className="str-notice" role="status">{t('catalogLoading')}</p>
          : null}
        {state.catalogStatus === 'error'
          ? (
            <p className="str-notice" data-failed="true" role="alert">
              {t('catalogFailed')}{' '}
              <button type="button" disabled={state.saving} onClick={props.retryCatalog}>{t('catalogRetry')}</button>
            </p>
          )
          : null}
        {state.catalogPartial ? <p className="str-notice">{t('catalogPartial')}</p> : null}
        {state.catalogStatus === 'ready' && groups.length === 0
          ? <p className="str-notice">{t('catalogEmpty')}</p>
          : null}
      </SettingsForm>
    </section>
  )
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    'session-title-rules': TitleModelLocaleKey
  }
}
