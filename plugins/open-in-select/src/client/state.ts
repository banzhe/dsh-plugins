/**
 * The control's shared state: the Host's application list (one read per page)
 * and the remembered application, which outlives the page in local storage.
 *
 * Both are snapshot stores because every Session header renders its own copy of
 * the control and they must agree: a launch, a choice, or the first answered
 * list reaches all of them through one source.
 */
import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store'

/**
 * Storage key of the remembered application id. Namespaced for this Bundle
 * alone: the official `open-in-app` control keeps its own private key and the
 * two plugins must not overwrite each other's choice.
 */
const CHOICE_KEY = 'dsh.open-in-select.app.v1'

/** The control's stores. */
export interface OpenInSelectState {
  /** Installed application ids in Host order; empty until the Host answered. */
  readonly apps: SnapshotStore<readonly string[]>
  /** Last application picked from the list, or empty before the first choice. */
  readonly choice: SnapshotStore<string>
}

/**
 * Create the stores for one plugin instance.
 *
 * Persistence is best effort by contract: `createSnapshotStore` disables it
 * when local storage is unavailable (no document, private mode, quota refusal)
 * and the remembered choice then lives in memory for the page's lifetime.
 * @returns the application list and the remembered choice.
 */
export function createOpenInSelectState(): OpenInSelectState {
  return {
    apps: createSnapshotStore<readonly string[]>([]),
    choice: createSnapshotStore<string>('', { persist: { name: CHOICE_KEY } }),
  }
}
