/**
 * The row-configuration page for this plugin: which model writes session
 * titles, and at what reasoning effort.
 *
 * Two native selects rather than the shared text-field controls: both choose
 * from a closed set the Host publishes (adapter routes, and the effort levels
 * the chosen model supports), and a free-text model id is a value the LLM seam
 * rejects with `UNKNOWN_MODEL` before it ever reaches a provider. Selecting a
 * route from the live directory is the only way to choose one known to be
 * callable.
 *
 * Styling is inline: this Bundle ships no stylesheet, matching the workspace's
 * other plugins, which render through `ui-primitives` alone. The two selects are
 * native controls so they keep the shell's own form styling and accessibility.
 */

import { useId, type CSSProperties } from 'react'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: the `plugins.row.config` SlotMap entry this component's props compose from.
import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import { SettingsForm } from '@deepseek-ai/dsh-client-ui-primitives'
import { formLabels, type TitleModelLocaleKey } from './locales.ts'
import type { TitleModelCandidate, TitleModelCardFace } from './controller.ts'
import { titleRouteKey } from './controller.ts'

/** Props the Plugins page binds for this row's configuration page. */
export type TitleModelCardProps =
  PropsRuntime<'plugins.row.config'>
  & PropsLocale<'session-title-rules'>
  & InjectFace<TitleModelCardFace>

/** One provider's selectable routes, in directory order. */
interface ProviderGroup {
  readonly provider: string
  readonly providerName: string
  readonly candidates: TitleModelCandidate[]
}

/** Lay out one label + control + hint block. */
const FIELD: CSSProperties = { display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 16 }
/** Keep the selects inside the page's content column. */
const SELECT: CSSProperties = { width: '100%', maxWidth: 420, padding: '6px 8px', font: 'inherit' }
/** De-emphasize explanatory copy. */
const HINT: CSSProperties = { margin: 0, fontSize: 12, opacity: 0.7 }

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

/**
 * Render the title-model form, or its one-liner when the page asks for a summary.
 * @param props - the view asked for, locale copy, the card snapshot, and its actions.
 * @returns the summary line, or the settings form.
 */
export function TitleModelCard(props: TitleModelCardProps) {
  const { t } = props
  const state = props.useTitleModelCard(snapshot => snapshot)
  const modelId = useId()
  const effortId = useId()
  if (props.view === 'summary') return t('description')

  const disabled = !state.writable || state.saving
  const groups = groupByProvider(state.candidates)
  const unavailable = state.candidates.find(candidate => !candidate.available)
  const selectedKey = state.route === undefined ? '' : titleRouteKey(state.route)
  const chosen = state.candidates.find(candidate => candidate.key === selectedKey)
  // With a route pinned, offer exactly the levels that model advertises. While
  // following the session's own route the model varies per session, so no single
  // list is correct: offer every level the directory advertises anywhere, and
  // keep a stored level visible even if nothing advertises it now. The Host
  // applies this effort on either route, so leaving the control enabled here
  // matches what a save actually does.
  const advertised = state.route === undefined
    ? [...new Set(state.candidates.flatMap(candidate => candidate.efforts))]
    : chosen?.efforts ?? []
  const effortChoices = state.effort !== undefined && !advertised.includes(state.effort)
    ? [...advertised, state.effort]
    : advertised

  return (
    <SettingsForm labels={formLabels(t)} state={state} onSave={props.save} onDiscard={props.discard}>
      <div style={FIELD}>
        <label htmlFor={modelId}>{t('modelLabel')}</label>
        <select
          id={modelId}
          style={SELECT}
          value={selectedKey}
          disabled={disabled}
          onChange={(event) => {
            props.selectRoute(event.target.value === '' ? undefined : event.target.value)
          }}
        >
          <option value="">{t('modelInherited')}</option>
          {groups.map(group => (
            <optgroup key={group.provider} label={group.providerName}>
              {group.candidates.map(candidate => (
                <option key={candidate.key} value={candidate.key}>{candidate.modelName}</option>
              ))}
            </optgroup>
          ))}
          {unavailable === undefined ? null : (
            <optgroup label={t('unavailableRoute')}>
              <option value={unavailable.key}>{unavailable.modelName}</option>
            </optgroup>
          )}
        </select>
        <p style={HINT}>{t('modelHint')}</p>
      </div>

      <div style={FIELD}>
        <label htmlFor={effortId}>{t('effortLabel')}</label>
        <select
          id={effortId}
          style={SELECT}
          value={state.effort ?? ''}
          disabled={disabled}
          onChange={(event) => {
            props.selectEffort(event.target.value === '' ? undefined : event.target.value)
          }}
        >
          <option value="">{t('effortInherited')}</option>
          {effortChoices.map(effort => <option key={effort} value={effort}>{effort}</option>)}
        </select>
        <p style={HINT}>{t('effortHint')}</p>
      </div>

      {state.catalogStatus === 'loading'
        ? <p style={HINT} role="status">{t('catalogLoading')}</p>
        : null}
      {state.catalogStatus === 'error'
        ? (
          <p style={HINT} role="alert">
            {t('catalogFailed')}{' '}
            <button type="button" disabled={state.saving} onClick={props.retryCatalog}>{t('catalogRetry')}</button>
          </p>
        )
        : null}
      {state.catalogPartial ? <p style={HINT}>{t('catalogPartial')}</p> : null}
      {state.catalogStatus === 'ready' && groups.length === 0
        ? <p style={HINT}>{t('catalogEmpty')}</p>
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
