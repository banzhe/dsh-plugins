/**
 * Staged state for the preset-visibility page.
 *
 * The page reads the FULL roster through `PresetRosterFilter.readAll` — the same
 * listing the shipped surfaces call, before this plugin filters it — because a
 * filter that also emptied this page could never offer a hidden preset back.
 * Writes go through the shared `ConfigForm` of the `agent-preset-visibility`
 * settings namespace, so the list lands in the profile patch and commits into
 * the Host's live reference in one step.
 *
 * Toggles are queued rather than dropped. Each write carries the WHOLE list, and
 * a person clearing two rows in a row must not lose the second click, so the
 * controller keeps the list it will send next, shows it immediately, and folds
 * every toggle that arrives while a write is in flight into it.
 */
import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { AgentPresetRow } from '@deepseek-ai/dsh-agent-preset-registry/types'
import type { ConfigForm } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { PresetRosterFilter } from './remote.ts'
import { hiddenIds, nextHidden } from './visibility.ts'

/** The settings namespace this page edits: also the Loader row id. */
export const PRESET_VISIBILITY_NS = 'agent-preset-visibility'

/** The namespace section as the Host publishes it. */
export interface PresetVisibilitySettings {
  /** Preset ids the pickers leave out; absent before the first Host read. */
  hidden?: readonly string[]
}

/** One roster row as the page renders it. */
export interface PresetVisibilityRow {
  /** Stable preset id: what the toggle writes. */
  readonly id: string
  /** The preset's published name, or the id when it published none. */
  readonly name: string
  /** Whether the pickers currently leave this preset out. */
  readonly hidden: boolean
  /** Whether a session naming no preset composes this one. */
  readonly isDefault: boolean
  /** Whether the Host reports that this preset cannot compose a session. */
  readonly broken: boolean
}

/** What a failed read or write means for the page's own copy. */
export type PresetVisibilityFailure = 'load' | 'write'

/** Page snapshot the renderer subscribes to. */
export interface PresetVisibilityState {
  /** `loading` until the roster arrives, `unavailable` when the Host serves no such namespace. */
  readonly status: 'loading' | 'ready' | 'error' | 'unavailable'
  /** The failure the page must explain, if any. */
  readonly failure: PresetVisibilityFailure | null
  /** Whether the Host accepts writes to this namespace. */
  readonly writable: boolean
  /** Whether a toggle is crossing the wire or still queued. */
  readonly saving: boolean
  /** Every declared preset, in Host roster order. */
  readonly rows: readonly PresetVisibilityRow[]
  /** How many of those rows are hidden right now. */
  readonly hiddenCount: number
}

/** Business face the page receives (framework binds `hooks` to a selector hook). */
export interface PresetVisibilityFace {
  hooks: { presetVisibility: SnapshotStore<PresetVisibilityState> }
  /** Read the full roster from the Host. */
  load: () => Promise<void>
  /** Hide or show one preset; queues behind a write already in flight. */
  setHidden: (id: string, hidden: boolean) => void
}

const INITIAL: PresetVisibilityState = {
  status: 'loading',
  failure: null,
  writable: false,
  saving: false,
  rows: [],
  hiddenCount: 0,
}

/** Reads the full roster and writes the hidden list for one page instance. */
export class PresetVisibilityController {
  private declared: readonly AgentPresetRow[] = []
  private failure: PresetVisibilityFailure | null = null
  private loading = true
  /** The list the queue will send next; undefined when every toggle has landed. */
  private intent: string[] | undefined
  private writing = false
  /** Invalidates every read that a newer load, or a dispose, supersedes. */
  private generation = 0
  private disposed = false
  private readonly store: SnapshotStore<PresetVisibilityState> = createSnapshotStore(INITIAL)
  private readonly unsubscribe: () => void

  /**
   * @param form - the shared form of this plugin's settings namespace.
   * @param source - the unfiltered roster seam.
   */
  constructor(
    private readonly form: ConfigForm<PresetVisibilitySettings>,
    private readonly source: PresetRosterFilter,
  ) {
    // Another editor of the same namespace (an SSH session, a second tab) moves
    // the stored list under this page, so the rows follow the form, not a copy.
    this.unsubscribe = form.subscribe(() => { this.publish() })
  }

  dispose(): void {
    this.disposed = true
    this.generation += 1
    this.unsubscribe()
  }

  inject(): PresetVisibilityFace {
    return {
      hooks: { presetVisibility: this.store },
      load: () => this.load(),
      setHidden: (id, hidden) => { this.setHidden(id, hidden) },
    }
  }

  /** Read every declared preset, including the ones this plugin hides. */
  async load(): Promise<void> {
    if (this.disposed) return
    const generation = ++this.generation
    this.loading = true
    this.publish()
    const result = await this.source.readAll()
    if (generation !== this.generation) return
    this.loading = false
    if (result.ok) {
      this.declared = result.value.presets
      this.failure = null
    } else {
      this.declared = []
      this.failure = 'load'
    }
    this.publish()
  }

  /** Hide or show one preset, without losing a toggle that arrives mid-write. */
  setHidden(id: string, hidden: boolean): void {
    if (this.disposed) return
    const snapshot = this.form.getSnapshot()
    if (!snapshot.writable) return
    this.intent = nextHidden(this.intent ?? [...hiddenIds(snapshot.value)], id, hidden)
    this.publish()
    void this.flush()
  }

  /**
   * Send the queued list until nothing is queued.
   *
   * A refusal drops the queue: the queued intents were derived from a list the
   * Host never stored, so replaying them would toggle a different set than the
   * one the person was looking at. A rejected write is treated the same way —
   * `finally` restores `writing` so the page cannot be left saving forever.
   */
  private async flush(): Promise<void> {
    if (this.writing) return
    this.writing = true
    this.publish()
    try {
      while (this.intent !== undefined) {
        // `intent` stays set across the write so a toggle that lands meanwhile folds
        // into the list being sent, instead of starting a new one from the stale
        // section the Host has not stored yet.
        const next = this.intent
        const accepted = await this.form.set('hidden', next)
        this.failure = accepted ? null : 'write'
        if (!accepted) break
        if (this.intent === next) this.intent = undefined
        this.publish()
      }
    } catch {
      this.failure = 'write'
    } finally {
      this.intent = undefined
      this.writing = false
      this.publish()
    }
  }

  private publish(): void {
    if (this.disposed) return
    const snapshot = this.form.getSnapshot()
    const hidden = this.intent === undefined
      ? hiddenIds(snapshot.value)
      : new Set(this.intent)
    const rows = this.declared.map(row => ({
      id: row.id,
      name: row.name ?? row.id,
      hidden: hidden.has(row.id),
      isDefault: row.isDefault,
      broken: row.broken !== undefined,
    }))
    this.store.set({
      status: snapshot.status === 'unavailable'
        ? 'unavailable'
        : this.failure === 'load' ? 'error'
          : this.loading || snapshot.status === 'loading' ? 'loading' : 'ready',
      failure: this.failure,
      writable: snapshot.writable,
      saving: this.writing || this.intent !== undefined,
      rows,
      hiddenCount: rows.filter(row => row.hidden).length,
    })
  }
}
