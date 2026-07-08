/**
 * A0.1 — Journey Registry schema + validation unit tests.
 *
 * Covers (AC1, AC4): valid registry, malformed YAML, empty file,
 * duplicate journey ids, duplicate end-state ids, empty end_states,
 * unknown surface types, missing required fields, bad version.
 */

import { describe, it, expect } from 'vitest'
import { parseJourneyRegistry, JOURNEY_REGISTRY_PATH } from '../registry.js'

const VALID_REGISTRY = `
version: 3
journeys:
  - id: UJ-2
    title: Operator decides on an emailed Dossier
    criticality: critical
    surfaces: [email]
    epic: 2
    end_states:
      - id: UJ-2.a
        given: "Dossier rendered from fixture run 2026-06-01"
        walk: "open email; locate yes/no/defer affordance for top rec"
        then: "affordance present and actionable in rendered HTML+text"
      - id: UJ-2.b
        given: "operator taps Yes"
        walk: "follow the Yes affordance end-to-end"
        then: "a decision row exists with verdict=yes"
  - id: UJ-5
    title: Weekly CLI report renders all conviction fields
    criticality: standard
    surfaces: [cli, file]
    end_states:
      - id: UJ-5.a
        given: "fixture portfolio with 13 computed conviction fields"
        walk: "run the report command"
        then: "all 13 conviction fields appear in the output"
`

describe('parseJourneyRegistry', () => {
  it('parses a valid registry (both criticality tiers, optional epic)', () => {
    const result = parseJourneyRegistry(VALID_REGISTRY)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.registry.version).toBe(3)
    expect(result.registry.journeys).toHaveLength(2)
    expect(result.registry.journeys[0]?.id).toBe('UJ-2')
    expect(result.registry.journeys[0]?.criticality).toBe('critical')
    expect(result.registry.journeys[0]?.epic).toBe(2)
    expect(result.registry.journeys[0]?.end_states).toHaveLength(2)
    expect(result.registry.journeys[1]?.epic).toBeUndefined()
    expect(result.registry.journeys[1]?.surfaces).toEqual(['cli', 'file'])
  })

  it('rejects malformed YAML with a (root) issue naming the parse failure', () => {
    const result = parseJourneyRegistry('version: [unclosed')

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.issues).toHaveLength(1)
    expect(result.issues[0]?.path).toBe('(root)')
    expect(result.issues[0]?.message).toContain('malformed YAML')
  })

  it('rejects an empty file', () => {
    const result = parseJourneyRegistry('')

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.issues[0]?.message).toContain('empty')
  })

  it('rejects duplicate journey ids, naming the id and both positions', () => {
    const result = parseJourneyRegistry(`
version: 1
journeys:
  - id: UJ-1
    title: First
    criticality: standard
    surfaces: [cli]
    end_states:
      - { id: UJ-1.a, given: g, walk: w, then: t }
  - id: UJ-1
    title: Duplicate
    criticality: standard
    surfaces: [cli]
    end_states:
      - { id: UJ-1.b, given: g, walk: w, then: t }
`)

    expect(result.ok).toBe(false)
    if (result.ok) return
    const dup = result.issues.find((i) => i.message.includes('duplicate journey id'))
    expect(dup).toBeDefined()
    expect(dup?.message).toContain('"UJ-1"')
    expect(dup?.path).toBe('journeys.1.id')
  })

  it('rejects duplicate end-state ids within a journey', () => {
    const result = parseJourneyRegistry(`
version: 1
journeys:
  - id: UJ-1
    title: First
    criticality: standard
    surfaces: [cli]
    end_states:
      - { id: UJ-1.a, given: g, walk: w, then: t }
      - { id: UJ-1.a, given: g2, walk: w2, then: t2 }
`)

    expect(result.ok).toBe(false)
    if (result.ok) return
    const dup = result.issues.find((i) => i.message.includes('duplicate end-state id'))
    expect(dup).toBeDefined()
    expect(dup?.path).toBe('journeys.0.end_states.1.id')
  })

  it('rejects a journey with zero end_states (unjudgeable)', () => {
    const result = parseJourneyRegistry(`
version: 1
journeys:
  - id: UJ-1
    title: No end states
    criticality: critical
    surfaces: [email]
    end_states: []
`)

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.issues.some((i) => i.message.includes('unjudgeable'))).toBe(true)
  })

  it('rejects unknown surface types', () => {
    const result = parseJourneyRegistry(`
version: 1
journeys:
  - id: UJ-1
    title: Bad surface
    criticality: standard
    surfaces: [carrier-pigeon]
    end_states:
      - { id: UJ-1.a, given: g, walk: w, then: t }
`)

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.issues.some((i) => i.path.startsWith('journeys.0.surfaces'))).toBe(true)
  })

  it('rejects unknown criticality values', () => {
    const result = parseJourneyRegistry(`
version: 1
journeys:
  - id: UJ-1
    title: Bad criticality
    criticality: urgent
    surfaces: [cli]
    end_states:
      - { id: UJ-1.a, given: g, walk: w, then: t }
`)

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.issues.some((i) => i.path === 'journeys.0.criticality')).toBe(true)
  })

  it('rejects a non-positive or missing version', () => {
    for (const doc of ['version: 0\njourneys: []', 'journeys: []']) {
      const result = parseJourneyRegistry(doc)
      expect(result.ok).toBe(false)
      if (result.ok) continue
      expect(result.issues.some((i) => i.path === 'version')).toBe(true)
    }
  })

  it('rejects incomplete end states, naming the missing field path', () => {
    const result = parseJourneyRegistry(`
version: 1
journeys:
  - id: UJ-1
    title: Missing then
    criticality: standard
    surfaces: [cli]
    end_states:
      - { id: UJ-1.a, given: g, walk: w }
`)

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.issues.some((i) => i.path === 'journeys.0.end_states.0.then')).toBe(true)
  })
})

describe('JOURNEY_REGISTRY_PATH', () => {
  it('is the canonical repo-relative location', () => {
    expect(JOURNEY_REGISTRY_PATH).toBe('.substrate/acceptance/journeys.yaml')
  })
})
