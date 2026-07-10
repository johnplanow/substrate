/**
 * RP1.2/RP1.3 — ratifyCandidate + diffJourneySets unit tests.
 *
 * Pins:
 * - ratify writes the full provenance block, hashes the source AT RATIFY
 *   time (warning when it drifted from derive time)
 * - version: 1 fresh, existing+1 on re-ratification
 * - exclusions: dangling excludes rejected; prior exclusions carry forward
 *   unless re-included; exclude-everything rejected
 * - registry-schema arbitration: critical-without-epic and empty end_states
 *   (needs-elaboration unresolved) block ratification with pathed issues
 * - diff: added/removed/changed(field-level)/unchanged — a semantic change
 *   can never render as a no-op
 */

import { createHash } from 'node:crypto'
import { describe, it, expect } from 'vitest'
import { ratifyCandidate, diffJourneySets, renderRegistryDiff } from '../provenance.js'
import type { JourneyCandidate, CandidateJourney } from '../candidate.js'
import type { Journey, JourneyRegistry } from '../types.js'

const SOURCE = '# PRD\nthe operator receives a weekly digest email\n'
const SOURCE_SHA = createHash('sha256').update(SOURCE, 'utf-8').digest('hex')

function makeCandidate(over?: Partial<JourneyCandidate>): JourneyCandidate {
  return {
    candidate: true,
    derived_from: 'docs/prd.md',
    source_sha256: SOURCE_SHA,
    derived_at: '2026-07-09T12:00:00.000Z',
    journeys: [
      {
        id: 'UJ-1',
        title: 'Operator receives the weekly digest',
        criticality: 'critical',
        criticality_rationale: 'PRD core loop',
        surfaces: ['email'],
        end_states: [{ id: 'UJ-1.a', given: 'fixture week', walk: 'open email', then: 'digest table present' }],
      },
      {
        id: 'UJ-2',
        title: 'Operator exports history',
        criticality: 'standard',
        surfaces: ['cli'],
        end_states: [{ id: 'UJ-2.a', given: 'transactions exist', walk: 'run export', then: 'csv produced' }],
      },
    ],
    ...over,
  }
}

const BASE_OPTS = {
  excludes: [],
  ratifiedBy: 'operator',
  sourceContent: SOURCE,
  now: '2026-07-09T13:00:00.000Z',
  epicAssignments: { 'UJ-1': 2 },
}

describe('ratifyCandidate', () => {
  it('produces a valid v1 registry with a full provenance block', () => {
    const result = ratifyCandidate(makeCandidate(), BASE_OPTS)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.registry.version).toBe(1)
    expect(result.registry.journeys).toHaveLength(2)
    expect(result.registry.journeys[0]?.epic).toBe(2)
    // rationale is review material — not carried into the registry
    expect(result.registry.journeys[0]).not.toHaveProperty('criticality_rationale')
    const prov = result.registry.provenance
    expect(prov?.derived_from).toBe('docs/prd.md')
    expect(prov?.source_sha256).toBe(SOURCE_SHA)
    expect(prov?.ratified_by).toBe('operator')
    expect(prov?.derived_at).toBe('2026-07-09T13:00:00.000Z')
    expect(result.warnings).toEqual([])
  })

  it('hashes the source AT RATIFY TIME and warns when it drifted since derive', () => {
    const drifted = `${SOURCE}\nnew paragraph added after derive\n`
    const result = ratifyCandidate(makeCandidate(), { ...BASE_OPTS, sourceContent: drifted })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    const expectedSha = createHash('sha256').update(drifted, 'utf-8').digest('hex')
    expect(result.registry.provenance?.source_sha256).toBe(expectedSha)
    expect(result.warnings.some((w) => w.includes('changed between derive'))).toBe(true)
  })

  it('bumps version and records exclusions on re-ratification', () => {
    const existing: JourneyRegistry = {
      version: 3,
      journeys: [],
      provenance: {
        derived_from: 'docs/prd.md',
        source_sha256: SOURCE_SHA,
        derived_at: '2026-07-01T00:00:00.000Z',
        ratified_by: 'operator',
        excluded: [{ candidate: 'UJ-9', reason: 'post-MVP, PRD defers' }],
      },
    }
    const result = ratifyCandidate(makeCandidate(), {
      ...BASE_OPTS,
      existingRegistry: existing,
      excludes: [{ candidate: 'UJ-2', reason: 'descoped this quarter' }],
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.registry.version).toBe(4)
    expect(result.registry.journeys.map((j) => j.id)).toEqual(['UJ-1'])
    // new exclusion recorded AND the prior one carried forward
    const excluded = result.registry.provenance?.excluded ?? []
    expect(excluded.some((e) => e.candidate === 'UJ-2' && e.reason.includes('descoped'))).toBe(true)
    expect(excluded.some((e) => e.candidate === 'UJ-9')).toBe(true)
  })

  it('drops a carried exclusion when the journey is re-included in the candidate', () => {
    const existing: JourneyRegistry = {
      version: 1,
      journeys: [],
      provenance: {
        derived_from: 'docs/prd.md',
        source_sha256: SOURCE_SHA,
        derived_at: '2026-07-01T00:00:00.000Z',
        ratified_by: 'operator',
        excluded: [{ candidate: 'UJ-2', reason: 'was post-MVP' }],
      },
    }
    const result = ratifyCandidate(makeCandidate(), { ...BASE_OPTS, existingRegistry: existing })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    // UJ-2 is now ratified in — its stale exclusion must not survive
    expect(result.registry.provenance?.excluded).toBeUndefined()
    expect(result.registry.journeys.some((j) => j.id === 'UJ-2')).toBe(true)
  })

  it('rejects a dangling --exclude (typo protection)', () => {
    const result = ratifyCandidate(makeCandidate(), {
      ...BASE_OPTS,
      excludes: [{ candidate: 'UJ-404', reason: 'typo' }],
    })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.issues[0]?.message).toContain('does not match any candidate journey id')
  })

  it('rejects excluding every journey (nothing to ratify)', () => {
    const result = ratifyCandidate(makeCandidate(), {
      ...BASE_OPTS,
      excludes: [
        { candidate: 'UJ-1', reason: 'r1' },
        { candidate: 'UJ-2', reason: 'r2' },
      ],
    })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.issues[0]?.message).toContain('nothing to ratify')
  })

  it('registry schema arbitrates: critical journey without an epic blocks ratification', () => {
    const result = ratifyCandidate(makeCandidate(), { ...BASE_OPTS, epicAssignments: {} })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.issues.some((i) => i.path === 'journeys.0.epic' && i.message.includes('must declare an epic'))).toBe(true)
  })

  it('registry schema arbitrates: unresolved needs-elaboration (empty end_states) blocks ratification', () => {
    const candidate = makeCandidate()
    candidate.journeys[1] = { ...(candidate.journeys[1] as CandidateJourney), end_states: [] }
    const result = ratifyCandidate(candidate, BASE_OPTS)

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.issues.some((i) => i.message.includes('unjudgeable'))).toBe(true)
  })
})

describe('diffJourneySets (RP1.3)', () => {
  const current: Journey[] = [
    { id: 'UJ-1', title: 'Digest', criticality: 'critical', epic: 2, surfaces: ['email'], end_states: [{ id: 'UJ-1.a', given: 'g', walk: 'w', then: 't' }] },
    { id: 'UJ-2', title: 'Export', criticality: 'standard', surfaces: ['cli'], end_states: [{ id: 'UJ-2.a', given: 'g', walk: 'w', then: 't' }] },
    { id: 'UJ-3', title: 'Removed one', criticality: 'standard', surfaces: ['file'], end_states: [{ id: 'UJ-3.a', given: 'g', walk: 'w', then: 't' }] },
  ]

  it('classifies added / removed / changed (field-level) / unchanged', () => {
    const candidate: CandidateJourney[] = [
      // unchanged (rationale + ordering differences are not semantic)
      { id: 'UJ-2', title: 'Export', criticality: 'standard', criticality_rationale: 'x', surfaces: ['cli'], end_states: [{ id: 'UJ-2.a', given: 'g', walk: 'w', then: 't' }] },
      // changed: criticality flip + end-state rewrite
      { id: 'UJ-1', title: 'Digest', criticality: 'standard', surfaces: ['email'], end_states: [{ id: 'UJ-1.a', given: 'g', walk: 'w', then: 'DIFFERENT observable' }] },
      // added
      { id: 'UJ-4', title: 'Brand new', criticality: 'standard', surfaces: ['web'], end_states: [] },
    ]

    const diff = diffJourneySets(current, candidate)

    expect(diff.added).toEqual(['UJ-4'])
    expect(diff.removed).toEqual(['UJ-3'])
    expect(diff.unchanged).toEqual(['UJ-2'])
    expect(diff.changed).toHaveLength(1)
    expect(diff.changed[0]?.id).toBe('UJ-1')
    expect(diff.changed[0]?.fields.sort()).toEqual(['criticality', 'end_states'])
  })

  it('surface reorder is NOT a change; surface addition IS', () => {
    const base: Journey = { id: 'UJ-5', title: 'T', criticality: 'standard', surfaces: ['cli', 'file'], end_states: [{ id: 'UJ-5.a', given: 'g', walk: 'w', then: 't' }] }
    const reordered: CandidateJourney = { id: 'UJ-5', title: 'T', criticality: 'standard', surfaces: ['file', 'cli'], end_states: [{ id: 'UJ-5.a', given: 'g', walk: 'w', then: 't' }] }
    const widened: CandidateJourney = { ...reordered, surfaces: ['cli', 'file', 'web'] }

    expect(diffJourneySets([base], [reordered]).unchanged).toEqual(['UJ-5'])
    expect(diffJourneySets([base], [widened]).changed[0]?.fields).toEqual(['surfaces'])
  })

  it('renderRegistryDiff flags removals loudly', () => {
    const text = renderRegistryDiff(diffJourneySets(current, []))
    expect(text).toContain('- UJ-1 (REMOVED')
    expect(text).toContain('needs a hard look')
  })
})
