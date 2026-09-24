/**
 * The row-configuration page for this plugin: which model writes session
 * titles, and at what reasoning effort.
 *
 * Both choices render as the shell's own settings dropdown — a pill trigger
 * that opens the shared `Menu` — rather than a native `<select>`. That is not
 * cosmetic: a native select's popup is drawn by the operating system, so it can
 * never carry the theme, and the checkmarked card the General settings show
 * ("工作过程展示", "性能与用量") is reachable only through `Menu`. A free-text
 * model id is in any case a value the LLM seam rejects with `UNKNOWN_MODEL`
 * before it reaches a provider, so both controls choose from a closed set the
 * Host publishes: selecting a route from the live directory is the only way to
 * choose one known to be callable.
 *
 * Styling rides the injected token sheet in `styles.ts`, not inline styles: the
 * shell's controls are styled by class, so a control carrying an inline `style`
 * attribute can never match them. `Menu` needs nothing from that sheet — it is a
 * `ui-primitives` value import and brings its own.
 */

import { useRef, useState } from 'react'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: the `plugins.row.config` SlotMap entry this component's props compose from.
import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import {
  IconChevronDownOutlineRegular, Menu, SettingsForm, type MenuEntry,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { formLabels, type TitleModelLocaleKey } from './locales.ts'
import type { TitleModelCandidate, TitleModelCardFace } from './controller.ts'
import { titleRouteKey } from './controller.ts'

/** Props the Plugins page binds for this row's configuration page. */
export type TitleModelCardProps =
  PropsRuntime<'plugins.row.config'>
  & PropsLocale<'session-title-rules'>
  & InjectFace<TitleModelCardFace>

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

/**
 * Group the flat candidate list by provider, keeping directory order.
 * @param candidates - rows joined from the live directory and the stored route.
 * @returns one group per provider, unavailable rows excluded.
 */
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

/** One labelled row: title, description, and the dropdown that edits it. */
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

/**
 * Render the title-model form, or its one-liner when the page asks for a summary.
 * @param props - the view asked for, locale copy, the card snapshot, and its actions.
 * @returns the summary line, or the settings form.
 */
export function TitleModelCard(props: TitleModelCardProps) {
  const { t } = props
  const state = props.useTitleModelCard(snapshot => snapshot)
  if (props.view === 'summary') return t('description')

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
  )
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** This plugin's settings page copy. */
    'session-title-rules': TitleModelLocaleKey
  }
}
