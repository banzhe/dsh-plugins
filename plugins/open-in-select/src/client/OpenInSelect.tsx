/**
 * The Session header's "open in…" control: one compact split button. *
 * The left half is icon-only and opens the Session's directory in the current
 * application, which the tooltip and the accessible name both state; the
 * chevron opens the list of applications the Host resolved, where a pick
 * launches that application and becomes the remembered one. With no
 * application resolved the control renders nothing, and with exactly one there
 * is nothing to choose, so no chevron.
 *
 * Every gesture is one launch request: a press while a request is in flight is
 * dropped and the buttons stay disabled until it settles, so the Host never
 * receives two launches from one control.
 */
import { useRef, useState } from 'react'
import type { ReactNode } from 'react'
import {
  Button, IconChevronDownOutlineRegular, IconRightUpOutlineRegular, Menu, Tooltip,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { InjectFace, PropsLocale, PropsRuntime, TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { refusalKey, type LaunchResult } from './api.ts'
import css from './control.module.css'
import { defaultApp, shouldRemember } from './choice.ts'
import { appLabel } from './labels.ts'
import { NS } from './locales.ts'

/** Business face the header control receives from the plugin body. */
export interface OpenInSelectInjected {
  hooks: {
    /** Installed application ids in Host order; empty until the Host answered. */
    openInSelectApps: ObservableSnapshot<readonly string[]>
    /** Remembered application id, empty before the first choice. */
    openInSelectChoice: ObservableSnapshot<string>
  }
  /** Launch one catalog application on a directory; host and transport failures resolve without rejecting. */
  launch: (appId: string, path: string) => Promise<LaunchResult>
  /** Remember one application id as the next default. */
  choose: (appId: string) => void
  /** Raise one user-visible notice, already localized. */
  report: (text: string) => void
  /** URL of one application's icon. */
  iconUrl: (appId: string) => string
}

/** Complete props of the header control, including the directory it opens. */
export type OpenInSelectProps =
  PropsRuntime<'conversation.session.header.utilities'>
  & InjectFace<OpenInSelectInjected>
  & PropsLocale<typeof NS>
  & { absolutePath: string }

/**
 * One application's icon, with a per-image fallback so a missing or broken icon
 * cannot affect the control's layout: the glyph it falls back to is the same
 * size as the image, and a different source gets its own attempt.
 * @param props.source - icon URL from the Host's icon route.
 * @returns the image, or the generic open glyph once that source failed to load.
 */
function AppIcon({ source }: { source: string }): ReactNode {
  const [failedSrc, setFailedSrc] = useState<string | null>(null)
  if (failedSrc === source) return <IconRightUpOutlineRegular size={14} />
  return (
    <img
      src={source} width={14} height={14} alt="" draggable={false}
      onError={() => { setFailedSrc(source) }}
    />
  )
}

/**
 * Copy for one settled launch that did not open anything. The statuses
 * distinguished here are the refusal set of the Host's `open-in-app/open` route; a status
 * this Bundle has no copy for falls back to showing the number.
 * @param t - this plugin's translate seat.
 * @param result - settled launch outcome.
 * @returns the notice text, or null when the application opened.
 */
function failureText(t: TranslateNS<typeof NS>, result: LaunchResult): string | null {
  if (result.kind === 'opened') return null
  if (result.kind === 'unreachable') return t('error.unreachable')
  const key = refusalKey(result.status)
  return key === null ? t('error.status', { status: result.status }) : t(key)
}

/**
 * Serialize the control's gestures and report each failure it settles on.
 * @param execute - launches one application, remembering it when the gesture picked it from the list.
 * @param report - notice seat the failure copy is sent to.
 * @param t - this plugin's translate seat.
 * @returns the pending state and the two named gestures.
 */
function useOpenInSelectGesture(
  execute: (appId: string, picked: boolean) => Promise<LaunchResult>,
  report: (text: string) => void,
  t: TranslateNS<typeof NS>,
): { pending: boolean; open: (appId: string) => void; pick: (appId: string) => void } {
  const [pending, setPending] = useState(false)
  // The control stays clickable, and its pointer stays a pointer: a press during
  // a launch reads as "nothing happened" rather than as a dead control, and this
  // guard is what drops it. `aria-disabled` carries the unavailability for
  // assistive technology, which is where it matters.
  // The pending flag only moves on the next render, so a second press in the same
  // frame still reads the old value; the ref is what actually drops it.
  const inFlight = useRef(false)
  const run = (appId: string, picked: boolean): void => {
    if (inFlight.current) return
    inFlight.current = true
    setPending(true)
    void execute(appId, picked).then((result) => {
      const text = failureText(t, result)
      if (text !== null) report(text)
    }).finally(() => { inFlight.current = false; setPending(false) })
  }
  return {
    pending,
    open: appId => { run(appId, false) },
    pick: appId => { run(appId, true) },
  }
}

/**
 * Render the header control for one Session.
 * @param props.absolutePath - the Session's absolute workspace directory.
 * @returns the split button, or null while no application is available.
 */
export function OpenInSelect(props: OpenInSelectProps): ReactNode {
  const { absolutePath, useOpenInSelectApps, useOpenInSelectChoice, launch, choose, report, iconUrl, t } = props
  const available = useOpenInSelectApps(apps => apps)
  const remembered = useOpenInSelectChoice(appId => appId)
  const [menuOpen, setMenuOpen] = useState(false)
  const gesture = useOpenInSelectGesture(async (appId, picked) => {
    const result = await launch(appId, absolutePath)
    if (shouldRemember(result, picked)) choose(appId)
    return result
  }, report, t)
  const current = defaultApp(available, remembered)
  // No resolved application — the Host answered nothing, refused, or was never
  // reached — reads the same to the header: no control at all, rather than one
  // that cannot do anything.
  if (current === undefined) return null
  // Open in the remembered application while the Host still resolves it,
  // otherwise in the catalog's first entry, exactly as the list shows it.
  const openLabel = t('action.open', { app: appLabel(current) })
  const choosable = available.length > 1
  // One gesture at a time: a launch in flight closes the list and locks both halves.
  const menuShown = menuOpen && !gesture.pending
  const control = (
    <span className={css.group}>
      <Tooltip portal label={openLabel} side="bottom" delayMs={500}>
        <Button
          size="sm"
          icon={<AppIcon source={iconUrl(current)} />}
          aria-disabled={gesture.pending}
          aria-label={openLabel}
          onClick={() => { gesture.open(current) }}
        />
      </Tooltip>
      {choosable && (
        <Tooltip portal label={t('action.more')} side="bottom" delayMs={500}>
          <Button
            size="sm"
            icon={<IconChevronDownOutlineRegular size={12} />}
            aria-disabled={gesture.pending}
            aria-haspopup="menu"
            aria-expanded={menuShown}
            aria-label={t('action.more')}
            onClick={() => { if (!gesture.pending) setMenuOpen(open => !open) }}
          />
        </Tooltip>
      )}
    </span>
  )
  if (!choosable) return control
  return (
    <Menu
      open={menuShown}
      portal
      dense
      align="end"
      autoFocus
      anchor={control}
      items={available.map(appId => ({
        id: appId,
        icon: <AppIcon source={iconUrl(appId)} />,
        label: appLabel(appId),
      }))}
      selectedId={current}
      onSelect={(appId) => { setMenuOpen(false); gesture.pick(appId) }}
      onClose={() => { setMenuOpen(false) }}
    />
  )
}
