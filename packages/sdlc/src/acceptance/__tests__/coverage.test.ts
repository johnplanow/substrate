/**
 * A0.3 — journey coverage ledger unit tests (AC1, exhaustive).
 *
 * All five states × scope selection × precedence rules. This function is the
 * spine of the acceptance gate: pure arithmetic, no LLM, nothing to game.
 */

import { describe, it, expect } from 'vitest'
import { computeJourneyCoverage, summarizeCoverage, parseJourneyDeferrals } from '../coverage.js'
import type { JourneyRegistry } from '../types.js'

function registryWith(journeys: Partial<JourneyRegistry['journeys'][number]>[]): JourneyRegistry {
  return {
    version: 1,
    journeys: journeys.map((j, i) => ({
      id: j.id ?? `UJ-${String(i + 1)}`,
      title: j.title ?? `Journey ${String(i + 1)}`,
      criticality: j.criticality ?? 'standard',
      surfaces: j.surfaces ?? ['cli'],
      ...(j.epic !== undefined ? { epic: j.epic } : {}),
      end_states: j.end_states ?? [{ id: `${j.id ?? `UJ-${String(i + 1)}`}.a`, given: 'g', walk: 'w', then: 't' }],
    })),
  }
}

describe('computeJourneyCoverage', () => {
  it('UNCLAIMED: a journey no story tags — the UJ-2 class, caught structurally', () => {
    const entries = computeJourneyCoverage({
      registry: registryWith([{ id: 'UJ-2', criticality: 'critical' }]),
      claims: [],
      verdicts: [],
      deferredJourneyIds: [],
      scope: { final: true },
    })

    expect(entries).toHaveLength(1)
    expect(entries[0]?.state).toBe('unclaimed')
    expect(entries[0]?.criticality).toBe('critical')
    expect(entries[0]?.ownerStories).toEqual([])
  })

  it('UNWALKED: claimed but never walked', () => {
    const entries = computeJourneyCoverage({
      registry: registryWith([{ id: 'UJ-1' }]),
      claims: [{ journeyId: 'UJ-1', storyKey: '1-1' }],
      verdicts: [],
      deferredJourneyIds: [],
      scope: { final: true },
    })

    expect(entries[0]?.state).toBe('unwalked')
    expect(entries[0]?.ownerStories).toEqual(['1-1'])
  })

  it('WALKED-PASS and WALKED-FAIL from verdicts; fail wins over pass', () => {
    const entries = computeJourneyCoverage({
      registry: registryWith([{ id: 'UJ-1' }, { id: 'UJ-2' }, { id: 'UJ-3' }]),
      claims: [
        { journeyId: 'UJ-1', storyKey: '1-1' },
        { journeyId: 'UJ-2', storyKey: '1-2' },
        { journeyId: 'UJ-3', storyKey: '1-3' },
      ],
      verdicts: [
        { journeyId: 'UJ-1', verdict: 'pass' },
        { journeyId: 'UJ-2', verdict: 'fail' },
        // UJ-3: pass then fail — one failing end-state fails the journey
        { journeyId: 'UJ-3', verdict: 'pass' },
        { journeyId: 'UJ-3', verdict: 'fail' },
      ],
      deferredJourneyIds: [],
      scope: { final: true },
    })

    expect(entries.map((e) => e.state)).toEqual(['walked-pass', 'walked-fail', 'walked-fail'])
  })

  it('fail wins regardless of verdict order (fail then pass)', () => {
    const entries = computeJourneyCoverage({
      registry: registryWith([{ id: 'UJ-1' }]),
      claims: [],
      verdicts: [
        { journeyId: 'UJ-1', verdict: 'fail' },
        { journeyId: 'UJ-1', verdict: 'pass' },
      ],
      deferredJourneyIds: [],
      scope: { final: true },
    })

    expect(entries[0]?.state).toBe('walked-fail')
  })

  it('DEFERRED wins over everything, including a fail verdict', () => {
    const entries = computeJourneyCoverage({
      registry: registryWith([{ id: 'UJ-1' }]),
      claims: [{ journeyId: 'UJ-1', storyKey: '1-1' }],
      verdicts: [{ journeyId: 'UJ-1', verdict: 'fail' }],
      deferredJourneyIds: ['UJ-1'],
      scope: { final: true },
    })

    expect(entries[0]?.state).toBe('deferred')
  })

  it('epic scope audits only that epic; final scope audits everything', () => {
    const registry = registryWith([
      { id: 'UJ-1', epic: 1 },
      { id: 'UJ-2', epic: 2 },
      { id: 'UJ-3' }, // epicless — final-close only
    ])

    const epic1 = computeJourneyCoverage({
      registry,
      claims: [],
      verdicts: [],
      deferredJourneyIds: [],
      scope: { epic: 1 },
    })
    const final = computeJourneyCoverage({
      registry,
      claims: [],
      verdicts: [],
      deferredJourneyIds: [],
      scope: { final: true },
    })

    expect(epic1.map((e) => e.journeyId)).toEqual(['UJ-1'])
    expect(final.map((e) => e.journeyId)).toEqual(['UJ-1', 'UJ-2', 'UJ-3'])
  })

  it('claims from unknown journeys are ignored; duplicate owner stories dedupe', () => {
    const entries = computeJourneyCoverage({
      registry: registryWith([{ id: 'UJ-1' }]),
      claims: [
        { journeyId: 'UJ-1', storyKey: '1-1' },
        { journeyId: 'UJ-1', storyKey: '1-1' },
        { journeyId: 'UJ-99', storyKey: '1-2' },
      ],
      verdicts: [],
      deferredJourneyIds: [],
      scope: { final: true },
    })

    expect(entries).toHaveLength(1)
    expect(entries[0]?.ownerStories).toEqual(['1-1'])
  })
})

describe('summarizeCoverage', () => {
  it('counts every state', () => {
    const registry = registryWith([
      { id: 'A' },
      { id: 'B' },
      { id: 'C' },
      { id: 'D' },
      { id: 'E' },
    ])
    const entries = computeJourneyCoverage({
      registry,
      claims: [
        { journeyId: 'B', storyKey: '1-1' },
        { journeyId: 'C', storyKey: '1-2' },
        { journeyId: 'D', storyKey: '1-3' },
      ],
      verdicts: [
        { journeyId: 'C', verdict: 'pass' },
        { journeyId: 'D', verdict: 'fail' },
      ],
      deferredJourneyIds: ['E'],
      scope: { final: true },
    })

    expect(summarizeCoverage(entries)).toEqual({
      'walked-pass': 1,
      'walked-fail': 1,
      deferred: 1,
      unclaimed: 1,
      unwalked: 1,
    })
  })
})

describe('parseJourneyDeferrals', () => {
  it('parses a valid deferral file', () => {
    const result = parseJourneyDeferrals('deferrals:\n  - journey: UJ-3\n    reason: post-MVP scope cut\n    deferred_at: "2026-07-07"\n')

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.deferrals).toEqual([{ journey: 'UJ-3', reason: 'post-MVP scope cut', deferred_at: '2026-07-07' }])
  })

  it('empty file = no deferrals', () => {
    const result = parseJourneyDeferrals('')

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.deferrals).toEqual([])
  })

  it('a deferral without a reason is invalid (operator ack is the point)', () => {
    const result = parseJourneyDeferrals('deferrals:\n  - journey: UJ-3\n')

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.issues.some((i) => i.path.includes('reason'))).toBe(true)
  })

  it('malformed YAML comes back as issues, never a throw', () => {
    const result = parseJourneyDeferrals('deferrals: [unclosed')

    expect(result.ok).toBe(false)
  })
})
