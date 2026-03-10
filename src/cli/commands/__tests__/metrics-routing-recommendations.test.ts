// @vitest-environment node
/**
 * Unit tests for `substrate metrics --routing-recommendations` (Story 28-8, AC3).
 *
 * Verifies:
 * - MetricsOptions accepts routingRecommendations field
 * - Text mode prints "Routing Recommendations:" header
 * - Text mode prints "No recommendations yet" when insufficientData is true
 * - Text mode prints one row per recommendation when results exist
 * - JSON mode emits { recommendations, analysisRuns, insufficientData }
 * - Exit code is always 0
 * - StateStore is initialized and closed
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { MetricsOptions } from '../metrics.js'

// ---------------------------------------------------------------------------
// Mocks — set up before any imports of the module under test
// ---------------------------------------------------------------------------

vi.mock('../../../utils/git-root.js', () => ({
  resolveMainRepoRoot: vi.fn().mockResolvedValue('/tmp/test-project'),
}))

vi.mock('fs', () => ({
  existsSync: vi.fn().mockReturnValue(false),
}))

vi.mock('fs/promises', () => ({
  readFile: vi.fn(),
}))

vi.mock('../../../persistence/database.js', () => ({
  DatabaseWrapper: vi.fn().mockImplementation(() => ({
    open: vi.fn(),
    close: vi.fn(),
    db: {},
  })),
}))

vi.mock('../../../persistence/migrations/index.js', () => ({
  runMigrations: vi.fn(),
}))

vi.mock('../../../persistence/queries/metrics.js', () => ({
  listRunMetrics: vi.fn().mockReturnValue([]),
  getRunMetrics: vi.fn().mockReturnValue(null),
  tagRunAsBaseline: vi.fn(),
  compareRunMetrics: vi.fn().mockReturnValue(null),
}))

vi.mock('../../../persistence/queries/decisions.js', () => ({
  getDecisionsByCategory: vi.fn().mockReturnValue([]),
}))

vi.mock('../../../persistence/schemas/operational.js', () => ({
  STORY_METRICS: 'story-metrics',
}))

vi.mock('../../../utils/logger.js', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
  }),
}))

vi.mock('better-sqlite3', () => ({
  default: vi.fn().mockImplementation(() => ({ close: vi.fn() })),
}))

vi.mock('../../../modules/telemetry/index.js', () => ({
  TelemetryPersistence: vi.fn().mockImplementation(() => ({})),
}))

// ---------------------------------------------------------------------------
// Mock StateStore
// ---------------------------------------------------------------------------

const mockStateStore = {
  initialize: vi.fn().mockResolvedValue(undefined),
  close: vi.fn().mockResolvedValue(undefined),
  getMetric: vi.fn().mockResolvedValue(undefined),
  setMetric: vi.fn().mockResolvedValue(undefined),
  queryMetrics: vi.fn().mockResolvedValue([]),
  getStoryState: vi.fn().mockResolvedValue(undefined),
  setStoryState: vi.fn().mockResolvedValue(undefined),
  queryStories: vi.fn().mockResolvedValue([]),
  getContracts: vi.fn().mockResolvedValue([]),
  setContracts: vi.fn().mockResolvedValue(undefined),
  branchForStory: vi.fn().mockResolvedValue(undefined),
  mergeStory: vi.fn().mockResolvedValue(undefined),
  rollbackStory: vi.fn().mockResolvedValue(undefined),
  diffStory: vi.fn().mockResolvedValue({ storyKey: '', tables: [] }),
  getHistory: vi.fn().mockResolvedValue([]),
}

vi.mock('../../../modules/state/index.js', () => ({
  createStateStore: vi.fn().mockReturnValue(mockStateStore),
  FileStateStore: vi.fn().mockImplementation(() => ({
    initialize: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    getMetric: vi.fn().mockResolvedValue(undefined),
  })),
}))

// ---------------------------------------------------------------------------
// Mock RoutingRecommender
// ---------------------------------------------------------------------------

const mockAnalyze = vi.fn()

vi.mock('../../../modules/routing/index.js', () => ({
  RoutingRecommender: vi.fn().mockImplementation(() => ({
    analyze: mockAnalyze,
  })),
  loadModelRoutingConfig: vi.fn().mockReturnValue({
    version: 1,
    phases: {},
    baseline_model: 'claude-sonnet',
  }),
}))

// ---------------------------------------------------------------------------
// Output capture helpers
// ---------------------------------------------------------------------------

function captureStdout(): { output: () => string; restore: () => void } {
  const writes: string[] = []
  const orig = process.stdout.write.bind(process.stdout)
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
    writes.push(String(chunk))
    return true
  })
  return {
    output: () => writes.join(''),
    restore: () => {
      process.stdout.write = orig
    },
  }
}

// ---------------------------------------------------------------------------
// Shared default analysis results
// ---------------------------------------------------------------------------

function makeInsufficientAnalysis() {
  return {
    recommendations: [],
    analysisRuns: 0,
    insufficientData: true,
    phaseOutputRatios: {},
  }
}

function makeRecommendationAnalysis() {
  return {
    recommendations: [
      {
        phase: 'explore',
        currentModel: 'claude-sonnet-4-5',
        suggestedModel: 'claude-haiku-4-5',
        estimatedSavingsPct: 25,
        confidence: 0.7,
        dataPoints: 7,
        direction: 'downgrade' as const,
      },
    ],
    analysisRuns: 7,
    insufficientData: false,
    phaseOutputRatios: { explore: 0.08 },
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('MetricsOptions — routingRecommendations field', () => {
  it('accepts routingRecommendations field in MetricsOptions type', () => {
    const opts: MetricsOptions = {
      outputFormat: 'json',
      projectRoot: '/tmp',
      routingRecommendations: true,
    }
    expect(opts.routingRecommendations).toBe(true)
  })
})

describe('runMetricsAction — --routing-recommendations text mode (AC3)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // existsSync defaults to false (no dolt, no routing config file)
  })

  it('always exits with code 0 when insufficientData is true', async () => {
    mockAnalyze.mockReturnValue(makeInsufficientAnalysis())

    const { runMetricsAction } = await import('../metrics.js')
    const exitCode = await runMetricsAction({
      outputFormat: 'human',
      projectRoot: '/tmp/test-project',
      routingRecommendations: true,
    })
    expect(exitCode).toBe(0)
  })

  it('always exits with code 0 when recommendations exist', async () => {
    mockAnalyze.mockReturnValue(makeRecommendationAnalysis())

    const { runMetricsAction } = await import('../metrics.js')
    const exitCode = await runMetricsAction({
      outputFormat: 'human',
      projectRoot: '/tmp/test-project',
      routingRecommendations: true,
    })
    expect(exitCode).toBe(0)
  })

  it('prints "Routing Recommendations:" header in text mode', async () => {
    mockAnalyze.mockReturnValue(makeInsufficientAnalysis())

    const { runMetricsAction } = await import('../metrics.js')
    const cap = captureStdout()
    await runMetricsAction({
      outputFormat: 'human',
      projectRoot: '/tmp/test-project',
      routingRecommendations: true,
    })
    cap.restore()
    expect(cap.output()).toContain('Routing Recommendations:')
  })

  it('prints "No recommendations yet — need at least 3 pipeline runs" when insufficientData', async () => {
    mockAnalyze.mockReturnValue(makeInsufficientAnalysis())

    const { runMetricsAction } = await import('../metrics.js')
    const cap = captureStdout()
    await runMetricsAction({
      outputFormat: 'human',
      projectRoot: '/tmp/test-project',
      routingRecommendations: true,
    })
    cap.restore()
    expect(cap.output()).toContain('No recommendations yet — need at least 3 pipeline runs')
  })

  it('prints one recommendation row per recommendation entry', async () => {
    mockAnalyze.mockReturnValue(makeRecommendationAnalysis())

    const { runMetricsAction } = await import('../metrics.js')
    const cap = captureStdout()
    await runMetricsAction({
      outputFormat: 'human',
      projectRoot: '/tmp/test-project',
      routingRecommendations: true,
    })
    cap.restore()
    const out = cap.output()
    expect(out).toContain('Routing Recommendations:')
    // Recommendation row format: "  <phase> | <currentModel> → <suggestedModel> | est. savings: <N>%"
    expect(out).toContain('explore')
    expect(out).toContain('claude-sonnet-4-5')
    expect(out).toContain('claude-haiku-4-5')
    expect(out).toContain('est. savings: 25%')
  })
})

describe('runMetricsAction — --routing-recommendations JSON mode (AC3)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('emits { recommendations, analysisRuns, insufficientData } as JSON.data when insufficientData', async () => {
    mockAnalyze.mockReturnValue(makeInsufficientAnalysis())

    const { runMetricsAction } = await import('../metrics.js')
    const cap = captureStdout()
    await runMetricsAction({
      outputFormat: 'json',
      projectRoot: '/tmp/test-project',
      routingRecommendations: true,
    })
    cap.restore()
    const parsed = JSON.parse(cap.output().trim()) as { success: boolean; data: Record<string, unknown> }
    expect(parsed.success).toBe(true)
    expect(parsed.data).toHaveProperty('recommendations')
    expect(parsed.data).toHaveProperty('analysisRuns', 0)
    expect(parsed.data).toHaveProperty('insufficientData', true)
    expect(parsed.data.recommendations).toHaveLength(0)
  })

  it('emits recommendations array in JSON output when analysis returns results', async () => {
    mockAnalyze.mockReturnValue(makeRecommendationAnalysis())

    const { runMetricsAction } = await import('../metrics.js')
    const cap = captureStdout()
    await runMetricsAction({
      outputFormat: 'json',
      projectRoot: '/tmp/test-project',
      routingRecommendations: true,
    })
    cap.restore()
    const parsed = JSON.parse(cap.output().trim()) as { success: boolean; data: Record<string, unknown> }
    expect(parsed.success).toBe(true)
    expect(parsed.data).toHaveProperty('insufficientData', false)
    expect(parsed.data).toHaveProperty('analysisRuns', 7)
    expect(Array.isArray(parsed.data.recommendations)).toBe(true)
    expect((parsed.data.recommendations as unknown[]).length).toBe(1)
  })

  it('exits with code 0 in JSON mode regardless of insufficientData', async () => {
    mockAnalyze.mockReturnValue(makeInsufficientAnalysis())

    const { runMetricsAction } = await import('../metrics.js')
    const cap = captureStdout()
    const exitCode = await runMetricsAction({
      outputFormat: 'json',
      projectRoot: '/tmp/test-project',
      routingRecommendations: true,
    })
    cap.restore()
    expect(exitCode).toBe(0)
  })
})

describe('runMetricsAction — --routing-recommendations StateStore lifecycle', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('initializes and closes the StateStore for the routing-recommendations path', async () => {
    mockAnalyze.mockReturnValue(makeInsufficientAnalysis())

    const { createStateStore } = await import('../../../modules/state/index.js')
    const { runMetricsAction } = await import('../metrics.js')
    await runMetricsAction({
      outputFormat: 'human',
      projectRoot: '/tmp/test-project',
      routingRecommendations: true,
    })
    expect(createStateStore).toHaveBeenCalled()
    expect(mockStateStore.initialize).toHaveBeenCalled()
    expect(mockStateStore.close).toHaveBeenCalled()
  })

  it('uses file backend when no dolt state path exists', async () => {
    const { existsSync } = await import('fs')
    vi.mocked(existsSync).mockReturnValue(false) // no dolt

    mockAnalyze.mockReturnValue(makeInsufficientAnalysis())

    const { createStateStore } = await import('../../../modules/state/index.js')
    const { runMetricsAction } = await import('../metrics.js')
    await runMetricsAction({
      outputFormat: 'human',
      projectRoot: '/tmp/test-project',
      routingRecommendations: true,
    })
    expect(createStateStore).toHaveBeenCalledWith(
      expect.objectContaining({ backend: 'file' }),
    )
  })

  it('uses dolt backend when dolt state path exists', async () => {
    const { existsSync } = await import('fs')
    vi.mocked(existsSync).mockImplementation((p: unknown) => {
      const path = String(p)
      return path.includes('.dolt')
    })

    mockAnalyze.mockReturnValue(makeInsufficientAnalysis())

    const { createStateStore } = await import('../../../modules/state/index.js')
    const { runMetricsAction } = await import('../metrics.js')
    await runMetricsAction({
      outputFormat: 'human',
      projectRoot: '/tmp/test-project',
      routingRecommendations: true,
    })
    expect(createStateStore).toHaveBeenCalledWith(
      expect.objectContaining({ backend: 'dolt' }),
    )
  })
})
