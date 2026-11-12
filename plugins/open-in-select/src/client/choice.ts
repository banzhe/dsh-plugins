/**
 * The two decisions the header control makes about an application, kept free of
 * React so both are readable and testable on their own.
 */
import type { LaunchResult } from './api.ts'

/**
 * Which application the control's left half opens: the remembered one while the
 * Host still resolves it, otherwise the Host's first entry.
 * @param apps - installed application ids in Host order.
 * @param remembered - last application picked, empty before the first choice.
 * @returns the id to open, or undefined when the Host resolved none.
 */
export function defaultApp(apps: readonly string[], remembered: string): string | undefined {
  const first = apps[0]
  if (first === undefined) return undefined
  return apps.includes(remembered) ? remembered : first
}

/**
 * Whether a settled launch becomes the remembered default: only a pick from the
 * list, and only when the Host opened it.
 * @param result - settled launch outcome.
 * @param picked - whether the gesture chose the application from the list.
 * @returns true when the id should be remembered.
 */
export function shouldRemember(result: LaunchResult, picked: boolean): boolean {
  return picked && result.kind === 'opened'
}
