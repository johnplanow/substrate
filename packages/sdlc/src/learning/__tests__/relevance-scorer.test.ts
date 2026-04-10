/**
 * Unit tests for RelevanceScorer.
 *
 * Story 53-6: Findings Injector with Relevance Scoring (AC1, AC7)
 */

import { describe, it, expect } from 'vitest'
import { scoreRelevance } from '../relevance-scorer.js'
import type { InjectionContext } from '../relevance-scorer.js'
import type { Finding } from '../types.js'

// ---------------------------------------------------------------------------
// Test helper: build a minimal valid Finding
// ---------------------------------------------------------------------------

function makeFinding(overrides: Partial<Finding> = {}): Finding {
  return {
    id: '00000000-0000-0000-0000-000000000001',
    run_id: 'run-1',
    story_key: '53-6',
    root_cause: 'build-failure',
    affected_files: [],
    description: 'Build failed after story dispatch',
    confidence: 'high',
    created_at: '2026-04-06T00:00:00.000Z',
    expires_after_runs: 5,
    ...overrides,
  }
}

function makeContext(overrides: Partial<InjectionContext> = {}): InjectionContext {
  return {
    storyKey: '53-6',
    runId: 'run-1',
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Tests: jaccardFileOverlap when targetFiles is empty
// ---------------------------------------------------------------------------

describe('scoreRelevance — jaccardFileOverlap', () => {
  it('returns jaccardFileOverlap=0 when targetFiles is empty (undefined)', () => {
    const finding = makeFinding({ affected_files: ['packages/sdlc/src/foo.ts'] })
    const ctx = makeContext({ targetFiles: undefined })
    // 0.5*0 + 0.3*0.5 + 0.2*0.5 = 0.25
    expect(scoreRelevance(finding, ctx)).toBeCloseTo(0.25)
  })

  it('returns jaccardFileOverlap=0 when targetFiles is empty array', () => {
    const finding = makeFinding({ affected_files: ['packages/sdlc/src/foo.ts'] })
    const ctx = makeContext({ targetFiles: [] })
    // 0.5*0 + 0.3*0.5 (no packageName) + 0.2*0.5 (no riskProfile) = 0.25
    expect(scoreRelevance(finding, ctx)).toBeCloseTo(0.25)
  })

  it('returns jaccardFileOverlap=0 when affected_files is empty', () => {
    const finding = makeFinding({ affected_files: [] })
    const ctx = makeContext({ targetFiles: ['packages/sdlc/src/foo.ts'] })
    // 0.5*0 + 0.3*0.5 + 0.2*0.5 = 0.25
    expect(scoreRelevance(finding, ctx)).toBeCloseTo(0.25)
  })

  it('returns jaccardFileOverlap=1.0 for perfect overlap (3 matching files)', () => {
    const files = ['packages/sdlc/src/a.ts', 'packages/sdlc/src/b.ts', 'packages/sdlc/src/c.ts']
    const finding = makeFinding({ affected_files: files })
    const ctx = makeContext({ targetFiles: [...files] })
    // jaccard = 3 / min(3,3) = 1.0
    // 0.5*1.0 + 0.3*0.5 + 0.2*0.5 = 0.5 + 0.15 + 0.1 = 0.75
    expect(scoreRelevance(finding, ctx)).toBeCloseTo(0.75)
  })

  it('returns jaccardFileOverlap=0.5 for partial overlap (2 of 4 files match)', () => {
    const finding = makeFinding({
      affected_files: [
        'packages/sdlc/src/a.ts',
        'packages/sdlc/src/b.ts',
        'packages/sdlc/src/c.ts',
        'packages/sdlc/src/d.ts',
      ],
    })
    const ctx = makeContext({
      targetFiles: [
        'packages/sdlc/src/a.ts',
        'packages/sdlc/src/b.ts',
        'packages/sdlc/src/x.ts',
        'packages/sdlc/src/y.ts',
      ],
    })
    // intersection = {a, b} = 2; min(4, 4) = 4; jaccard = 2/4 = 0.5
    // 0.5*0.5 + 0.3*0.5 + 0.2*0.5 = 0.25 + 0.15 + 0.1 = 0.5
    expect(scoreRelevance(finding, ctx)).toBeCloseTo(0.5)
  })

  it('caps target files to 20 shortest paths (26-file input → 20 used)', () => {
    // Generate 26 target files (20 short + 1 long + 5 extra) with varying lengths; shorter ones selected
    const shortFiles = Array.from({ length: 20 }, (_, i) => `src/a${i}.ts`) // 9-10 chars
    const longFile = 'packages/very/long/path/that/is/definitely/the/longest/file.ts'
    const extraFiles = Array.from({ length: 5 }, (_, i) => `packages/long${i}/src/extra/file.ts`)
    const allTargets = [...shortFiles, longFile, ...extraFiles]

    // Finding only overlaps with the long file (which would be excluded by cap)
    const finding = makeFinding({ affected_files: [longFile] })
    const ctx = makeContext({ targetFiles: allTargets })
    // The 20 shortest paths are the shortFiles (9-10 chars) + first 0 from extras
    // longFile is longer than all 20 shortFiles, so it gets excluded from cappedTargets
    // intersection = 0; jaccard = 0
    // 0.5*0 + 0.3*0.5 + 0.2*0.5 = 0.25
    expect(scoreRelevance(finding, ctx)).toBeCloseTo(0.25)
  })
})

// ---------------------------------------------------------------------------
// Tests: packageMatch
// ---------------------------------------------------------------------------

describe('scoreRelevance — packageMatch', () => {
  it('returns packageMatch=1.0 when packageName matches inferred package', () => {
    const finding = makeFinding({
      affected_files: ['packages/sdlc/src/foo.ts'],
    })
    const ctx = makeContext({ packageName: 'sdlc', targetFiles: [] })
    // 0.5*0 + 0.3*1.0 + 0.2*0.5 = 0 + 0.3 + 0.1 = 0.4
    expect(scoreRelevance(finding, ctx)).toBeCloseTo(0.4)
  })

  it('returns packageMatch=0.5 when packageName is undefined', () => {
    const finding = makeFinding({
      affected_files: ['packages/sdlc/src/foo.ts'],
    })
    const ctx = makeContext({ packageName: undefined, targetFiles: [] })
    // 0.5*0 + 0.3*0.5 + 0.2*0.5 = 0.25
    expect(scoreRelevance(finding, ctx)).toBeCloseTo(0.25)
  })

  it('returns packageMatch=0.0 when packageName is provided but does not match', () => {
    const finding = makeFinding({
      affected_files: ['packages/core/src/bar.ts'],
    })
    const ctx = makeContext({ packageName: 'sdlc', targetFiles: [] })
    // inferred package = 'core' ≠ 'sdlc' → packageMatch = 0.0
    // 0.5*0 + 0.3*0.0 + 0.2*0.5 = 0 + 0 + 0.1 = 0.1
    expect(scoreRelevance(finding, ctx)).toBeCloseTo(0.1)
  })

  it('returns packageMatch=0.5 when no package can be inferred from affected_files', () => {
    const finding = makeFinding({
      affected_files: ['src/utils/helper.ts'], // no 'packages/' prefix
    })
    const ctx = makeContext({ packageName: 'sdlc', targetFiles: [] })
    // inferredPackages = [] → packageMatch = 0.5
    // 0.5*0 + 0.3*0.5 + 0.2*0.5 = 0.25
    expect(scoreRelevance(finding, ctx)).toBeCloseTo(0.25)
  })
})

// ---------------------------------------------------------------------------
// Tests: rootCauseMatch
// ---------------------------------------------------------------------------

describe('scoreRelevance — rootCauseMatch', () => {
  it('returns rootCauseMatch=1.0 when riskProfile includes finding root_cause', () => {
    const finding = makeFinding({ root_cause: 'build-failure' })
    const ctx = makeContext({ riskProfile: ['build-failure'], targetFiles: [] })
    // 0.5*0 + 0.3*0.5 + 0.2*1.0 = 0 + 0.15 + 0.2 = 0.35
    expect(scoreRelevance(finding, ctx)).toBeCloseTo(0.35)
  })

  it('returns rootCauseMatch=0.5 when riskProfile is undefined', () => {
    const finding = makeFinding({ root_cause: 'build-failure' })
    const ctx = makeContext({ riskProfile: undefined, targetFiles: [] })
    // 0.5*0 + 0.3*0.5 + 0.2*0.5 = 0.25
    expect(scoreRelevance(finding, ctx)).toBeCloseTo(0.25)
  })

  it('returns rootCauseMatch=0.0 when riskProfile provided but does not match', () => {
    const finding = makeFinding({ root_cause: 'build-failure' })
    const ctx = makeContext({ riskProfile: ['namespace-collision'], targetFiles: [] })
    // 0.5*0 + 0.3*0.5 + 0.2*0.0 = 0 + 0.15 + 0 = 0.15
    expect(scoreRelevance(finding, ctx)).toBeCloseTo(0.15)
  })
})

// ---------------------------------------------------------------------------
// Tests: full formula verification with known inputs
// ---------------------------------------------------------------------------

describe('scoreRelevance — full formula', () => {
  it('computes correct score with all three components non-trivial', () => {
    // jaccard: files ['packages/sdlc/src/a.ts'] vs target ['packages/sdlc/src/a.ts']
    //   → intersection=1, min(1,1)=1 → jaccard=1.0
    // packageMatch: packageName='sdlc', affected_files has 'packages/sdlc/...' → 1.0
    // rootCauseMatch: riskProfile=['build-failure'], root_cause='build-failure' → 1.0
    // score = 0.5*1.0 + 0.3*1.0 + 0.2*1.0 = 1.0
    const finding = makeFinding({
      root_cause: 'build-failure',
      affected_files: ['packages/sdlc/src/a.ts'],
    })
    const ctx = makeContext({
      packageName: 'sdlc',
      riskProfile: ['build-failure'],
      targetFiles: ['packages/sdlc/src/a.ts'],
    })
    expect(scoreRelevance(finding, ctx)).toBeCloseTo(1.0)
  })

  it('score is clamped to [0, 1]', () => {
    // All components at max → score = 1.0 exactly (already tested above)
    // No component can go above its weight, so max is 1.0
    const finding = makeFinding({
      root_cause: 'test-failure',
      affected_files: ['packages/core/src/x.ts'],
    })
    const ctx = makeContext({
      packageName: 'core',
      riskProfile: ['test-failure'],
      targetFiles: ['packages/core/src/x.ts'],
    })
    const score = scoreRelevance(finding, ctx)
    expect(score).toBeGreaterThanOrEqual(0)
    expect(score).toBeLessThanOrEqual(1)
  })

  it('zero-overlap context with no packageName or riskProfile → 0.25', () => {
    // jaccard=0, packageMatch=0.5, rootCauseMatch=0.5
    // 0.5*0 + 0.3*0.5 + 0.2*0.5 = 0.25
    const finding = makeFinding({
      affected_files: ['packages/sdlc/src/foo.ts'],
    })
    const ctx = makeContext({ targetFiles: ['src/other.ts'] })
    expect(scoreRelevance(finding, ctx)).toBeCloseTo(0.25)
  })
})
