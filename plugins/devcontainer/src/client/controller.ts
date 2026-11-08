/**
 * Staged state for the Dev Container variants page.
 *
 * Reads the roster through `ctx.remote.agentPresets.list` — the same listing
 * every picker reads — and writes BOTH stored source lists (`sources` for the
 * `(devContainer)` track, `sbxSources` for the `(sbx)` track) through the shared
 * `ConfigForm` of the `devcontainer` settings namespace. A write lands in the
 * profile patch and in the Host's live reference, and the Host re-derives the
 * variant set while the same event is still settling, so checking a box is felt
 * before the next render.
 *
 * Toggles are queued rather than dropped: each write carries the WHOLE pair of
 * lists, and a person clearing two rows in a row must not lose the second click.
 */
import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { AgentPresetRoster } from '@deepseek-ai/dsh-agent-preset-registry/types'
import type { ConfigForm } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { SettingsPathOpView } from '@deepseek-ai/dsh-api-remotes/client'
import {
  nextSources, selectable, selectablePresets, SOURCE_FIELDS, sbxSourcesOf, sourcesOf, type SelectablePreset,
} from './variants.ts'

/** The settings namespace this page edits: also the Host Loader row id. */
export const DEVCONTAINER_NS = 'devcontainer'

/** The namespace section as the Host publishes it. */
export interface DevcontainerVariantsSettings {
  /** Source preset ids whose `(devContainer)` variants are wanted; absent before the first Host read. */
  sources?: readonly string[]
  /** Source preset ids whose `(sbx)` variants are wanted; absent before the first Host read. */
  sbxSources?: readonly string[]
}

/** One row as the page renders it. */
export type VariantRow = SelectablePreset

/** What a failed read or write means for the page's own copy. */
export type VariantsFailure = 'load' | 'write'

/** Page snapshot the renderer subscribes to. */
export interface VariantsState {
  /** `loading` until the roster arrives, `unavailable` when the Host serves no such namespace. */
  readonly status: 'loading' | 'ready' | 'error' | 'unavailable'
  /** The failure the page must explain, if any. */
  readonly failure: VariantsFailure | null
  /** Whether the Host accepts writes to this namespace. */
  readonly writable: boolean
  /** Whether a toggle is crossing the wire or still queued. */
  readonly saving: boolean
  /** Every selectable source preset, in Host roster order, with its `(devContainer)` state. */
  readonly rows: readonly VariantRow[]
  /** The same presets, with their `(sbx)` state. */
  readonly sbxRows: readonly VariantRow[]
  /** How many rows have a `(devContainer)` variant derived right now. */
  readonly checkedCount: number
  /** How many rows have an `(sbx)` variant derived right now. */
  readonly sbxCheckedCount: number
}

/** Business face the page receives (the framework binds `hooks` to a selector hook). */
export interface VariantsFace {
  hooks: { devcontainerVariants: SnapshotStore<VariantsState> }
  /** Read the roster from the Host. */
  load: () => Promise<void>
  /** Derive or drop one preset's `(devContainer)` variant; queues behind a write already in flight. */
  setChecked: (id: string, checked: boolean) => void
  /** Flip one preset's `(sbx)` variant; queues behind a write already in flight. */
  toggleSbxSource: (sourceId: string) => void
}

/** The pair of stored lists one write carries. */
interface SourcesIntent {
  readonly sources: string[]
  readonly sbxSources: string[]
}

const INITIAL: VariantsState = {
  status: 'loading',
  failure: null,
  writable: false,
  saving: false,
  rows: [],
  sbxRows: [],
  checkedCount: 0,
  sbxCheckedCount: 0,
}

/**
 * Delays between roster re-reads after a write lands.
 *
 * A landed write reaches the Host before the variants it asks for are
 * registered: the settings event is emitted first, the sync then walks the
 * presets. One immediate re-read therefore sees the old roster, and without a
 * retry the page would show every freshly checked row as pending forever.
 */
const VERIFY_DELAYS: readonly number[] = [80, 150, 300, 600]

/**
 * The rows of one roster answer.
 *
 * A listing that reports success without a body (a namespace whose method is not
 * what this build serves) must leave the page empty rather than throw inside the
 * plugin: this page is a preference, not a critical surface.
 * @param value - the roster the Remote answered with.
 * @returns its preset rows, or none when the answer carries no roster.
 */
export function rosterRows(value: unknown): AgentPresetRoster['presets'] {
  if (value === null || typeof value !== 'object') return []
  const presets: unknown = (value as { presets?: unknown }).presets
  return Array.isArray(presets) ? presets as AgentPresetRoster['presets'] : []
}

/** Resolve after one delay, so a test can drive the clock. */
function wait(ms: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, ms) })
}

/**
 * One roster read.
 *
 * Structural rather than `RemoteResult` so a build that serves no such namespace
 * can answer "not readable" without fabricating a carrier error: success carries
 * the roster, anything else is a failed read.
 */
export type RosterListing = () => Promise<{ readonly ok: boolean, readonly value?: unknown }>

/** Reads the roster and writes the two source lists for one page instance. */
export class VariantsController {
  private declared: AgentPresetRoster['presets'] = []
  private failure: VariantsFailure | null = null
  private loading = true
  /** The lists the queue will send next; undefined when every toggle has landed. */
  private intent: SourcesIntent | undefined
  private writing = false
  /** Invalidates every read that a newer load, or a dispose, supersedes. */
  private generation = 0
  private disposed = false
  private readonly store: SnapshotStore<VariantsState> = createSnapshotStore(INITIAL)
  private readonly unsubscribe: () => void

  /**
   * @param form - the shared form of the `devcontainer` settings namespace.
   * @param listing - the roster listing the pickers read.
   */
  constructor(
    private readonly form: ConfigForm<DevcontainerVariantsSettings>,
    private readonly listing: RosterListing,
  ) {
    // Another editor of the same namespace (a second tab, an SSH session) moves
    // the stored lists under this page, so the rows follow the form, not a copy.
    this.unsubscribe = form.subscribe(() => { this.publish() })
  }

  dispose(): void {
    this.disposed = true
    this.generation += 1
    this.unsubscribe()
  }

  inject(): VariantsFace {
    return {
      hooks: { devcontainerVariants: this.store },
      load: () => this.load(),
      setChecked: (id, checked) => { this.setChecked(id, checked) },
      toggleSbxSource: (sourceId) => { this.toggleSbxSource(sourceId) },
    }
  }

  /** Read the roster the pickers read. */
  async load(): Promise<void> {
    await this.refresh(false)
    void this.settle()
  }

  /**
   * Re-read the roster without flipping the page back to `loading`.
   * @param quiet - true when a previous render must stay on screen while it refreshes.
   */
  private async refresh(quiet: boolean): Promise<void> {
    if (this.disposed) return
    const generation = ++this.generation
    if (!quiet) {
      this.loading = true
      this.publish()
    }
    const result = await this.listing()
    if (generation !== this.generation) return
    this.loading = false
    if (result.ok) {
      this.declared = rosterRows(result.value)
      this.failure = null
    } else {
      this.declared = []
      this.failure = 'load'
    }
    this.publish()
  }

  /**
   * Re-read the roster a few times while a write's registrations settle.
   *
   * The first re-read after a landed write races the Host's own sync, so the
   * variants it asks for may still be missing. Retrying with backoff turns the
   * "waiting to be registered" badge into the real state within a second, and
   * stops as soon as nothing is outstanding.
   */
  private async settle(): Promise<void> {
    for (const delay of VERIFY_DELAYS) {
      if (!this.polling()) return
      await wait(delay)
      if (!this.polling()) return
      await this.refresh(true)
    }
  }

  /** Whether another retry is still both wanted and possible. */
  private polling(): boolean {
    return !this.disposed && this.outstanding()
  }

  /** Whether a stored row of either track is still waiting for its variant to register. */
  private outstanding(): boolean {
    const stored = this.effective(this.form.getSnapshot().value)
    const roster = { presets: this.declared }
    return selectablePresets(roster, stored.sources, 'devcontainer').some(pending)
      || selectablePresets(roster, stored.sbxSources, 'sbx').some(pending)
  }

  /** Derive or drop one preset's `(devContainer)` variant, without losing a toggle that arrives mid-write. */
  setChecked(id: string, checked: boolean): void {
    const stored = this.stage()
    if (stored === undefined) return
    this.commit({ ...stored, sources: nextSources(stored.sources, id, checked) })
  }

  /**
   * Flip one preset's `(sbx)` variant.
   *
   * A toggle rather than a target state because the checkbox renders the
   * effective list: whatever the person saw checked is what flips, including a
   * toggle that is still queued behind a write in flight.
   * @param sourceId - the source preset whose `(sbx)` variant flips.
   */
  toggleSbxSource(sourceId: string): void {
    const stored = this.stage()
    if (stored === undefined) return
    const checked = !stored.sbxSources.includes(sourceId)
    this.commit({ ...stored, sbxSources: nextSources(stored.sbxSources, sourceId, checked) })
  }

  /**
   * The lists a toggle starts from, or undefined when this page must ignore it.
   * @returns the queued lists when a write is still pending, otherwise the stored ones.
   */
  private stage(): SourcesIntent | undefined {
    if (this.disposed) return undefined
    const snapshot = this.form.getSnapshot()
    if (!snapshot.writable) return undefined
    return this.effective(snapshot.value)
  }

  /** Queue one toggle and start the write that carries it. */
  private commit(next: SourcesIntent): void {
    this.intent = next
    this.publish()
    void this.flush()
  }

  /**
   * The lists to render: the queued ones while a write is in flight, otherwise
   * the ones the Host stored.
   */
  private effective(section: unknown): SourcesIntent {
    if (this.intent !== undefined) return this.intent
    return { sources: sourcesOf(section), sbxSources: sbxSourcesOf(section) }
  }

  /**
   * Send the queued lists until nothing is queued.
   *
   * Both fields travel in ONE mutation, so a single revision fence accepts or
   * refuses the pair together: a deployment can never store one track's toggle
   * and drop the other's.
   *
   * A refusal drops the queue: those intents were derived from lists the Host
   * never stored, so replaying them would toggle a different set than the one the
   * person was looking at. After a landed write the roster is re-read, because
   * the Host may have just registered or disposed a variant.
   */
  private async flush(): Promise<void> {
    if (this.writing) return
    this.writing = true
    this.publish()
    let landed = false
    try {
      while (this.intent !== undefined) {
        const next = this.intent
        const accepted = await this.form.mutate(opsFor(next))
        this.failure = accepted ? null : 'write'
        if (!accepted) break
        landed = true
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
    if (landed && !this.disposed) {
      await this.refresh(true)
      await this.settle()
    }
  }

  private publish(): void {
    if (this.disposed) return
    const snapshot = this.form.getSnapshot()
    const stored = this.effective(snapshot.value)
    const roster = { presets: this.declared }
    const rows = selectablePresets(roster, stored.sources, 'devcontainer')
    const sbxRows = selectablePresets(roster, stored.sbxSources, 'sbx')
    this.store.set({
      status: snapshot.status === 'unavailable'
        ? 'unavailable'
        : this.failure === 'load' ? 'error'
          : this.loading || snapshot.status === 'loading' ? 'loading' : 'ready',
      failure: this.failure,
      writable: snapshot.writable,
      saving: this.writing || this.intent !== undefined,
      rows,
      sbxRows,
      checkedCount: rows.filter(row => row.checked).length,
      sbxCheckedCount: sbxRows.filter(row => row.checked).length,
    })
  }
}

/** Whether one row is stored but its variant is not registered yet. */
function pending(row: SelectablePreset): boolean {
  return row.checked && !row.derived && selectable(row)
}

/**
 * One mutation carrying both stored lists.
 * @param intent - the lists to store.
 * @returns the settings operations, in track order.
 */
function opsFor(intent: SourcesIntent): SettingsPathOpView[] {
  return [
    { op: 'set', path: [SOURCE_FIELDS.devcontainer], value: intent.sources },
    { op: 'set', path: [SOURCE_FIELDS.sbx], value: intent.sbxSources },
  ]
}
