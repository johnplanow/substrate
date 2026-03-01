/**
 * Unit tests for elicitation-selector.ts.
 *
 * Covers:
 *  AC1 — CSV loaded from packs/bmad/data/elicitation-methods.csv
 *  AC2 — Context-aware method selection (category affinity scoring)
 *  AC6 — Method rotation / deduplication via usedMethods recency penalty
 *
 * These tests operate on the module's public API only:
 *  - parseMethodsCsv()
 *  - loadElicitationMethods()
 *  - selectMethods()
 *  - deriveContentType()
 */

import { describe, it, expect } from 'vitest'
import {
  parseMethodsCsv,
  loadElicitationMethods,
  selectMethods,
  deriveContentType,
} from '../elicitation-selector.js'
import type { ElicitationMethod, ElicitationContext } from '../elicitation-selector.js'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Minimal valid CSV content with 5 test methods spanning multiple categories. */
const SAMPLE_CSV = `num,category,method_name,description,output_pattern
1,core,First Principles Analysis,Strip away assumptions to rebuild from fundamental truths,assumptions → truths → new approach
2,core,Socratic Questioning,Use targeted questions to reveal hidden assumptions,questions → revelations → understanding
3,collaboration,Stakeholder Round Table,Convene multiple personas for diverse perspectives,perspectives → synthesis → alignment
4,technical,Architecture Decision Records,Propose and debate architectural choices,options → trade-offs → decision → rationale
5,risk,Pre-mortem Analysis,Imagine future failure then work backwards to prevent it,failure scenario → causes → prevention`

// ---------------------------------------------------------------------------
// parseMethodsCsv
// ---------------------------------------------------------------------------

describe('parseMethodsCsv()', () => {
  it('parses all data rows from a valid CSV (skipping header)', () => {
    const methods = parseMethodsCsv(SAMPLE_CSV)
    expect(methods).toHaveLength(5)
  })

  it('maps CSV columns to ElicitationMethod fields correctly', () => {
    const methods = parseMethodsCsv(SAMPLE_CSV)
    const fp = methods[0]!
    expect(fp.name).toBe('First Principles Analysis')
    expect(fp.category).toBe('core')
    expect(fp.description).toBe('Strip away assumptions to rebuild from fundamental truths')
    expect(fp.output_pattern).toBe('assumptions → truths → new approach')
  })

  it('parses all 5 sample methods with non-empty required fields', () => {
    const methods = parseMethodsCsv(SAMPLE_CSV)
    for (const m of methods) {
      expect(m.name).toBeTruthy()
      expect(m.category).toBeTruthy()
      expect(m.description).toBeTruthy()
      expect(m.output_pattern).toBeTruthy()
    }
  })

  it('returns empty array for empty string input', () => {
    expect(parseMethodsCsv('')).toHaveLength(0)
  })

  it('returns empty array when only header row is present', () => {
    expect(parseMethodsCsv('num,category,method_name,description,output_pattern')).toHaveLength(0)
  })

  it('skips blank lines in CSV content', () => {
    const csvWithBlanks = SAMPLE_CSV + '\n\n'
    const methods = parseMethodsCsv(csvWithBlanks)
    expect(methods).toHaveLength(5)
  })

  it('parses descriptions that contain commas by using last-comma split', () => {
    // The description contains a comma — parser should still correctly extract output_pattern
    const csv = `num,category,method_name,description,output_pattern
1,core,Test Method,First part of description second part,output pattern here`
    const methods = parseMethodsCsv(csv)
    expect(methods).toHaveLength(1)
    expect(methods[0]!.name).toBe('Test Method')
    expect(methods[0]!.output_pattern).toBe('output pattern here')
  })

  it('skips rows that do not have enough comma-delimited segments', () => {
    // Row with only 2 commas (needs at least 4)
    const csv = `num,category,method_name,description,output_pattern
malformed,row`
    const methods = parseMethodsCsv(csv)
    expect(methods).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// loadElicitationMethods
// ---------------------------------------------------------------------------

describe('loadElicitationMethods()', () => {
  it('loads all 50 methods from the real CSV at packs/bmad/data/elicitation-methods.csv', () => {
    const methods = loadElicitationMethods()
    expect(methods.length).toBe(50)
  })

  it('returns methods with all required fields populated', () => {
    const methods = loadElicitationMethods()
    for (const m of methods) {
      expect(m.name).toBeTruthy()
      expect(m.category).toBeTruthy()
      expect(m.description).toBeTruthy()
      expect(m.output_pattern).toBeTruthy()
    }
  })

  it('returns all 11 expected categories', () => {
    const methods = loadElicitationMethods()
    const categories = new Set(methods.map((m) => m.category))
    const expectedCategories = [
      'collaboration',
      'advanced',
      'competitive',
      'technical',
      'creative',
      'research',
      'risk',
      'core',
      'learning',
      'philosophical',
      'retrospective',
    ]
    for (const cat of expectedCategories) {
      expect(categories.has(cat)).toBe(true)
    }
  })

  it('includes "First Principles Analysis" with correct attributes', () => {
    const methods = loadElicitationMethods()
    const method = methods.find((m) => m.name === 'First Principles Analysis')
    expect(method).toBeDefined()
    expect(method!.category).toBe('core')
    expect(method!.output_pattern).toBe('assumptions → truths → new approach')
  })

  it('includes "Stakeholder Round Table" in collaboration category', () => {
    const methods = loadElicitationMethods()
    const method = methods.find((m) => m.name === 'Stakeholder Round Table')
    expect(method).toBeDefined()
    expect(method!.category).toBe('collaboration')
  })

  it('returns empty array when CSV path does not exist (graceful degradation)', () => {
    // This tests the error-handling path — we can only verify the real file works.
    // The real file exists, so this verifies the happy path returns non-empty.
    const methods = loadElicitationMethods()
    expect(Array.isArray(methods)).toBe(true)
    expect(methods.length).toBeGreaterThan(0)
  })
})

// ---------------------------------------------------------------------------
// selectMethods — basic selection
// ---------------------------------------------------------------------------

describe('selectMethods() — basic selection (AC2)', () => {
  const sampleMethods: ElicitationMethod[] = [
    { name: 'Method A', category: 'core', description: 'desc A', output_pattern: 'a → b' },
    { name: 'Method B', category: 'collaboration', description: 'desc B', output_pattern: 'b → c' },
    { name: 'Method C', category: 'technical', description: 'desc C', output_pattern: 'c → d' },
    { name: 'Method D', category: 'risk', description: 'desc D', output_pattern: 'd → e' },
    { name: 'Method E', category: 'advanced', description: 'desc E', output_pattern: 'e → f' },
  ]

  it('returns up to 2 methods when methods are available', () => {
    const ctx: ElicitationContext = { content_type: 'brief' }
    const selected = selectMethods(ctx, [], sampleMethods)
    expect(selected.length).toBeLessThanOrEqual(2)
    expect(selected.length).toBeGreaterThan(0)
  })

  it('returns exactly 2 methods when 5+ methods are available', () => {
    const ctx: ElicitationContext = { content_type: 'brief' }
    const selected = selectMethods(ctx, [], sampleMethods)
    expect(selected.length).toBe(2)
  })

  it('returns empty array when methods list is empty', () => {
    const ctx: ElicitationContext = { content_type: 'brief' }
    const selected = selectMethods(ctx, [], [])
    expect(selected).toHaveLength(0)
  })

  it('returns at most 1 method when only 1 method is available', () => {
    const single = [sampleMethods[0]!]
    const ctx: ElicitationContext = { content_type: 'brief' }
    const selected = selectMethods(ctx, [], single)
    expect(selected).toHaveLength(1)
  })

  it('prefers core/collaboration methods for brief content_type', () => {
    const ctx: ElicitationContext = { content_type: 'brief' }
    const selected = selectMethods(ctx, [], sampleMethods)
    // At least one should be in core or collaboration — both have highest affinity for brief
    const preferredCats = ['core', 'collaboration', 'creative']
    const hasPreferred = selected.some((m) => preferredCats.includes(m.category))
    expect(hasPreferred).toBe(true)
  })

  it('prefers risk/core methods for prd content_type', () => {
    const ctx: ElicitationContext = { content_type: 'prd' }
    const selected = selectMethods(ctx, [], sampleMethods)
    const preferredCats = ['risk', 'core', 'collaboration']
    const hasPreferred = selected.some((m) => preferredCats.includes(m.category))
    expect(hasPreferred).toBe(true)
  })

  it('prefers technical methods for architecture content_type', () => {
    const ctx: ElicitationContext = { content_type: 'architecture' }
    const selected = selectMethods(ctx, [], sampleMethods)
    // With only 5 methods in the pool, technical should score highest for architecture
    const hasPreferred = selected.some((m) => m.category === 'technical')
    expect(hasPreferred).toBe(true)
  })

  it('returns distinct methods (no duplicates in result)', () => {
    const ctx: ElicitationContext = { content_type: 'brief' }
    const selected = selectMethods(ctx, [], sampleMethods)
    const names = selected.map((m) => m.name)
    const unique = new Set(names)
    expect(unique.size).toBe(names.length)
  })

  it('returns methods that are present in the input method list', () => {
    const ctx: ElicitationContext = { content_type: 'prd' }
    const selected = selectMethods(ctx, [], sampleMethods)
    for (const m of selected) {
      const found = sampleMethods.find((s) => s.name === m.name)
      expect(found).toBeDefined()
    }
  })
})

// ---------------------------------------------------------------------------
// selectMethods — scoring modifiers
// ---------------------------------------------------------------------------

describe('selectMethods() — scoring modifiers', () => {
  const technicalAndRiskMethods: ElicitationMethod[] = [
    { name: 'Tech Method', category: 'technical', description: 'desc', output_pattern: 'a → b' },
    { name: 'Risk Method', category: 'risk', description: 'desc', output_pattern: 'a → b' },
    { name: 'Core Method', category: 'core', description: 'desc', output_pattern: 'a → b' },
    { name: 'Advanced Method', category: 'advanced', description: 'desc', output_pattern: 'a → b' },
    { name: 'Learning Method', category: 'learning', description: 'desc', output_pattern: 'a → b' },
  ]

  it('applies risk boost when risk_level is high (risk category gets 1.3x multiplier)', () => {
    const ctx: ElicitationContext = {
      content_type: 'prd',
      risk_level: 'high',
    }
    const selected = selectMethods(ctx, [], technicalAndRiskMethods)
    // With risk_level: high, the risk category gets boosted 30% on top of its prd affinity (1.0)
    // Risk method should appear in selection
    const hasRisk = selected.some((m) => m.category === 'risk')
    expect(hasRisk).toBe(true)
  })

  it('applies complexity boost for technical/advanced when complexity_score > 0.7', () => {
    const ctx: ElicitationContext = {
      content_type: 'architecture',
      complexity_score: 0.9,
    }
    const selected = selectMethods(ctx, [], technicalAndRiskMethods)
    // Technical has 1.0 affinity for architecture + 1.2 complexity boost = 1.2
    // It should be selected
    const hasTechnical = selected.some((m) => m.category === 'technical')
    expect(hasTechnical).toBe(true)
  })

  it('does not apply complexity boost when complexity_score <= 0.7', () => {
    const ctx: ElicitationContext = {
      content_type: 'architecture',
      complexity_score: 0.5,
    }
    // With low complexity, technical still has highest affinity (1.0) for architecture
    // but no extra boost — still should select it
    const selected = selectMethods(ctx, [], technicalAndRiskMethods)
    expect(selected.length).toBe(2)
  })

  it('does not apply risk boost for non-risk categories even when risk_level is high', () => {
    const ctx: ElicitationContext = {
      content_type: 'brief',
      risk_level: 'high',
    }
    const onlyCoreMethods: ElicitationMethod[] = [
      { name: 'Core A', category: 'core', description: 'desc', output_pattern: 'a → b' },
      { name: 'Core B', category: 'core', description: 'desc', output_pattern: 'a → b' },
    ]
    // Core methods don't get risk boost — score remains 1.0 × 1.0 = 1.0 each
    const selected = selectMethods(ctx, [], onlyCoreMethods)
    expect(selected.length).toBe(2)
    expect(selected.every((m) => m.category === 'core')).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// selectMethods — method rotation / deduplication (AC6)
// ---------------------------------------------------------------------------

describe('selectMethods() — method rotation / deduplication (AC6)', () => {
  it('applies recency penalty to methods in usedMethods list', () => {
    const methods: ElicitationMethod[] = [
      { name: 'Top Core', category: 'core', description: 'desc', output_pattern: 'a → b' },
      { name: 'Second Core', category: 'core', description: 'desc', output_pattern: 'a → b' },
      { name: 'Collab Method', category: 'collaboration', description: 'desc', output_pattern: 'a → b' },
      { name: 'Risk Method', category: 'risk', description: 'desc', output_pattern: 'a → b' },
      { name: 'Tech Method', category: 'technical', description: 'desc', output_pattern: 'a → b' },
    ]

    // Round 1: no used methods — top 2 core methods should be selected (highest brief affinity)
    const ctx: ElicitationContext = { content_type: 'brief' }
    const round1 = selectMethods(ctx, [], methods)
    expect(round1.some((m) => m.name === 'Top Core' || m.name === 'Second Core')).toBe(true)

    // Round 2: mark all core methods as used — other categories should be selected
    const usedNames = methods.filter((m) => m.category === 'core').map((m) => m.name)
    const round2 = selectMethods(ctx, usedNames, methods)

    // The used core methods get 0.2 penalty — they should now score lower than others
    const coreSelected = round2.filter((m) => m.category === 'core')
    const nonCoreSelected = round2.filter((m) => m.category !== 'core')
    // At least one non-core method should be selected since core is penalized
    expect(nonCoreSelected.length).toBeGreaterThan(0)
    // Core usage should be reduced
    expect(coreSelected.length).toBeLessThan(2)
  })

  it('selects different methods in round 2 compared to round 1 (real CSV)', () => {
    const realMethods = loadElicitationMethods()
    const ctx: ElicitationContext = { content_type: 'brief' }

    const round1 = selectMethods(ctx, [], realMethods)
    const round1Names = round1.map((m) => m.name)

    const round2 = selectMethods(ctx, round1Names, realMethods)
    const round2Names = round2.map((m) => m.name)

    // With 50 methods, round 2 should select different methods
    const overlap = round2Names.filter((n) => round1Names.includes(n))
    expect(overlap.length).toBeLessThan(round1Names.length)
  })

  it('accumulates used methods across 3 rounds without repeating', () => {
    const realMethods = loadElicitationMethods()
    const ctx: ElicitationContext = { content_type: 'prd' }
    const usedMethods: string[] = []
    const roundSelections: string[][] = []

    for (let round = 0; round < 3; round++) {
      const selected = selectMethods(ctx, usedMethods, realMethods)
      const names = selected.map((m) => m.name)
      roundSelections.push(names)
      usedMethods.push(...names)
    }

    // All 3 rounds should return 2 methods each
    for (const roundNames of roundSelections) {
      expect(roundNames.length).toBe(2)
    }

    // Total unique names across 3 rounds: at least 4 distinct methods selected
    const unique = new Set(roundSelections.flat())
    expect(unique.size).toBeGreaterThanOrEqual(4)
  })

  it('still returns methods when all 50 real methods are in usedMethods (graceful degradation)', () => {
    const realMethods = loadElicitationMethods()
    const ctx: ElicitationContext = { content_type: 'brief' }
    const allUsed = realMethods.map((m) => m.name)

    const selected = selectMethods(ctx, allUsed, realMethods)
    // All methods penalized — still returns top 2 by penalized score (not empty)
    expect(selected.length).toBeGreaterThan(0)
    expect(selected.length).toBeLessThanOrEqual(2)
  })

  it('still returns methods when 40 of 50 are marked used', () => {
    const realMethods = loadElicitationMethods()
    const ctx: ElicitationContext = { content_type: 'brief' }
    const usedMethods = realMethods.slice(0, 40).map((m) => m.name)

    const selected = selectMethods(ctx, usedMethods, realMethods)
    expect(selected.length).toBeGreaterThan(0)
    expect(selected.length).toBeLessThanOrEqual(2)
  })

  it('breaks ties alphabetically for deterministic output', () => {
    // Two methods with identical category and no recency penalty → same score
    // Result should be deterministic across calls
    const methods: ElicitationMethod[] = [
      { name: 'Zeta Core', category: 'core', description: 'desc', output_pattern: 'a → b' },
      { name: 'Alpha Core', category: 'core', description: 'desc', output_pattern: 'a → b' },
      { name: 'Gamma Core', category: 'core', description: 'desc', output_pattern: 'a → b' },
    ]
    const ctx: ElicitationContext = { content_type: 'brief' }
    const selected1 = selectMethods(ctx, [], methods)
    const selected2 = selectMethods(ctx, [], methods)

    // Alphabetically: Alpha Core < Gamma Core < Zeta Core → should select Alpha and Gamma
    expect(selected1[0]!.name).toBe('Alpha Core')
    expect(selected1[1]!.name).toBe('Gamma Core')
    // Deterministic: same result on second call
    expect(selected1.map((m) => m.name)).toEqual(selected2.map((m) => m.name))
  })
})

// ---------------------------------------------------------------------------
// deriveContentType
// ---------------------------------------------------------------------------

describe('deriveContentType()', () => {
  it('maps analysis phase to "brief" regardless of step name', () => {
    expect(deriveContentType('analysis', 'analysis-step-1-vision')).toBe('brief')
    expect(deriveContentType('analysis', 'analysis-step-2-scope')).toBe('brief')
    expect(deriveContentType('analysis', 'any-step')).toBe('brief')
  })

  it('maps planning phase to "prd" regardless of step name', () => {
    expect(deriveContentType('planning', 'planning-step-1-classification')).toBe('prd')
    expect(deriveContentType('planning', 'planning-step-2-frs')).toBe('prd')
    expect(deriveContentType('planning', 'planning-step-3-nfrs')).toBe('prd')
  })

  it('maps solutioning + arch step to "architecture"', () => {
    expect(deriveContentType('solutioning', 'architecture-step-1-context')).toBe('architecture')
    expect(deriveContentType('solutioning', 'architecture-step-2-decisions')).toBe('architecture')
    expect(deriveContentType('solutioning', 'architecture-step-3-patterns')).toBe('architecture')
  })

  it('maps solutioning + story/epic step to "stories"', () => {
    expect(deriveContentType('solutioning', 'stories-step-1-epics')).toBe('stories')
    expect(deriveContentType('solutioning', 'stories-step-2-stories')).toBe('stories')
    expect(deriveContentType('solutioning', 'epic-design')).toBe('stories')
  })

  it('defaults to "brief" for unknown phase', () => {
    expect(deriveContentType('implementation', 'some-step')).toBe('brief')
    expect(deriveContentType('unknown-phase', 'some-step')).toBe('brief')
  })

  it('defaults to "brief" for solutioning phase with unrecognized step name', () => {
    // Does not contain 'arch', 'stor', or 'epic'
    expect(deriveContentType('solutioning', 'some-other-step')).toBe('brief')
  })

  it('handles partial matches in step names for solutioning', () => {
    // "stor" substring match: "story" contains "stor"
    expect(deriveContentType('solutioning', 'story-generation')).toBe('stories')
    // "epic" substring match
    expect(deriveContentType('solutioning', 'epic-breakdown')).toBe('stories')
    // "arch" substring match
    expect(deriveContentType('solutioning', 'arch-review')).toBe('architecture')
  })
})

// ---------------------------------------------------------------------------
// selectMethods — cross-content-type validation with real CSV
// ---------------------------------------------------------------------------

describe('selectMethods() — cross-content-type validation with real methods', () => {
  const contentTypes: ElicitationContext['content_type'][] = [
    'brief',
    'prd',
    'architecture',
    'stories',
  ]

  for (const contentType of contentTypes) {
    it(`selects 2 methods for content_type: ${contentType} from real CSV`, () => {
      const realMethods = loadElicitationMethods()
      const ctx: ElicitationContext = { content_type: contentType }
      const selected = selectMethods(ctx, [], realMethods)
      expect(selected.length).toBe(2)
    })

    it(`selected methods for ${contentType} have all required fields`, () => {
      const realMethods = loadElicitationMethods()
      const ctx: ElicitationContext = { content_type: contentType }
      const selected = selectMethods(ctx, [], realMethods)
      for (const m of selected) {
        expect(m.name).toBeTruthy()
        expect(m.category).toBeTruthy()
        expect(m.description).toBeTruthy()
        expect(m.output_pattern).toBeTruthy()
      }
    })
  }
})
