// @vitest-environment node
/**
 * Unit tests for `substrate metrics` — telemetry modes (Story 27-8).
 *
 * Verifies:
 * - MetricsOptions accepts new telemetry fields
 * - Flag conflict detection rejects incompatible mode combinations
 * - --efficiency mode: queries getEfficiencyScores, renders table or JSON
 * - --recommendations mode: queries getAllRecommendations, renders table or JSON
 * - --turns <storyKey>: queries getTurnAnalysis, renders table; exits 1 when empty
 * - --consumers <storyKey>: queries getConsumerStats, renders table; exits 1 when empty
 * - --categories mode: queries getCategoryStats, renders table or JSON
 * - --compare-stories mode: fetches two scores, renders side-by-side; exits 1 when missing
 */

import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from 'vitest'
import type { MetricsOptions } from '../metrics.js'

// ---------------------------------------------------------------------------
// Create a placeholder database file so that existsSync checks can pass
// when tests enable the telemetry-db code path.
// Note: createDatabaseAdapter is fully mocked below, so the file never needs
// to be a valid SQLite database — we just need it to exist on disk.
// ---------------------------------------------------------------------------
const { setupTelemetryDb, cleanupTelemetryDb } = vi.hoisted(() => {
  const { mkdirSync, writeFileSync, rmSync } = require('node:fs')
  const TELEMETRY_TEST_ROOT = '/tmp/test-project'
  const TELEMETRY_DB_DIR = TELEMETRY_TEST_ROOT + '/.substrate'
  const TELEMETRY_DB_PATH = TELEMETRY_DB_DIR + '/substrate.db'
  return {
    setupTelemetryDb: () => {
      mkdirSync(TELEMETRY_DB_DIR, { recursive: true })
      // Create an empty placeholder file — createDatabaseAdapter is mocked,
      // so the file never needs to contain a valid SQLite database.
      writeFileSync(TELEMETRY_DB_PATH, '')
    },
    cleanupTelemetryDb: () => {
      try { rmSync(TELEMETRY_TEST_ROOT, { recursive: true, force: true }) } catch { /* ignore */ }
    },
  }
})

beforeAll(() => { setupTelemetryDb() })
afterAll(() => { cleanupTelemetryDb() })

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

const mockAdapter = { query: vi.fn().mockResolvedValue([]), exec: vi.fn().mockResolvedValue(undefined), transaction: vi.fn(), close: vi.fn().mockResolvedValue(undefined) }

vi.mock('../../../persistence/adapter.js', () => ({
  createDatabaseAdapter: vi.fn(() => mockAdapter),
}))

vi.mock('../../../persistence/schema.js', () => ({
  initSchema: vi.fn().mockResolvedValue(undefined),
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

vi.mock('../../../modules/state/index.js', () => ({
  createStateStore: vi.fn().mockReturnValue({
    initialize: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    queryMetrics: vi.fn().mockResolvedValue([]),
  }),
}))

// ---------------------------------------------------------------------------
// Mock TelemetryPersistence and better-sqlite3
// ---------------------------------------------------------------------------

const mockTelemetryPersistence = {
  initSchema: vi.fn(),
  getEfficiencyScores: vi.fn().mockResolvedValue([]),
  getAllRecommendations: vi.fn().mockResolvedValue([]),
  getTurnAnalysis: vi.fn().mockResolvedValue([]),
  getConsumerStats: vi.fn().mockResolvedValue([]),
  getCategoryStats: vi.fn().mockResolvedValue([]),
  getEfficiencyScore: vi.fn().mockResolvedValue(null),
  storeTurnAnalysis: vi.fn(),
  storeEfficiencyScore: vi.fn(),
  getRecommendations: vi.fn().mockResolvedValue([]),
  saveRecommendations: vi.fn(),
  storeCategoryStats: vi.fn(),
  storeConsumerStats: vi.fn(),
}

vi.mock('../../../modules/telemetry/index.js', () => ({
  TelemetryPersistence: vi.fn().mockImplementation(() => mockTelemetryPersistence),
  AdapterTelemetryPersistence: vi.fn().mockImplementation(() => mockTelemetryPersistence),
}))

// Mock better-sqlite3 so the `require('better-sqlite3')` call in openTelemetryDb
// returns a usable constructor. The global alias points to an ESM WASM mock that
// cannot be required, so we provide a simple mock here.
const mockSqliteDb = { close: vi.fn() }
vi.mock('better-sqlite3', () => {
  const Database = vi.fn().mockImplementation(() => mockSqliteDb)
  Database.prototype = {}
  return { default: Database, Database }
})



// ---------------------------------------------------------------------------
// Fixture factories
// ---------------------------------------------------------------------------

function makeEfficiencyScore(storyKey = '27-6', compositeScore = 75) {
  return {
    storyKey,
    timestamp: 1_700_000_000_000,
    compositeScore,
    cacheHitSubScore: 80,
    ioRatioSubScore: 70,
    contextManagementSubScore: 75,
    avgCacheHitRate: 0.8,
    avgIoRatio: 2.0,
    contextSpikeCount: 1,
    totalTurns: 13,
    perModelBreakdown: [{ model: 'claude-sonnet', cacheHitRate: 0.75, avgIoRatio: 2.0, costPer1KOutputTokens: 0.003 }],
    perSourceBreakdown: [{ source: 'claude-code', compositeScore: 88, turnCount: 10 }],
  }
}

function makeRecommendation(overrides: Record<string, unknown> = {}) {
  return {
    id: 'abcd1234abcd1234',
    storyKey: '27-7',
    ruleId: 'biggest_consumers',
    severity: 'warning',
    title: 'High token consumer',
    description: 'A consumer used many tokens.',
    generatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  }
}

function makeTurnAnalysis(turnNumber = 1) {
  return {
    spanId: `span-${turnNumber}`,
    turnNumber,
    name: 'claude-api',
    timestamp: 1_700_000_000_000 + turnNumber * 1000,
    source: 'claude-code',
    model: 'claude-sonnet',
    inputTokens: 10000,
    outputTokens: 500,
    cacheReadTokens: 8000,
    freshTokens: 2000,
    cacheHitRate: 0.8,
    costUsd: 0.01,
    durationMs: 3000,
    contextSize: 10000,
    contextDelta: turnNumber === 1 ? 10000 : 100,
    isContextSpike: false,
    childSpans: [],
  }
}

function makeConsumerStats(key = 'read_file|') {
  return {
    consumerKey: key,
    category: 'file_reads',
    totalTokens: 5000,
    percentage: 25.0,
    eventCount: 10,
    topInvocations: [],
  }
}

function makeCategoryStats(category = 'tool_outputs') {
  return {
    category,
    totalTokens: 8000,
    percentage: 40.0,
    eventCount: 20,
    avgTokensPerEvent: 400,
    trend: 'stable',
  }
}

// ---------------------------------------------------------------------------
// Helpers to mock fs.existsSync for telemetry-enabled scenario
// ---------------------------------------------------------------------------

async function setupExistsSyncForTelemetry() {
  const { existsSync } = await import('fs')
  vi.mocked(existsSync).mockImplementation((p: unknown) => {
    const path = String(p)
    return path.includes('substrate.db') || path.includes('.dolt')
  })
}

async function setupExistsSyncNoDb() {
  const { existsSync } = await import('fs')
  vi.mocked(existsSync).mockReturnValue(false)
}

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
    restore: () => { process.stdout.write = orig },
  }
}

function captureStderr(): { output: () => string; restore: () => void } {
  const writes: string[] = []
  const orig = process.stderr.write.bind(process.stderr)
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
    writes.push(String(chunk))
    return true
  })
  return {
    output: () => writes.join(''),
    restore: () => { process.stderr.write = orig },
  }
}

// ---------------------------------------------------------------------------
// Tests: MetricsOptions type acceptance
// ---------------------------------------------------------------------------

describe('MetricsOptions — telemetry fields', () => {
  it('accepts efficiency field', () => {
    const opts: MetricsOptions = {
      outputFormat: 'json',
      projectRoot: '/tmp',
      efficiency: true,
    }
    expect(opts.efficiency).toBe(true)
  })

  it('accepts recommendations field', () => {
    const opts: MetricsOptions = {
      outputFormat: 'json',
      projectRoot: '/tmp',
      recommendations: true,
    }
    expect(opts.recommendations).toBe(true)
  })

  it('accepts turns field', () => {
    const opts: MetricsOptions = {
      outputFormat: 'json',
      projectRoot: '/tmp',
      turns: '27-4',
    }
    expect(opts.turns).toBe('27-4')
  })

  it('accepts consumers field', () => {
    const opts: MetricsOptions = {
      outputFormat: 'json',
      projectRoot: '/tmp',
      consumers: '27-5',
    }
    expect(opts.consumers).toBe('27-5')
  })

  it('accepts categories field', () => {
    const opts: MetricsOptions = {
      outputFormat: 'json',
      projectRoot: '/tmp',
      categories: true,
    }
    expect(opts.categories).toBe(true)
  })

  it('accepts compareStories field as [string, string] tuple', () => {
    const opts: MetricsOptions = {
      outputFormat: 'json',
      projectRoot: '/tmp',
      compareStories: ['27-6', '27-7'],
    }
    expect(opts.compareStories).toEqual(['27-6', '27-7'])
  })
})

// ---------------------------------------------------------------------------
// Tests: Flag conflict detection
// ---------------------------------------------------------------------------

describe('metrics command — flag conflict detection', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns 1 when two telemetry modes are combined (efficiency + recommendations)', async () => {
    const { runMetricsAction } = await import('../metrics.js')
    const stderr = captureStderr()
    const result = await runMetricsAction({
      outputFormat: 'human',
      projectRoot: '/tmp/test-project',
      efficiency: true,
      recommendations: true,
    })
    stderr.restore()
    expect(result).toBe(1)
    expect(stderr.output()).toContain('mutually exclusive')
  })

  it('returns 1 when two telemetry modes are combined (turns + consumers)', async () => {
    const { runMetricsAction } = await import('../metrics.js')
    const stderr = captureStderr()
    const result = await runMetricsAction({
      outputFormat: 'human',
      projectRoot: '/tmp/test-project',
      turns: '27-4',
      consumers: '27-5',
    })
    stderr.restore()
    expect(result).toBe(1)
  })

  it('returns 1 when telemetry mode is combined with --compare', async () => {
    const { runMetricsAction } = await import('../metrics.js')
    const stderr = captureStderr()
    const result = await runMetricsAction({
      outputFormat: 'human',
      projectRoot: '/tmp/test-project',
      efficiency: true,
      compare: ['run-a', 'run-b'],
    })
    stderr.restore()
    expect(result).toBe(1)
    expect(stderr.output()).toContain('cannot be combined')
  })

  it('returns 1 when telemetry mode is combined with --analysis', async () => {
    const { runMetricsAction } = await import('../metrics.js')
    const stderr = captureStderr()
    const result = await runMetricsAction({
      outputFormat: 'human',
      projectRoot: '/tmp/test-project',
      recommendations: true,
      analysis: 'some-run-id',
    })
    stderr.restore()
    expect(result).toBe(1)
  })

  it('returns 1 when telemetry mode is combined with --tag-baseline', async () => {
    const { runMetricsAction } = await import('../metrics.js')
    const stderr = captureStderr()
    const result = await runMetricsAction({
      outputFormat: 'human',
      projectRoot: '/tmp/test-project',
      categories: true,
      tagBaseline: 'some-run-id',
    })
    stderr.restore()
    expect(result).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// Tests: No-database scenario
// ---------------------------------------------------------------------------

describe('metrics command — no database', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('--efficiency: returns 0 with friendly message when no db', async () => {
    await setupExistsSyncNoDb()

    const { runMetricsAction } = await import('../metrics.js')
    const stdout = captureStdout()
    const result = await runMetricsAction({
      outputFormat: 'human',
      projectRoot: '/tmp/test-project',
      efficiency: true,
    })
    stdout.restore()
    expect(result).toBe(0)
    expect(stdout.output()).toContain('No telemetry data yet')
  })

  it('--recommendations: returns 0 with friendly message when no db', async () => {
    await setupExistsSyncNoDb()

    const { runMetricsAction } = await import('../metrics.js')
    const stdout = captureStdout()
    const result = await runMetricsAction({
      outputFormat: 'human',
      projectRoot: '/tmp/test-project',
      recommendations: true,
    })
    stdout.restore()
    expect(result).toBe(0)
    expect(stdout.output()).toContain('No telemetry data yet')
  })

  it('--turns <storyKey>: returns 1 when no db', async () => {
    await setupExistsSyncNoDb()

    const { runMetricsAction } = await import('../metrics.js')
    const stderr = captureStderr()
    const result = await runMetricsAction({
      outputFormat: 'human',
      projectRoot: '/tmp/test-project',
      turns: '27-4',
    })
    stderr.restore()
    expect(result).toBe(1)
  })

  it('--consumers <storyKey>: returns 1 when no db', async () => {
    await setupExistsSyncNoDb()

    const { runMetricsAction } = await import('../metrics.js')
    const stderr = captureStderr()
    const result = await runMetricsAction({
      outputFormat: 'human',
      projectRoot: '/tmp/test-project',
      consumers: '27-5',
    })
    stderr.restore()
    expect(result).toBe(1)
  })

  it('--categories: returns 0 with friendly message when no db', async () => {
    await setupExistsSyncNoDb()

    const { runMetricsAction } = await import('../metrics.js')
    const stdout = captureStdout()
    const result = await runMetricsAction({
      outputFormat: 'human',
      projectRoot: '/tmp/test-project',
      categories: true,
    })
    stdout.restore()
    expect(result).toBe(0)
    expect(stdout.output()).toContain('No telemetry data yet')
  })
})

// ---------------------------------------------------------------------------
// Tests: Telemetry modes with DB present
// ---------------------------------------------------------------------------

describe('metrics command — telemetry modes', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockTelemetryPersistence.getEfficiencyScores.mockResolvedValue([])
    mockTelemetryPersistence.getAllRecommendations.mockResolvedValue([])
    mockTelemetryPersistence.getTurnAnalysis.mockResolvedValue([])
    mockTelemetryPersistence.getConsumerStats.mockResolvedValue([])
    mockTelemetryPersistence.getCategoryStats.mockResolvedValue([])
    mockTelemetryPersistence.getEfficiencyScore.mockResolvedValue(null)
  })

  // -------------------------------------------------------------------------
  // --efficiency mode
  // -------------------------------------------------------------------------

  describe('--efficiency', () => {
    it('should call getEfficiencyScores and return 0', async () => {
      await setupExistsSyncForTelemetry()

      const scores = [makeEfficiencyScore('27-6', 75), makeEfficiencyScore('27-5', 80)]
      mockTelemetryPersistence.getEfficiencyScores.mockResolvedValue(scores)

      const { runMetricsAction } = await import('../metrics.js')
      const stdout = captureStdout()
      const result = await runMetricsAction({
        outputFormat: 'human',
        projectRoot: '/tmp/test-project',
        efficiency: true,
      })
      stdout.restore()

      expect(result).toBe(0)
      expect(mockTelemetryPersistence.getEfficiencyScores).toHaveBeenCalledWith(20)
      expect(stdout.output()).toContain('Efficiency Scores')
      expect(stdout.output()).toContain('27-6')
    })

    it('should return JSON output with efficiency array when --output-format json', async () => {
      await setupExistsSyncForTelemetry()

      const scores = [makeEfficiencyScore('27-6', 75)]
      mockTelemetryPersistence.getEfficiencyScores.mockResolvedValue(scores)

      const { runMetricsAction } = await import('../metrics.js')
      const stdout = captureStdout()
      const result = await runMetricsAction({
        outputFormat: 'json',
        projectRoot: '/tmp/test-project',
        efficiency: true,
      })
      stdout.restore()

      expect(result).toBe(0)
      const parsed = JSON.parse(stdout.output().trim())
      expect(parsed.success).toBe(true)
      expect(parsed.data).toHaveProperty('efficiency')
      expect(parsed.data.efficiency).toHaveLength(1)
      expect(parsed.data.efficiency[0].storyKey).toBe('27-6')
    })

    it('should render empty table without error when no scores', async () => {
      await setupExistsSyncForTelemetry()

      mockTelemetryPersistence.getEfficiencyScores.mockResolvedValue([])

      const { runMetricsAction } = await import('../metrics.js')
      const stdout = captureStdout()
      const result = await runMetricsAction({
        outputFormat: 'human',
        projectRoot: '/tmp/test-project',
        efficiency: true,
      })
      stdout.restore()
      expect(result).toBe(0)
      expect(stdout.output()).toContain('0 records')
    })
  })

  // -------------------------------------------------------------------------
  // --recommendations mode
  // -------------------------------------------------------------------------

  describe('--recommendations', () => {
    it('should call getAllRecommendations with limit 50 and return 0', async () => {
      await setupExistsSyncForTelemetry()

      const recs = [makeRecommendation({ severity: 'critical' }), makeRecommendation({ id: 'bbbb1234bbbb1234', severity: 'warning' })]
      mockTelemetryPersistence.getAllRecommendations.mockResolvedValue(recs)

      const { runMetricsAction } = await import('../metrics.js')
      const stdout = captureStdout()
      const result = await runMetricsAction({
        outputFormat: 'human',
        projectRoot: '/tmp/test-project',
        recommendations: true,
      })
      stdout.restore()

      expect(result).toBe(0)
      expect(mockTelemetryPersistence.getAllRecommendations).toHaveBeenCalledWith(50)
      expect(stdout.output()).toContain('Recommendations')
    })

    it('should call getRecommendations with storyKey when --story filter is provided', async () => {
      await setupExistsSyncForTelemetry()

      const recs = [makeRecommendation({ storyKey: '27-4', severity: 'critical' })]
      mockTelemetryPersistence.getRecommendations.mockResolvedValue(recs)

      const { runMetricsAction } = await import('../metrics.js')
      const stdout = captureStdout()
      const result = await runMetricsAction({
        outputFormat: 'human',
        projectRoot: '/tmp/test-project',
        recommendations: true,
        story: '27-4',
      })
      stdout.restore()

      expect(result).toBe(0)
      expect(mockTelemetryPersistence.getRecommendations).toHaveBeenCalledWith('27-4')
      expect(mockTelemetryPersistence.getAllRecommendations).not.toHaveBeenCalled()
      expect(stdout.output()).toContain('Recommendations')
    })

    it('should return JSON output with recommendations array', async () => {
      await setupExistsSyncForTelemetry()

      const recs = [makeRecommendation()]
      mockTelemetryPersistence.getAllRecommendations.mockResolvedValue(recs)

      const { runMetricsAction } = await import('../metrics.js')
      const stdout = captureStdout()
      const result = await runMetricsAction({
        outputFormat: 'json',
        projectRoot: '/tmp/test-project',
        recommendations: true,
      })
      stdout.restore()

      expect(result).toBe(0)
      const parsed = JSON.parse(stdout.output().trim())
      expect(parsed.success).toBe(true)
      expect(parsed.data).toHaveProperty('recommendations')
      expect(parsed.data.recommendations).toHaveLength(1)
    })

    it('should return JSON output scoped to story when --story is provided', async () => {
      await setupExistsSyncForTelemetry()

      const recs = [makeRecommendation({ storyKey: '27-4' })]
      mockTelemetryPersistence.getRecommendations.mockResolvedValue(recs)

      const { runMetricsAction } = await import('../metrics.js')
      const stdout = captureStdout()
      const result = await runMetricsAction({
        outputFormat: 'json',
        projectRoot: '/tmp/test-project',
        recommendations: true,
        story: '27-4',
      })
      stdout.restore()

      expect(result).toBe(0)
      const parsed = JSON.parse(stdout.output().trim())
      expect(parsed.success).toBe(true)
      expect(parsed.data).toHaveProperty('recommendations')
      expect(parsed.data).toHaveProperty('storyKey', '27-4')
    })

    it('should print friendly message when no recommendations found (no story filter)', async () => {
      await setupExistsSyncForTelemetry()

      mockTelemetryPersistence.getAllRecommendations.mockResolvedValue([])

      const { runMetricsAction } = await import('../metrics.js')
      const stdout = captureStdout()
      const result = await runMetricsAction({
        outputFormat: 'human',
        projectRoot: '/tmp/test-project',
        recommendations: true,
      })
      stdout.restore()

      expect(result).toBe(0)
      expect(stdout.output()).toContain('No recommendations yet')
    })
  })

  // -------------------------------------------------------------------------
  // --turns <storyKey>
  // -------------------------------------------------------------------------

  describe('--turns', () => {
    it('should call getTurnAnalysis and render table when data present', async () => {
      await setupExistsSyncForTelemetry()

      const turns = [makeTurnAnalysis(1), makeTurnAnalysis(2)]
      mockTelemetryPersistence.getTurnAnalysis.mockResolvedValue(turns)

      const { runMetricsAction } = await import('../metrics.js')
      const stdout = captureStdout()
      const result = await runMetricsAction({
        outputFormat: 'human',
        projectRoot: '/tmp/test-project',
        turns: '27-4',
      })
      stdout.restore()

      expect(result).toBe(0)
      expect(mockTelemetryPersistence.getTurnAnalysis).toHaveBeenCalledWith('27-4')
      expect(stdout.output()).toContain('Turn Analysis')
      expect(stdout.output()).toContain('27-4')
    })

    it('should return 1 when no turns found for storyKey', async () => {
      await setupExistsSyncForTelemetry()

      mockTelemetryPersistence.getTurnAnalysis.mockResolvedValue([])

      const { runMetricsAction } = await import('../metrics.js')
      const stderr = captureStderr()
      const result = await runMetricsAction({
        outputFormat: 'human',
        projectRoot: '/tmp/test-project',
        turns: 'no-such-story',
      })
      stderr.restore()

      expect(result).toBe(1)
      expect(stderr.output()).toContain('no-such-story')
    })

    it('should return JSON output with turns array', async () => {
      await setupExistsSyncForTelemetry()

      const turns = [makeTurnAnalysis(1)]
      mockTelemetryPersistence.getTurnAnalysis.mockResolvedValue(turns)

      const { runMetricsAction } = await import('../metrics.js')
      const stdout = captureStdout()
      const result = await runMetricsAction({
        outputFormat: 'json',
        projectRoot: '/tmp/test-project',
        turns: '27-4',
      })
      stdout.restore()

      expect(result).toBe(0)
      const parsed = JSON.parse(stdout.output().trim())
      expect(parsed.success).toBe(true)
      expect(parsed.data).toHaveProperty('turns')
      expect(parsed.data.turns).toHaveLength(1)
    })

    it('should indicate spike turns with ⚠ symbol', async () => {
      await setupExistsSyncForTelemetry()

      const spikedTurn = { ...makeTurnAnalysis(1), isContextSpike: true }
      mockTelemetryPersistence.getTurnAnalysis.mockResolvedValue([spikedTurn])

      const { runMetricsAction } = await import('../metrics.js')
      const stdout = captureStdout()
      await runMetricsAction({
        outputFormat: 'human',
        projectRoot: '/tmp/test-project',
        turns: '27-4',
      })
      stdout.restore()

      expect(stdout.output()).toContain('⚠')
    })
  })

  // -------------------------------------------------------------------------
  // --consumers <storyKey>
  // -------------------------------------------------------------------------

  describe('--consumers', () => {
    it('should call getConsumerStats and render table', async () => {
      await setupExistsSyncForTelemetry()

      const consumers = [makeConsumerStats('read_file|'), makeConsumerStats('bash|')]
      mockTelemetryPersistence.getConsumerStats.mockResolvedValue(consumers)

      const { runMetricsAction } = await import('../metrics.js')
      const stdout = captureStdout()
      const result = await runMetricsAction({
        outputFormat: 'human',
        projectRoot: '/tmp/test-project',
        consumers: '27-5',
      })
      stdout.restore()

      expect(result).toBe(0)
      expect(mockTelemetryPersistence.getConsumerStats).toHaveBeenCalledWith('27-5')
      expect(stdout.output()).toContain('Consumer Stats')
      expect(stdout.output()).toContain('27-5')
    })

    it('should return 1 when no consumers found for storyKey', async () => {
      await setupExistsSyncForTelemetry()

      mockTelemetryPersistence.getConsumerStats.mockResolvedValue([])

      const { runMetricsAction } = await import('../metrics.js')
      const stderr = captureStderr()
      const result = await runMetricsAction({
        outputFormat: 'human',
        projectRoot: '/tmp/test-project',
        consumers: 'missing-story',
      })
      stderr.restore()

      expect(result).toBe(1)
      expect(stderr.output()).toContain('missing-story')
    })

    it('should return JSON output with consumers array', async () => {
      await setupExistsSyncForTelemetry()

      const consumers = [makeConsumerStats()]
      mockTelemetryPersistence.getConsumerStats.mockResolvedValue(consumers)

      const { runMetricsAction } = await import('../metrics.js')
      const stdout = captureStdout()
      const result = await runMetricsAction({
        outputFormat: 'json',
        projectRoot: '/tmp/test-project',
        consumers: '27-5',
      })
      stdout.restore()

      expect(result).toBe(0)
      const parsed = JSON.parse(stdout.output().trim())
      expect(parsed.success).toBe(true)
      expect(parsed.data).toHaveProperty('consumers')
    })
  })

  // -------------------------------------------------------------------------
  // --categories mode
  // -------------------------------------------------------------------------

  describe('--categories', () => {
    it('should call getCategoryStats with empty string when no --story specified', async () => {
      await setupExistsSyncForTelemetry()

      const stats = [makeCategoryStats('tool_outputs'), makeCategoryStats('file_reads')]
      mockTelemetryPersistence.getCategoryStats.mockResolvedValue(stats)

      const { runMetricsAction } = await import('../metrics.js')
      const stdout = captureStdout()
      const result = await runMetricsAction({
        outputFormat: 'human',
        projectRoot: '/tmp/test-project',
        categories: true,
      })
      stdout.restore()

      expect(result).toBe(0)
      expect(mockTelemetryPersistence.getCategoryStats).toHaveBeenCalledWith('')
      expect(stdout.output()).toContain('Category Stats')
    })

    it('should scope getCategoryStats to story when --story is provided', async () => {
      await setupExistsSyncForTelemetry()

      mockTelemetryPersistence.getCategoryStats.mockResolvedValue([makeCategoryStats()])

      const { runMetricsAction } = await import('../metrics.js')
      const stdout = captureStdout()
      const result = await runMetricsAction({
        outputFormat: 'human',
        projectRoot: '/tmp/test-project',
        categories: true,
        story: '27-5',
      })
      stdout.restore()

      expect(result).toBe(0)
      expect(mockTelemetryPersistence.getCategoryStats).toHaveBeenCalledWith('27-5')
    })

    it('should return JSON output with categories array', async () => {
      await setupExistsSyncForTelemetry()

      const stats = [makeCategoryStats()]
      mockTelemetryPersistence.getCategoryStats.mockResolvedValue(stats)

      const { runMetricsAction } = await import('../metrics.js')
      const stdout = captureStdout()
      const result = await runMetricsAction({
        outputFormat: 'json',
        projectRoot: '/tmp/test-project',
        categories: true,
      })
      stdout.restore()

      expect(result).toBe(0)
      const parsed = JSON.parse(stdout.output().trim())
      expect(parsed.success).toBe(true)
      expect(parsed.data).toHaveProperty('categories')
    })
  })

  // -------------------------------------------------------------------------
  // --compare-stories
  // -------------------------------------------------------------------------

  describe('--compare-stories', () => {
    it('should render side-by-side comparison when both scores exist', async () => {
      await setupExistsSyncForTelemetry()

      const scoreA = makeEfficiencyScore('27-6', 75)
      const scoreB = makeEfficiencyScore('27-7', 80)
      mockTelemetryPersistence.getEfficiencyScore
        .mockResolvedValueOnce(scoreA)
        .mockResolvedValueOnce(scoreB)

      const { runMetricsAction } = await import('../metrics.js')
      const stdout = captureStdout()
      const result = await runMetricsAction({
        outputFormat: 'human',
        projectRoot: '/tmp/test-project',
        compareStories: ['27-6', '27-7'],
      })
      stdout.restore()

      expect(result).toBe(0)
      expect(stdout.output()).toContain('Efficiency Comparison')
      expect(stdout.output()).toContain('27-6')
      expect(stdout.output()).toContain('27-7')
    })

    it('should return 1 when score for storyA is missing', async () => {
      await setupExistsSyncForTelemetry()

      mockTelemetryPersistence.getEfficiencyScore
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(makeEfficiencyScore('27-7', 80))

      const { runMetricsAction } = await import('../metrics.js')
      const stderr = captureStderr()
      const result = await runMetricsAction({
        outputFormat: 'human',
        projectRoot: '/tmp/test-project',
        compareStories: ['27-6', '27-7'],
      })
      stderr.restore()

      expect(result).toBe(1)
    })

    it('should return 1 when score for storyB is missing', async () => {
      await setupExistsSyncForTelemetry()

      mockTelemetryPersistence.getEfficiencyScore
        .mockResolvedValueOnce(makeEfficiencyScore('27-6', 75))
        .mockResolvedValueOnce(null)

      const { runMetricsAction } = await import('../metrics.js')
      const stderr = captureStderr()
      const result = await runMetricsAction({
        outputFormat: 'human',
        projectRoot: '/tmp/test-project',
        compareStories: ['27-6', '27-7'],
      })
      stderr.restore()

      expect(result).toBe(1)
    })

    it('should return JSON output with storyA, storyB, and delta', async () => {
      await setupExistsSyncForTelemetry()

      const scoreA = makeEfficiencyScore('27-6', 75)
      const scoreB = makeEfficiencyScore('27-7', 80)
      mockTelemetryPersistence.getEfficiencyScore
        .mockResolvedValueOnce(scoreA)
        .mockResolvedValueOnce(scoreB)

      const { runMetricsAction } = await import('../metrics.js')
      const stdout = captureStdout()
      const result = await runMetricsAction({
        outputFormat: 'json',
        projectRoot: '/tmp/test-project',
        compareStories: ['27-6', '27-7'],
      })
      stdout.restore()

      expect(result).toBe(0)
      const parsed = JSON.parse(stdout.output().trim())
      expect(parsed.success).toBe(true)
      expect(parsed.data).toHaveProperty('storyA')
      expect(parsed.data).toHaveProperty('storyB')
      expect(parsed.data).toHaveProperty('delta')
      expect(parsed.data.delta.compositeScore).toBe(5)
    })

    it('should show delta of all zeros when same story key is compared to itself', async () => {
      await setupExistsSyncForTelemetry()

      const score = makeEfficiencyScore('27-6', 75)
      mockTelemetryPersistence.getEfficiencyScore
        .mockResolvedValueOnce(score)
        .mockResolvedValueOnce(score)

      const { runMetricsAction } = await import('../metrics.js')
      const stdout = captureStdout()
      const result = await runMetricsAction({
        outputFormat: 'json',
        projectRoot: '/tmp/test-project',
        compareStories: ['27-6', '27-6'],
      })
      stdout.restore()

      expect(result).toBe(0)
      const parsed = JSON.parse(stdout.output().trim())
      expect(parsed.data.delta.compositeScore).toBe(0)
    })
  })
})
