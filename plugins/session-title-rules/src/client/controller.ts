/**
 * Staged editor for this plugin's title-model policy.
 *
 * The Host owns three volatile fields on the `session-title-rules` entry
 * (`provider`, `model`, `reasoningEffort`); this card stages a draft over them
 * and writes on save. It is deliberately NOT built on `SettingsFormModel`: that
 * model stages per-field TEXT, while this policy is one CHOICE whose two halves
 * (`provider`/`model`) must always move together, plus an effort whose legal
 * values depend on the chosen model. Staging the choice is simpler than
 * teaching a text-field model about a pair invariant.
 *
 * The model directory comes from `remote.session.modelCatalog()` — the same
 * source the composer's model picker reads — so a route selectable here is by
 * construction a route the LLM seam will accept. The directory is advisory by
 * design, so a saved route that disappeared from it stays visible (selectable
 * only as itself) instead of silently becoming unset.
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { ModelCatalogModel, ModelProviderGroup } from '@deepseek-ai/dsh-api-remotes/client'
import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { ConfigForm } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { SettingsFormShell } from '@deepseek-ai/dsh-client-ui-primitives'

/** The settings namespace this page edits: also the Loader row id. */
export const TITLE_MODEL_NS = 'session-title-rules'

/** The three live fields this page owns. */
export interface TitleModelSettings {
  /** Explicit auxiliary provider route; absent follows the session's own route. */
  provider?: string
  /** Explicit auxiliary model id; absent follows the session's own route. */
  model?: string
  /** Reasoning effort for the auxiliary call; absent follows the route default. */
  reasoningEffort?: string
}

/** One exact auxiliary route. */
export interface TitleModelRoute {
  readonly provider: string
  readonly model: string
}

/** One selectable reasoning level: the wire id, and the directory's display name. */
export interface TitleModelEffort {
  /** Value written to `reasoningEffort` and dispatched to the provider. */
  readonly id: string
  /** Adapter-owned display name, which the shell's own picker shows. */
  readonly name: string
}

/** One selectable route joined with what the directory knows about it. */
export interface TitleModelCandidate extends TitleModelRoute {
  /** Opaque identity for lookup; callers never parse it. */
  readonly key: string
  /** Adapter-owned provider display name. */
  readonly providerName: string
  /** Adapter-owned model display name. */
  readonly modelName: string
  /** Whether the live directory still advertises this exact route. */
  readonly available: boolean
  /** Reasoning levels this model advertises, in directory order. */
  readonly efforts: readonly TitleModelEffort[]
}

/** State the card renders. */
export interface TitleModelCardState extends SettingsFormShell {
  /** Staged route; `undefined` means "follow the session's own route". */
  readonly route: TitleModelRoute | undefined
  /** Staged reasoning effort; `undefined` means "the route's own default". */
  readonly effort: string | undefined
  /** Levels the effort dropdown offers, in display order. */
  readonly effortChoices: readonly TitleModelEffort[]
  /** Live directory joined with the stored route. */
  readonly candidates: readonly TitleModelCandidate[]
  /** Directory request state. */
  readonly catalogStatus: 'idle' | 'loading' | 'ready' | 'error'
  /** Whether any provider-local directory request failed. */
  readonly catalogPartial: boolean
  /** Whether a newer Host revision invalidated the current draft. */
  readonly conflicted: boolean
}

/** Registration-side face the card binds. */
export interface TitleModelCardFace {
  hooks: {
    /** Card snapshot bound by the renderer as useTitleModelCard. */
    titleModelCard: SnapshotStore<TitleModelCardState>
  }
  /** Stage one route key, or `undefined` to follow the session's own route. */
  selectRoute: (key: string | undefined) => void
  /** Stage one reasoning level, or `undefined` for the route default. */
  selectEffort: (effort: string | undefined) => void
  /** Retry the model directory. */
  retryCatalog: () => void
  /** Persist the staged route and effort as one revision-fenced mutation. */
  save: () => void
  /** Drop the staged edits. */
  discard: () => void
}

/**
 * Stable identity for one exact route.
 *
 * Length-prefixed rather than joined by a separator character: a bare separator
 * is ambiguous whenever it can occur inside either half, so `{a, b\0c}` and
 * `{a\0b, c}` would share one key and the select would check the wrong row.
 * Prefixing the provider's length makes the encoding injective for any input.
 * @param route - provider/model pair to identify.
 * @returns an opaque key for lookup within the card.
 */
export function titleRouteKey(route: TitleModelRoute): string {
  return `${route.provider.length}:${route.provider}${route.model}`
}

/** Reasoning levels a directory model advertises, id and display name alike. */
function effortsOf(model: ModelCatalogModel): TitleModelEffort[] {
  return model.reasoning === undefined
    ? []
    : model.reasoning.efforts.map(effort => ({ id: effort.id, name: effort.name }))
}

/**
 * The levels a save could choose, in the order the dropdown shows them.
 *
 * With a route pinned, exactly that model's own levels — offering another's
 * would stage a save the LLM seam refuses with `UNSUPPORTED_REASONING_EFFORT`.
 * While following the session's model no single list is correct, because the
 * model varies per session, so the union of everything the directory advertises
 * stands in. A stored level that nothing advertises any more is appended rather
 * than dropped: the field would otherwise display a value its own dropdown
 * cannot show, and the user could not tell what is configured.
 * @param candidates - routes joined with the directory.
 * @param route - the route a save would write, or `undefined` for the session's.
 * @param selected - the level a save would write, or `undefined` for the default.
 * @returns selectable levels, ids unique, first name seen per id winning.
 */
export function titleEffortChoices(
  candidates: readonly TitleModelCandidate[],
  route: TitleModelRoute | undefined,
  selected: string | undefined,
): TitleModelEffort[] {
  const advertised = route === undefined
    ? candidates.flatMap(candidate => candidate.efforts)
    : candidates.find(candidate => candidate.key === titleRouteKey(route))?.efforts ?? []
  const unique: TitleModelEffort[] = []
  for (const effort of advertised) {
    if (!unique.some(held => held.id === effort.id)) unique.push(effort)
  }
  // Its own id is the only honest label left: the directory that named it is gone.
  if (selected !== undefined && !unique.some(held => held.id === selected)) {
    unique.push({ id: selected, name: selected })
  }
  return unique
}

/**
 * Join the live directory with a stored route that may have disappeared.
 * @param groups - current model directory grouped by provider.
 * @param stored - the route in the effective settings value, when one is set.
 * @returns candidate rows: live routes in directory order, then the unavailable stored route.
 */
export function titleModelCandidates(
  groups: readonly ModelProviderGroup[],
  stored: TitleModelRoute | undefined,
): TitleModelCandidate[] {
  const candidates: TitleModelCandidate[] = []
  let storedSeen = false
  for (const group of groups) {
    for (const model of group.models) {
      const route = { provider: group.id, model: model.id }
      if (stored !== undefined && titleRouteKey(route) === titleRouteKey(stored)) storedSeen = true
      candidates.push({
        ...route,
        key: titleRouteKey(route),
        providerName: group.name,
        modelName: model.name,
        available: true,
        efforts: effortsOf(model),
      })
    }
  }
  if (stored !== undefined && !storedSeen) {
    candidates.push({
      ...stored,
      key: titleRouteKey(stored),
      providerName: stored.provider,
      modelName: stored.model,
      available: false,
      efforts: [],
    })
  }
  return candidates
}

/** Whether two optional routes name the same pair. */
function sameRoute(left: TitleModelRoute | undefined, right: TitleModelRoute | undefined): boolean {
  if (left === undefined || right === undefined) return left === right
  return left.provider === right.provider && left.model === right.model
}

/** Read a non-empty string field out of the settings section. */
function textField(value: unknown, field: string): string | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const held: unknown = Reflect.get(value, field)
  return typeof held === 'string' && held.length > 0 ? held : undefined
}

/** Bridges the shared settings form and the live model directory onto a staged card. */
export class TitleModelCardController {
  private groups: readonly ModelProviderGroup[] = []
  private catalogPartial = false
  private catalogStatus: TitleModelCardState['catalogStatus'] = 'idle'
  private draftRoute: TitleModelRoute | undefined
  private routeStaged = false
  private draftEffort: string | undefined
  private effortStaged = false
  private draftRevision: number | undefined
  private saving = false
  private failed = false
  private conflicted = false
  private disposed = false
  private saveGeneration = 0
  private catalogGeneration = 0
  private readonly store: SnapshotStore<TitleModelCardState>
  private readonly unsubscribe: () => void

  /**
   * @param form - the shared form for the `session-title-rules` entry.
   * @param ctx - the card plugin's context, whose `remote.session` namespace answers the directory.
   */
  constructor(
    private readonly form: ConfigForm<TitleModelSettings>,
    private readonly ctx: ClientContext,
  ) {
    this.store = createSnapshotStore(this.projection())
    this.unsubscribe = form.subscribe(() => { this.onFormChange() })
    void this.loadCatalog()
  }

  /** Stop observing settings, suppress late settlements, and release the store. */
  dispose(): void {
    this.disposed = true
    this.saveGeneration += 1
    this.catalogGeneration += 1
    this.unsubscribe()
  }

  /**
   * Build the renderer face for this card.
   * @returns the snapshot and staged card actions injected into the renderer.
   */
  inject(): TitleModelCardFace {
    return {
      hooks: { titleModelCard: this.store },
      selectRoute: (key) => { this.selectRoute(key) },
      selectEffort: (effort) => { this.selectEffort(effort) },
      retryCatalog: () => { void this.loadCatalog() },
      save: () => { void this.save() },
      discard: () => { this.discard() },
    }
  }

  /** Re-derive after the shared form changed: another editor may have written. */
  private onFormChange(): void {
    if (this.disposed) return
    if (!this.saving && this.draftRevision !== undefined
      && this.form.getSnapshot().revision !== this.draftRevision) {
      if (sameRoute(this.currentRoute(), this.draftRoute) && this.currentEffort() === this.draftEffort) {
        this.clearDraft()
      } else {
        this.conflicted = true
      }
    }
    this.publish()
  }

  private currentRoute(): TitleModelRoute | undefined {
    const value: unknown = this.form.getSnapshot().value
    const provider = textField(value, 'provider')
    const model = textField(value, 'model')
    // Half a pair is not a route: treat it as unset so the page stays usable.
    return provider === undefined || model === undefined ? undefined : { provider, model }
  }

  private currentEffort(): string | undefined {
    return textField(this.form.getSnapshot().value, 'reasoningEffort')
  }

  /** The route a save would write. */
  private desiredRoute(): TitleModelRoute | undefined {
    return this.routeStaged ? this.draftRoute : this.currentRoute()
  }

  /** The effort a save would write. */
  private desiredEffort(): string | undefined {
    return this.effortStaged ? this.draftEffort : this.currentEffort()
  }

  private beginDraft(): void {
    if (this.draftRevision === undefined) {
      this.draftRevision = this.form.getSnapshot().revision
      this.draftRoute = this.currentRoute()
      this.draftEffort = this.currentEffort()
    }
  }

  private clearDraft(): void {
    this.routeStaged = false
    this.effortStaged = false
    this.draftRoute = undefined
    this.draftEffort = undefined
    this.draftRevision = undefined
    this.failed = false
    this.conflicted = false
  }

  private discard(): void {
    if (this.saving) return
    this.clearDraft()
    this.publish()
  }

  private selectRoute(key: string | undefined): void {
    if (this.disposed || this.saving || !this.form.getSnapshot().writable) return
    this.beginDraft()
    if (key === undefined) {
      this.draftRoute = undefined
    } else {
      const candidate = this.candidates().find(row => row.key === key)
      if (candidate === undefined) return
      this.draftRoute = { provider: candidate.provider, model: candidate.model }
      // The old effort may not exist on the new model; carrying it over would
      // stage a save the LLM seam then refuses with UNSUPPORTED_REASONING_EFFORT.
      if (candidate.available && this.draftEffort !== undefined
        && !candidate.efforts.some(effort => effort.id === this.draftEffort)) this.draftEffort = undefined
    }
    this.routeStaged = true
    this.failed = false
    this.publish()
  }

  private selectEffort(effort: string | undefined): void {
    if (this.disposed || this.saving || !this.form.getSnapshot().writable) return
    this.beginDraft()
    this.draftEffort = effort
    this.effortStaged = true
    this.failed = false
    this.publish()
  }

  private candidates(): TitleModelCandidate[] {
    return titleModelCandidates(this.groups, this.currentRoute())
  }

  private async save(): Promise<void> {
    const snapshot = this.form.getSnapshot()
    const desiredRoute = this.desiredRoute()
    const desiredEffort = this.desiredEffort()
    if (this.disposed || this.saving || !snapshot.writable) return
    if (sameRoute(this.currentRoute(), desiredRoute) && this.currentEffort() === desiredEffort) return
    if (this.draftRevision !== undefined && snapshot.revision !== this.draftRevision) {
      this.conflicted = true
      this.publish()
      return
    }
    const generation = this.saveGeneration
    this.saving = true
    this.failed = false
    this.conflicted = false
    this.publish()
    // `unset` re-inherits the composition layer, which is exactly what "follow
    // the session model" and "route default effort" mean: an ABSENT field, not
    // an empty string the provider would try to call.
    const ops = desiredRoute === undefined
      ? [
        { op: 'unset' as const, path: ['provider'] },
        { op: 'unset' as const, path: ['model'] },
      ]
      : [
        { op: 'set' as const, path: ['provider'], value: desiredRoute.provider },
        { op: 'set' as const, path: ['model'], value: desiredRoute.model },
      ]
    const accepted = await this.form.mutate(desiredEffort === undefined
      ? [...ops, { op: 'unset' as const, path: ['reasoningEffort'] }]
      : [...ops, { op: 'set' as const, path: ['reasoningEffort'], value: desiredEffort }], this.draftRevision)
    if (generation !== this.saveGeneration || this.disposed) return
    this.saving = false
    this.failed = !accepted
    if (accepted) this.clearDraft()
    this.publish()
  }

  private async loadCatalog(): Promise<void> {
    if (this.disposed || this.catalogStatus === 'loading') return
    const generation = this.catalogGeneration
    this.catalogStatus = 'loading'
    this.catalogPartial = false
    this.publish()
    const response = await this.ctx.remote.session.modelCatalog()
    if (generation !== this.catalogGeneration || this.disposed) return
    if (response.ok) {
      this.groups = response.value.groups
      this.catalogPartial = response.value.failures.length > 0
      this.catalogStatus = 'ready'
    } else {
      this.catalogStatus = 'error'
    }
    this.publish()
  }

  private projection(): TitleModelCardState {
    const snapshot = this.form.getSnapshot()
    const desiredRoute = this.desiredRoute()
    const desiredEffort = this.desiredEffort()
    const candidates = this.candidates()
    // Derived here rather than in the component so the dropdown is a pure
    // function of one snapshot: the list depends on the route and the stored
    // effort together with the directory, and rendering it from three separate
    // reads is how a control ends up showing a level it is not offering.
    const effortChoices = titleEffortChoices(candidates, desiredRoute, desiredEffort)
    return {
      available: snapshot.status === 'ready',
      writable: snapshot.writable,
      dirty: !sameRoute(this.currentRoute(), desiredRoute) || this.currentEffort() !== desiredEffort,
      invalid: false,
      saving: this.saving,
      failed: this.failed,
      route: desiredRoute,
      effort: desiredEffort,
      effortChoices,
      candidates,
      catalogStatus: this.catalogStatus,
      catalogPartial: this.catalogPartial,
      conflicted: this.conflicted,
    }
  }

  private publish(): void {
    if (this.disposed) return
    this.store.set(this.projection())
  }
}
