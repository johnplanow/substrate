/**
 * Unit tests for elicitation-selector.ts (Story 16.3).
 *
 * Covers:
 *  - parseMethodsCsv: parses CSV with header into ElicitationMethod objects
 *  - loadElicitationMethods: loads from real CSV file (integration-style)
 *  - selectMethods: returns 1-2 methods, applies recency penalty, prefers affinity categories
 *  - deriveContentType: maps phase/step names to content types
 */

import { describe, it, expect } from 'vitest'
import {
  parseMethodsCsv,
  loadElicitationMethods,
  selectMethods,
  deriveContentType,
} from './elicitation-selector.js'
import type { ElicitationContext, ElicitationMethod } from './elicitation-selector.js'

// ---------------------------------------------------------------------------
// Helpers — minimal test fixtures
// ---------------------------------------------------------------------------

function makeMethod(
  name: string,
  category: string,
  description = 'A test method.',
  output_pattern = 'input → output',
): ElicitationMethod {
  return { name, category, description, output_pattern }
}

// A small CSV with one method per relevant category
const SAMPLE_CSV = `num,category,method_name,description,output_pattern
1,core,First Principles Analysis,Strip away assumptions to rebuild from fundamental truths,assumptions → truths → new approach
2,collaboration,Stakeholder Round Table,Convene multiple personas to contribute diverse perspectives,perspectives → synthesis → alignment
3,risk,Pre-mortem Analysis,Imagine future failure then work backwards to prevent it,failure scenario → causes → prevention
4,technical,Architecture Decision Records,Multiple architect personas propose and debate architectural choices,options → trade-offs → decision → rationale
5,creative,SCAMPER Method,Apply seven creativity lenses,S→C→A→M→P→E→R
6,research,Literature Review Personas,Optimist researcher + skeptic researcher + synthesizer review sources,sources → critiques → synthesis
7,advanced,Tree of Thoughts,Explore multiple reasoning paths simultaneously then evaluate,paths → evaluation → selection
8,competitive,Red Team vs Blue Team,Adversarial attack-defend analysis to find vulnerabilities,defense → attack → hardening
9,learning,Feynman Technique,Explain complex concepts simply as if teaching a child,complex → simple → gaps → mastery
10,philosophical,Occam's Razor Application,Find the simplest sufficient explanation by eliminating complexity,options → simplification → selection
11,retrospective,Hindsight Reflection,Imagine looking back from the future to gain perspective,future view → insights → application
`

// ---------------------------------------------------------------------------
// parseMethodsCsv
// ---------------------------------------------------------------------------

describe('parseMethodsCsv', () => {
  it('returns empty array for empty content', () => {
    expect(parseMethodsCsv('')).toEqual([])
    expect(parseMethodsCsv('\n')).toEqual([])
  })

  it('returns empty array for header-only content', () => {
    expect(parseMethodsCsv('num,category,method_name,description,output_pattern')).toEqual([])
  })

  it('parses a single data row correctly', () => {
    const csv = `num,category,method_name,description,output_pattern
1,core,First Principles Analysis,Strip away assumptions to rebuild from fundamental truths,assumptions → truths → new approach
`
    const methods = parseMethodsCsv(csv)
    expect(methods).toHaveLength(1)
    expect(methods[0]).toEqual({
      name: 'First Principles Analysis',
      category: 'core',
      description: 'Strip away assumptions to rebuild from fundamental truths',
      output_pattern: 'assumptions → truths → new approach',
    })
  })

  it('parses multiple rows from sample CSV', () => {
    const methods = parseMethodsCsv(SAMPLE_CSV)
    expect(methods.length).toBe(11)
  })

  it('correctly extracts all fields for every row in sample CSV', () => {
    const methods = parseMethodsCsv(SAMPLE_CSV)
    for (const method of methods) {
      expect(method.name).toBeTruthy()
      expect(method.category).toBeTruthy()
      expect(method.description).toBeTruthy()
      expect(method.output_pattern).toBeTruthy()
    }
  })

  it('correctly parses row with arrows in output_pattern', () => {
    const csv = `num,category,method_name,description,output_pattern
1,core,5 Whys Deep Dive,Repeatedly ask why to drill down to root causes,why chain → root cause → solution
`
    const methods = parseMethodsCsv(csv)
    expect(methods).toHaveLength(1)
    expect(methods[0]!.output_pattern).toBe('why chain → root cause → solution')
  })

  it('skips blank lines', () => {
    const csv = `num,category,method_name,description,output_pattern
1,core,First Principles Analysis,Strip away assumptions,assumptions → truths

2,collaboration,Stakeholder Round Table,Convene multiple personas,perspectives → synthesis
`
    const methods = parseMethodsCsv(csv)
    expect(methods).toHaveLength(2)
  })

  it('skips rows with insufficient comma count', () => {
    const csv = `num,category,method_name,description,output_pattern
1,core,Method Without Enough Commas
2,collaboration,Stakeholder Round Table,Convene multiple personas,perspectives → synthesis
`
    const methods = parseMethodsCsv(csv)
    // Row 1 doesn't have enough commas, should be skipped
    expect(methods).toHaveLength(1)
    expect(methods[0]!.name).toBe('Stakeholder Round Table')
  })
})

// ---------------------------------------------------------------------------
// loadElicitationMethods (integration-style — uses real CSV on disk)
// ---------------------------------------------------------------------------

describe('loadElicitationMethods', () => {
  it('loads all 50 methods from the real CSV file', () => {
    const methods = loadElicitationMethods()
    expect(methods.length).toBe(50)
  })

  it('all loaded methods have required non-empty fields', () => {
    const methods = loadElicitationMethods()
    for (const method of methods) {
      expect(method.name).toBeTruthy()
      expect(method.category).toBeTruthy()
      expect(method.description).toBeTruthy()
      expect(method.output_pattern).toBeTruthy()
    }
  })

  it('loaded methods include all expected categories', () => {
    const methods = loadElicitationMethods()
    const categories = new Set(methods.map((m) => m.category))
    const expectedCategories = [
      'core',
      'collaboration',
      'risk',
      'technical',
      'creative',
      'research',
      'advanced',
      'competitive',
      'learning',
      'philosophical',
      'retrospective',
    ]
    for (const cat of expectedCategories) {
      expect(categories.has(cat)).toBe(true)
    }
  })

  it('real CSV contains "First Principles Analysis" in core category', () => {
    const methods = loadElicitationMethods()
    const fp = methods.find((m) => m.name === 'First Principles Analysis')
    expect(fp).toBeDefined()
    expect(fp!.category).toBe('core')
    expect(fp!.output_pattern).toBe('assumptions → truths → new approach')
  })
})

// ---------------------------------------------------------------------------
// selectMethods
// ---------------------------------------------------------------------------

describe('selectMethods', () => {
  // Build a method pool from the sample CSV (11 methods)
  const sampleMethods = parseMethodsCsv(SAMPLE_CSV)

  it('returns 2 methods when pool has more than 2', () => {
    const ctx: ElicitationContext = { content_type: 'brief' }
    const selected = selectMethods(ctx, [], sampleMethods)
    expect(selected.length).toBe(2)
  })

  it('returns 1 method when pool has only 1', () => {
    const singleMethod = [makeMethod('Only Method', 'core')]
    const ctx: ElicitationContext = { content_type: 'brief' }
    const selected = selectMethods(ctx, [], singleMethod)
    expect(selected.length).toBe(1)
  })

  it('returns 0 methods when pool is empty', () => {
    const ctx: ElicitationContext = { content_type: 'brief' }
    const selected = selectMethods(ctx, [], [])
    expect(selected.length).toBe(0)
  })

  it('returns 2 distinct methods (no duplicates)', () => {
    const ctx: ElicitationContext = { content_type: 'brief' }
    const selected = selectMethods(ctx, [], sampleMethods)
    const names = selected.map((m) => m.name)
    const unique = new Set(names)
    expect(unique.size).toBe(names.length)
  })

  it('applies recency penalty: used methods score lower and get deprioritized', () => {
    // Build a pool with only core and collaboration methods (both very high affinity for brief)
    const tightPool: ElicitationMethod[] = [
      makeMethod('Method Core A', 'core'),
      makeMethod('Method Core B', 'core'),
      makeMethod('Method Collab A', 'collaboration'),
      makeMethod('Method Collab B', 'collaboration'),
      makeMethod('Method Risk A', 'risk'),
    ]
    const ctx: ElicitationContext = { content_type: 'brief' }

    // Round 1: select top 2 (should be core/collaboration)
    const round1 = selectMethods(ctx, [], tightPool)
    const round1Names = round1.map((m) => m.name)

    // Round 2: mark round1 methods as used — should prefer other methods now
    const round2 = selectMethods(ctx, round1Names, tightPool)
    const round2Names = round2.map((m) => m.name)

    // The round-2 methods should differ from round-1 methods
    const overlap = round2Names.filter((n) => round1Names.includes(n))
    expect(overlap.length).toBeLessThan(round1Names.length)
  })

  it('prefers high-affinity categories for brief content type', () => {
    // brief affinities: core=1.0, collaboration=0.9, creative=0.8, risk=0.4, technical=0.2
    const ctx: ElicitationContext = { content_type: 'brief' }
    const selected = selectMethods(ctx, [], sampleMethods)
    // Top selections should come from core, collaboration, or creative
    const highAffinityCategories = ['core', 'collaboration', 'creative']
    const hasHighAffinity = selected.some((m) => highAffinityCategories.includes(m.category))
    expect(hasHighAffinity).toBe(true)
  })

  it('prefers technical and competitive for architecture content type', () => {
    // architecture affinities: technical=1.0, competitive=0.9, risk=0.8, core=0.5
    const ctx: ElicitationContext = { content_type: 'architecture' }
    const selected = selectMethods(ctx, [], sampleMethods)
    const highAffinityCategories = ['technical', 'competitive', 'risk']
    const hasHighAffinity = selected.some((m) => highAffinityCategories.includes(m.category))
    expect(hasHighAffinity).toBe(true)
  })

  it('prefers risk and core methods for prd content type', () => {
    // prd affinities: risk=1.0, core=0.9, research=0.8, collaboration=0.6
    const ctx: ElicitationContext = { content_type: 'prd' }
    const selected = selectMethods(ctx, [], sampleMethods)
    const highAffinityCategories = ['risk', 'core', 'research', 'collaboration']
    const hasHighAffinity = selected.some((m) => highAffinityCategories.includes(m.category))
    expect(hasHighAffinity).toBe(true)
  })

  it('boosts risk category methods when risk_level is high', () => {
    // Build a pool with only risk and core methods, both with non-zero affinity for prd
    const riskPool: ElicitationMethod[] = [
      makeMethod('Risk Method A', 'risk'),
      makeMethod('Risk Method B', 'risk'),
      makeMethod('Core Method A', 'core'),
    ]
    const ctx: ElicitationContext = { content_type: 'prd', risk_level: 'high' }
    const selected = selectMethods(ctx, [], riskPool)
    // With high risk_level, risk methods get boosted — should appear in top 2
    const riskSelected = selected.filter((m) => m.category === 'risk')
    // prd: risk=1.0*1.3(riskBoost)=1.3 vs core=0.9 — risk should dominate
    expect(riskSelected.length).toBeGreaterThan(0)
  })

  it('boosts technical/advanced methods when complexity_score > 0.7', () => {
    // Build a pool where technical and advanced compete with core (normally lower for brief)
    const techPool: ElicitationMethod[] = [
      makeMethod('Technical Method', 'technical'),
      makeMethod('Advanced Method', 'advanced'),
      makeMethod('Core Method', 'core'),
      makeMethod('Creative Method', 'creative'),
    ]
    // For architecture content type: technical=1.0, advanced=0.5
    // With complexity_score > 0.7, both get *1.2 boost
    const ctx: ElicitationContext = { content_type: 'architecture', complexity_score: 0.9 }
    const selected = selectMethods(ctx, [], techPool)
    const technicalSelected = selected.filter(
      (m) => m.category === 'technical' || m.category === 'advanced',
    )
    expect(technicalSelected.length).toBeGreaterThan(0)
  })

  it('still returns methods when all have been used (graceful degradation)', () => {
    const ctx: ElicitationContext = { content_type: 'brief' }
    const usedMethods = sampleMethods.map((m) => m.name)
    const selected = selectMethods(ctx, usedMethods, sampleMethods)
    // Methods still returned, just with recency penalty applied
    expect(selected.length).toBeGreaterThan(0)
    expect(selected.length).toBeLessThanOrEqual(2)
  })

  it('method selection is deterministic (same inputs → same outputs)', () => {
    const ctx: ElicitationContext = { content_type: 'brief' }
    const selected1 = selectMethods(ctx, [], sampleMethods)
    const selected2 = selectMethods(ctx, [], sampleMethods)
    expect(selected1.map((m) => m.name)).toEqual(selected2.map((m) => m.name))
  })

  it('returns methods from the real 50-method pool (integration check)', () => {
    const realMethods = loadElicitationMethods()
    const ctx: ElicitationContext = { content_type: 'brief' }
    const selected = selectMethods(ctx, [], realMethods)
    expect(selected.length).toBe(2)
    for (const method of selected) {
      const found = realMethods.find((m) => m.name === method.name)
      expect(found).toBeDefined()
    }
  })
})

// ---------------------------------------------------------------------------
// deriveContentType
// ---------------------------------------------------------------------------

describe('deriveContentType', () => {
  it('maps analysis phase to brief', () => {
    expect(deriveContentType('analysis', 'analysis-step-1-vision')).toBe('brief')
    expect(deriveContentType('analysis', 'analysis-step-2-scope')).toBe('brief')
    expect(deriveContentType('analysis', 'anything')).toBe('brief')
  })

  it('maps planning phase to prd', () => {
    expect(deriveContentType('planning', 'planning-step-1-classification')).toBe('prd')
    expect(deriveContentType('planning', 'planning-step-2-frs')).toBe('prd')
    expect(deriveContentType('planning', 'planning-step-3-nfrs')).toBe('prd')
  })

  it('maps solutioning + arch step to architecture', () => {
    expect(deriveContentType('solutioning', 'architecture-step-1-context')).toBe('architecture')
    expect(deriveContentType('solutioning', 'architecture-step-2-decisions')).toBe('architecture')
    expect(deriveContentType('solutioning', 'arch-patterns')).toBe('architecture')
  })

  it('maps solutioning + stories step to stories', () => {
    expect(deriveContentType('solutioning', 'stories-step-1-epics')).toBe('stories')
    expect(deriveContentType('solutioning', 'stories-step-2-stories')).toBe('stories')
    expect(deriveContentType('solutioning', 'epic-design')).toBe('stories')
  })

  it('maps solutioning + epic step to stories', () => {
    expect(deriveContentType('solutioning', 'epic-refinement')).toBe('stories')
  })

  it('returns brief as default for unknown phase', () => {
    expect(deriveContentType('unknown', 'some-step')).toBe('brief')
    expect(deriveContentType('', '')).toBe('brief')
  })

  it('returns brief as default for solutioning phase with non-arch non-story step', () => {
    expect(deriveContentType('solutioning', 'some-other-step')).toBe('brief')
  })
})
