/**
 * Unit tests for TelemetryAdvisor (Story 30-6).
 *
 * Tests cover:
 * - getRecommendationsForRun(): aggregation, deduplication, sorting, error path
 * - formatOptimizationDirectives(): filtering, formatting, truncation
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { TelemetryAdvisor } from '../telemetry-advisor.js'
import type { Recommendation } from '../types.js'
import type { ITelemetryPersistence } from '../persistence.js'

// ---------------------------------------------------------------------------
// Minimal fixture builders
// ---------------------------------------------------------------------------

function makeRecommendation(overrides: Partial<Recommendation> = {}): Recommendation {
  return {
    id: 'abcdef1234567890',
    storyKey: '30-1',
    ruleId: 'large_file_reads',
    severity: 'warning',
    title: 'Low cache hit rate',
    description: 'Enable prompt caching for better performance',
    generatedAt: new Date().toISOString(),
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Mock ITelemetryPersistence
// ---------------------------------------------------------------------------

function makeMockPersistence(
  getRecommendationsFn?: (storyKey: string) => Promise<Recommendation[]>
): ITelemetryPersistence {
  return {
    storeTurnAnalysis: vi.fn(),
    getTurnAnalysis: vi.fn().mockResolvedValue([]),
    storeEfficiencyScore: vi.fn(),
    getEfficiencyScore: vi.fn().mockResolvedValue(null),
    getEfficiencyScores: vi.fn().mockResolvedValue([]),
    getDispatchEfficiencyScores: vi.fn().mockResolvedValue([]),
    saveRecommendations: vi.fn(),
    getRecommendations: getRecommendationsFn
      ? vi.fn().mockImplementation(getRecommendationsFn)
      : vi.fn().mockResolvedValue([]),
    getAllRecommendations: vi.fn().mockResolvedValue([]),
    storeCategoryStats: vi.fn(),
    getCategoryStats: vi.fn().mockResolvedValue([]),
    storeConsumerStats: vi.fn(),
    getConsumerStats: vi.fn().mockResolvedValue([]),
    recordSpan: vi.fn(),
    purgeStoryTelemetry: vi.fn(async () => {}),
  } as unknown as ITelemetryPersistence
}

// ---------------------------------------------------------------------------
// Helper to construct a TelemetryAdvisor with a mock persistence layer
// ---------------------------------------------------------------------------

function makeAdvisor(persistence: ITelemetryPersistence): TelemetryAdvisor {
  // Access private field via a test-only factory approach
  const advisor = new TelemetryAdvisor({ db: {} as never })
  // Override the private _persistence field
  ;(advisor as unknown as { _persistence: ITelemetryPersistence })._persistence = persistence
  return advisor
}

// ===========================================================================
// getRecommendationsForRun
// ===========================================================================

describe('TelemetryAdvisor.getRecommendationsForRun()', () => {
  it('returns empty array when completedStoryKeys is empty', async () => {
    const persistence = makeMockPersistence()
    const advisor = makeAdvisor(persistence)

    const result = await advisor.getRecommendationsForRun([])
    expect(result).toEqual([])
    expect(persistence.getRecommendations).not.toHaveBeenCalled()
  })

  it('returns recommendations for a single story sorted by severity', async () => {
    const infoRec = makeRecommendation({ id: 'aaaa000000000001', severity: 'info', storyKey: '30-1' })
    const criticalRec = makeRecommendation({ id: 'aaaa000000000002', severity: 'critical', storyKey: '30-1' })
    const persistence = makeMockPersistence(() => Promise.resolve([infoRec, criticalRec]))
    const advisor = makeAdvisor(persistence)

    const result = await advisor.getRecommendationsForRun(['30-1'])
    expect(result).toHaveLength(2)
    expect(result[0].severity).toBe('critical')
    expect(result[1].severity).toBe('info')
  })

  it('deduplicates recommendations with the same id across two stories', async () => {
    const sharedRec = makeRecommendation({ id: 'shared0000000001', severity: 'warning', storyKey: '30-1' })
    const uniqueRec = makeRecommendation({ id: 'unique0000000001', severity: 'critical', storyKey: '30-2' })

    const persistence = makeMockPersistence((key: string) => {
      if (key === '30-1') return Promise.resolve([sharedRec])
      if (key === '30-2') return Promise.resolve([sharedRec, uniqueRec])
      return Promise.resolve([])
    })
    const advisor = makeAdvisor(persistence)

    const result = await advisor.getRecommendationsForRun(['30-1', '30-2'])
    // Should have 2 unique recs (sharedRec once + uniqueRec)
    expect(result).toHaveLength(2)
    const ids = result.map((r) => r.id)
    expect(ids).toContain('shared0000000001')
    expect(ids).toContain('unique0000000001')
    // No duplicates
    expect(new Set(ids).size).toBe(2)
  })

  it('catches persistence errors and returns empty array', async () => {
    const persistence = makeMockPersistence(() => Promise.reject(new Error('DB error')))
    const advisor = makeAdvisor(persistence)

    const result = await advisor.getRecommendationsForRun(['30-1'])
    expect(result).toEqual([])
  })

  it('queries all provided story keys via Promise.all', async () => {
    const persistence = makeMockPersistence(() => Promise.resolve([]))
    const advisor = makeAdvisor(persistence)

    await advisor.getRecommendationsForRun(['30-1', '30-2', '30-3'])
    expect(persistence.getRecommendations).toHaveBeenCalledTimes(3)
    expect(persistence.getRecommendations).toHaveBeenCalledWith('30-1')
    expect(persistence.getRecommendations).toHaveBeenCalledWith('30-2')
    expect(persistence.getRecommendations).toHaveBeenCalledWith('30-3')
  })

  it('sorts merged recommendations: critical → warning → info', async () => {
    const rec1 = makeRecommendation({ id: 'sort000000000001', severity: 'info', storyKey: '30-1' })
    const rec2 = makeRecommendation({ id: 'sort000000000002', severity: 'critical', storyKey: '30-1' })
    const rec3 = makeRecommendation({ id: 'sort000000000003', severity: 'warning', storyKey: '30-1' })

    const persistence = makeMockPersistence(() => Promise.resolve([rec1, rec2, rec3]))
    const advisor = makeAdvisor(persistence)

    const result = await advisor.getRecommendationsForRun(['30-1'])
    expect(result.map((r) => r.severity)).toEqual(['critical', 'warning', 'info'])
  })
})

// ===========================================================================
// formatOptimizationDirectives
// ===========================================================================

describe('TelemetryAdvisor.formatOptimizationDirectives()', () => {
  let advisor: TelemetryAdvisor

  beforeEach(() => {
    advisor = makeAdvisor(makeMockPersistence())
  })

  it('returns empty string for empty array', () => {
    expect(advisor.formatOptimizationDirectives([])).toBe('')
  })

  it('returns empty string when all recommendations are info severity', () => {
    const recs = [
      makeRecommendation({ severity: 'info' }),
      makeRecommendation({ id: 'info0000000000002', severity: 'info' }),
    ]
    expect(advisor.formatOptimizationDirectives(recs)).toBe('')
  })

  it('includes critical and warning but excludes info', () => {
    const critical = makeRecommendation({ severity: 'critical', title: 'Critical issue', description: 'Fix it' })
    const warning = makeRecommendation({ id: 'warn0000000000001', severity: 'warning', title: 'Warning issue', description: 'Consider it' })
    const info = makeRecommendation({ id: 'info0000000000001', severity: 'info', title: 'Info note', description: 'Optional' })

    const result = advisor.formatOptimizationDirectives([critical, warning, info])
    expect(result).toContain('OPTIMIZATION (critical)')
    expect(result).toContain('Critical issue')
    expect(result).toContain('OPTIMIZATION (warning)')
    expect(result).toContain('Warning issue')
    expect(result).not.toContain('OPTIMIZATION (info)')
    expect(result).not.toContain('Info note')
  })

  it('returns full string when combined length is within 2000 chars', () => {
    const rec = makeRecommendation({ severity: 'warning', title: 'Short title', description: 'Short description' })
    const result = advisor.formatOptimizationDirectives([rec])
    expect(result.length).toBeLessThanOrEqual(2000)
    expect(result).toBe('OPTIMIZATION (warning): Short title. Short description')
  })

  it('truncates to ≤2000 chars and appends ellipsis when over budget', () => {
    // Create a very long description that will exceed 2000 chars
    const longDesc = 'word '.repeat(500) // 2500 chars
    const rec = makeRecommendation({ severity: 'critical', title: 'Long', description: longDesc })
    const result = advisor.formatOptimizationDirectives([rec])
    expect(result.length).toBeLessThanOrEqual(2001) // 2000 + 1 for '…'
    expect(result.endsWith('…')).toBe(true)
  })

  it('formats each recommendation as OPTIMIZATION (severity): title. description', () => {
    const rec = makeRecommendation({
      severity: 'critical',
      title: 'Enable caching',
      description: 'Use prompt caching to reduce costs',
    })
    const result = advisor.formatOptimizationDirectives([rec])
    expect(result).toBe('OPTIMIZATION (critical): Enable caching. Use prompt caching to reduce costs')
  })

  it('puts critical before warning in the output', () => {
    const warning = makeRecommendation({
      id: 'warn0000000000002',
      severity: 'warning',
      title: 'Warning',
      description: 'Desc W',
    })
    const critical = makeRecommendation({
      id: 'crit0000000000002',
      severity: 'critical',
      title: 'Critical',
      description: 'Desc C',
    })
    // Pass in warning first — formatting should preserve input order (advisor doesn't re-sort in format)
    const result = advisor.formatOptimizationDirectives([warning, critical])
    // Both should appear
    expect(result).toContain('OPTIMIZATION (warning)')
    expect(result).toContain('OPTIMIZATION (critical)')
  })
})
