/**
 * `titleModelCandidates` / `titleRouteKey` contract.
 *
 * The card's job is to make an uncallable route unselectable. The LLM seam
 * resolves an exact `provider`/`model` pair and rejects anything its adapter
 * does not know (`UNKNOWN_MODEL`), so the directory join is the only thing
 * standing between the user and a stored title model that can never run.
 *
 * The interesting cases are therefore the joins: a route the directory still
 * advertises, a route saved earlier that has since disappeared (which must stay
 * VISIBLE and selectable as itself, or the user cannot clear it), a directory
 * that failed for one provider (its routes are simply absent, not an error), and
 * the effort list that must come from the chosen model rather than the provider.
 */
import { describe, expect, it } from 'vitest'
import type { ModelProviderGroup } from '@deepseek-ai/dsh-api-remotes/client'
import { titleEffortChoices, titleModelCandidates, titleRouteKey } from '../src/client/controller.ts'

/** One provider group as `remote.session.modelCatalog()` returns it. */
function group(
  id: string,
  name: string,
  models: Array<{ id: string; name?: string; efforts?: string[]; defaultEffort?: string }>,
): ModelProviderGroup {
  return {
    id,
    name,
    models: models.map(model => ({
      id: model.id,
      name: model.name ?? model.id,
      ...model.efforts === undefined
        ? {}
        : {
          reasoning: {
            // The display name is NOT the id in reality: `llm-pi-ai` titles it
            // (`high` -> `High`), and the page shows that name while writing the
            // id. Deriving it here keeps that distinction visible to the tests.
            efforts: model.efforts.map(effort => ({
              id: effort,
              name: `${effort.charAt(0).toUpperCase()}${effort.slice(1)}`,
            })),
            ...model.defaultEffort === undefined ? {} : { defaultEffort: model.defaultEffort },
          },
        },
    })),
  }
}

const DIRECTORY: readonly ModelProviderGroup[] = [
  group('cliproxyapi', 'CliProxy', [
    { id: 'cc/deepseek-v4.1-flash', name: 'DS Flash', efforts: ['off', 'low', 'high'], defaultEffort: 'high' },
    { id: 'ollama/deepseek-v4.1-flash', name: 'Ollama Flash', efforts: ['low', 'high', 'max'] },
  ]),
  group('deepseek-official', 'DeepSeek', [{ id: 'deepseek-flash', name: 'Flash' }]),
]

describe('titleRouteKey', () => {
  it('distinguishes routes that differ in either half', () => {
    const base = { provider: 'cliproxyapi', model: 'cc/deepseek-v4.1-flash' }
    expect(titleRouteKey(base)).toBe(titleRouteKey({ ...base }))
    expect(titleRouteKey(base)).not.toBe(titleRouteKey({ ...base, model: 'other' }))
    expect(titleRouteKey(base)).not.toBe(titleRouteKey({ ...base, provider: 'deepseek-official' }))
  })

  it('cannot collide across a provider/model boundary', () => {
    // A separator that could appear in a provider or model id would let two
    // distinct routes share one key, and the select would check the wrong row.
    expect(titleRouteKey({ provider: 'a', model: 'b\u0000c' }))
      .not.toBe(titleRouteKey({ provider: 'a\u0000b', model: 'c' }))
  })
})

describe('titleModelCandidates', () => {
  it('offers every advertised route in directory order', () => {
    const candidates = titleModelCandidates(DIRECTORY, undefined)
    expect(candidates.map(candidate => candidate.key)).toEqual([
      titleRouteKey({ provider: 'cliproxyapi', model: 'cc/deepseek-v4.1-flash' }),
      titleRouteKey({ provider: 'cliproxyapi', model: 'ollama/deepseek-v4.1-flash' }),
      titleRouteKey({ provider: 'deepseek-official', model: 'deepseek-flash' }),
    ])
    expect(candidates.every(candidate => candidate.available)).toBe(true)
  })

  it('carries provider and model display names separately', () => {
    const [first] = titleModelCandidates(DIRECTORY, undefined)
    expect(first).toMatchObject({
      provider: 'cliproxyapi',
      providerName: 'CliProxy',
      model: 'cc/deepseek-v4.1-flash',
      modelName: 'DS Flash',
    })
  })

  it('reads the effort list from the chosen model, not the provider', () => {
    const candidates = titleModelCandidates(DIRECTORY, undefined)
    const cc = candidates.find(candidate => candidate.model === 'cc/deepseek-v4.1-flash')
    const ollama = candidates.find(candidate => candidate.model === 'ollama/deepseek-v4.1-flash')
    // The two models sit on ONE provider but support different levels; taking
    // the list from anywhere but the model would offer an unsupported level.
    expect(cc?.efforts.map(effort => effort.id)).toEqual(['off', 'low', 'high'])
    expect(ollama?.efforts.map(effort => effort.id)).toEqual(['low', 'high', 'max'])
  })

  it('carries each level id and display name separately', () => {
    const [first] = titleModelCandidates(DIRECTORY, undefined)
    // The page shows `name` and writes `id`; collapsing the two would either
    // display a lowercase wire value or dispatch a capitalized one.
    expect(first?.efforts).toEqual([
      { id: 'off', name: 'Off' },
      { id: 'low', name: 'Low' },
      { id: 'high', name: 'High' },
    ])
  })

  it('reports no efforts for a model that does not reason', () => {
    const candidates = titleModelCandidates(DIRECTORY, undefined)
    expect(candidates.find(candidate => candidate.model === 'deepseek-flash')?.efforts).toEqual([])
  })

  it('keeps a stored route the directory no longer advertises, marked unavailable', () => {
    const stored = { provider: 'cliproxyapi', model: 'retired/model' }
    const candidates = titleModelCandidates(DIRECTORY, stored)
    const saved = candidates.find(candidate => candidate.key === titleRouteKey(stored))
    // Removing it would silently reset the user's choice on the next save; it
    // has to stay listed so the page can show and clear it.
    expect(saved).toMatchObject({
      provider: 'cliproxyapi',
      model: 'retired/model',
      available: false,
      efforts: [],
    })
    expect(saved?.providerName).toBe('cliproxyapi')
  })

  it('lists the unavailable stored route last, after every live one', () => {
    const stored = { provider: 'cliproxyapi', model: 'retired/model' }
    const candidates = titleModelCandidates(DIRECTORY, stored)
    expect(candidates[candidates.length - 1]?.key).toBe(titleRouteKey(stored))
  })

  it('does not duplicate a stored route the directory still advertises', () => {
    const stored = { provider: 'cliproxyapi', model: 'cc/deepseek-v4.1-flash' }
    const candidates = titleModelCandidates(DIRECTORY, stored)
    const matches = candidates.filter(candidate => candidate.key === titleRouteKey(stored))
    expect(matches).toHaveLength(1)
    expect(matches[0]?.available).toBe(true)
  })

  it('treats a wholly failed directory as no options rather than an error', () => {
    // `modelCatalog` reports provider-local failures beside usable groups; a
    // failed provider contributes no routes at all, and its stored route still
    // has to be selectable so it can be cleared.
    const stored = { provider: 'broken-gateway', model: 'some-model' }
    const candidates = titleModelCandidates([], stored)
    expect(candidates).toHaveLength(1)
    expect(candidates[0]).toMatchObject({ available: false, model: 'some-model' })
  })

  it('returns nothing for an empty directory and no stored route', () => {
    expect(titleModelCandidates([], undefined)).toEqual([])
  })
})

describe('titleEffortChoices', () => {
  const candidates = titleModelCandidates(DIRECTORY, undefined)

  it('offers exactly the pinned model\'s levels', () => {
    const route = { provider: 'cliproxyapi', model: 'cc/deepseek-v4.1-flash' }
    expect(titleEffortChoices(candidates, route, undefined)).toEqual([
      { id: 'off', name: 'Off' },
      { id: 'low', name: 'Low' },
      { id: 'high', name: 'High' },
    ])
  })

  it('offers the union while following the session model', () => {
    // No single model is "the" model here, so the union stands in; `max` is
    // reachable, and `off`/`low`/`high` appear once despite three models
    // advertising overlapping sets.
    expect(titleEffortChoices(candidates, undefined, undefined).map(effort => effort.id))
      .toEqual(['off', 'low', 'high', 'max'])
  })

  it('keeps a stored level nothing advertises, labelled by its own id', () => {
    // Dropping it would render a configured value the dropdown cannot show, so
    // the user could not see or change what is actually stored.
    const chosen = titleEffortChoices(candidates, { provider: 'cliproxyapi', model: 'cc/deepseek-v4.1-flash' }, 'ultra')
    expect(chosen[chosen.length - 1]).toEqual({ id: 'ultra', name: 'ultra' })
  })

  it('does not duplicate a stored level the model still advertises', () => {
    const chosen = titleEffortChoices(candidates, { provider: 'cliproxyapi', model: 'cc/deepseek-v4.1-flash' }, 'low')
    expect(chosen.filter(effort => effort.id === 'low')).toHaveLength(1)
  })

  it('offers nothing for an unavailable route', () => {
    const retired = titleModelCandidates(DIRECTORY, { provider: 'cliproxyapi', model: 'retired/model' })
    expect(titleEffortChoices(retired, { provider: 'cliproxyapi', model: 'retired/model' }, undefined)).toEqual([])
  })
})
