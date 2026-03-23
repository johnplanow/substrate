// @vitest-environment node
/**
 * Unit tests for factory metrics display in `substrate metrics` command.
 *
 * Verifies:
 * - JSON output includes factory graph runs with correct fields (AC1, AC2)
 * - --run <id> returns per-iteration array in JSON (AC3)
 * - Human-readable printFactoryRunTable formats score as percentage (AC4, AC5)
 * - Empty factoryRuns = [] produces no factory section and no error (AC6)
 * - --factory flag skips SDLC output (AC7)
 *
 * Story 46-4.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { MetricsOptions } from '../metrics.js'

// ---------------------------------------------------------------------------
// Mocks
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

const mockAdapter = {
  query: vi.fn().mockResolvedValue([]),
  exec: vi.fn().mockResolvedValue(undefined),
  transaction: vi.fn(),
  close: vi.fn().mockResolvedValue(undefined),
}

vi.mock('../../../persistence/adapter.js', () => ({
  createDatabaseAdapter: vi.fn(() => mockAdapter),
}))

vi.mock('../../../persistence/schema.js', () => ({
  initSchema: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('../../../persistence/queries/metrics.js', () => ({
  listRunMetrics: vi.fn().mockResolvedValue([]),
  getRunMetrics: vi.fn().mockResolvedValue(null),
  tagRunAsBaseline: vi.fn(),
  compareRunMetrics: vi.fn().mockResolvedValue(null),
}))

vi.mock('../../../persistence/queries/decisions.js', () => ({
  getDecisionsByCategory: vi.fn().mockResolvedValue([]),
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

const mockStateStore = {
  initialize: vi.fn().mockResolvedValue(undefined),
  close: vi.fn().mockResolvedValue(undefined),
  queryMetrics: vi.fn().mockResolvedValue([]),
  recordMetric: vi.fn().mockResolvedValue(undefined),
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
  getMetric: vi.fn().mockResolvedValue(undefined),
}

vi.mock('../../../modules/state/index.js', () => ({
  createStateStore: vi.fn().mockReturnValue(mockStateStore),
  FileStateStore: vi.fn().mockImplementation(() => mockStateStore),
}))

// ---------------------------------------------------------------------------
// Factory module mocks
// ---------------------------------------------------------------------------

const mockGetFactoryRunSummaries = vi.fn()
const mockGetScenarioResultsForRun = vi.fn()

vi.mock('@substrate-ai/factory', () => ({
  getFactoryRunSummaries: (...args: unknown[]) => mockGetFactoryRunSummaries(...args),
  getScenarioResultsForRun: (...args: unknown[]) => mockGetScenarioResultsForRun(...args),
}))

// ---------------------------------------------------------------------------
// Helper: capture stdout
// ---------------------------------------------------------------------------

function captureStdout(fn: () => Promise<unknown>): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: string[] = []
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
      chunks.push(String(chunk))
      return true
    })
    fn()
      .then(() => {
        spy.mockRestore()
        resolve(chunks.join(''))
      })
      .catch((err) => {
        spy.mockRestore()
        reject(err)
      })
  })
}

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const sampleFactoryRun = {
  run_id: 'abc12345def67890',
  satisfaction_score: 0.75,
  iterations: 3,
  convergence_status: 'completed',
  started_at: '2026-03-23T10:00:00.000Z',
  completed_at: '2026-03-23T10:30:00.000Z',
  total_cost_usd: 0.1234,
  type: 'factory' as const,
  passes: true,
}

const sampleScenarioRows = [
  {
    id: 1,
    run_id: 'abc12345def67890',
    node_id: 'evaluate',
    iteration: 1,
    total_scenarios: 5,
    passed: 3,
    failed: 2,
    satisfaction_score: 0.6,
    threshold: 0.8,
    passes: false,
    details: null,
    executed_at: '2026-03-23T10:05:00.000Z',
  },
  {
    id: 2,
    run_id: 'abc12345def67890',
    node_id: 'evaluate',
    iteration: 2,
    total_scenarios: 5,
    passed: 4,
    failed: 1,
    satisfaction_score: 0.8,
    threshold: 0.8,
    passes: true,
    details: null,
    executed_at: '2026-03-23T10:15:00.000Z',
  },
  {
    id: 3,
    run_id: 'abc12345def67890',
    node_id: 'evaluate',
    iteration: 3,
    total_scenarios: 5,
    passed: 5,
    failed: 0,
    satisfaction_score: 1.0,
    threshold: 0.8,
    passes: true,
    details: null,
    executed_at: '2026-03-23T10:25:00.000Z',
  },
]

// ---------------------------------------------------------------------------
// Tests: AC1 & AC2 — JSON output includes graph_runs with type: 'factory'
// ---------------------------------------------------------------------------

describe('AC1 + AC2: JSON output includes factory graph runs', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGetFactoryRunSummaries.mockResolvedValue([sampleFactoryRun])
    mockGetScenarioResultsForRun.mockResolvedValue([])
  })

  it('includes graph_runs array in JSON output when factory runs exist', async () => {
    const { existsSync } = await import('fs')
    vi.mocked(existsSync).mockImplementation((p) => {
      const path = String(p)
      if (path.includes('.dolt')) return true
      return false
    })

    const { runMetricsAction } = await import('../metrics.js')
    const output = await captureStdout(() =>
      runMetricsAction({ outputFormat: 'json', projectRoot: '/tmp/test-project' }),
    )

    const parsed = JSON.parse(output.trim())
    expect(parsed.data).toHaveProperty('graph_runs')
    expect(Array.isArray(parsed.data.graph_runs)).toBe(true)
    expect(parsed.data.graph_runs).toHaveLength(1)
    expect(parsed.data.graph_runs[0].run_id).toBe('abc12345def67890')
    expect(parsed.data.graph_runs[0].type).toBe('factory')
  })

  it('graph_runs entries have all required fields from AC1', async () => {
    const { existsSync } = await import('fs')
    vi.mocked(existsSync).mockImplementation((p) => String(p).includes('.dolt'))

    const { runMetricsAction } = await import('../metrics.js')
    const output = await captureStdout(() =>
      runMetricsAction({ outputFormat: 'json', projectRoot: '/tmp/test-project' }),
    )

    const parsed = JSON.parse(output.trim())
    const entry = parsed.data.graph_runs[0]
    expect(entry).toHaveProperty('run_id')
    expect(entry).toHaveProperty('satisfaction_score')
    expect(entry).toHaveProperty('iterations')
    expect(entry).toHaveProperty('convergence_status')
    expect(entry).toHaveProperty('started_at')
    expect(entry).toHaveProperty('total_cost_usd')
    expect(entry).toHaveProperty('type', 'factory')
  })

  it('SDLC run entries carry type: sdlc in JSON output (AC2)', async () => {
    const { existsSync } = await import('fs')
    vi.mocked(existsSync).mockImplementation((p) => String(p).includes('.dolt'))

    const { listRunMetrics } = await import('../../../persistence/queries/metrics.js')
    vi.mocked(listRunMetrics).mockResolvedValue([
      {
        run_id: 'sdlc-run-1',
        status: 'completed',
        methodology: 'linear',
        stories_attempted: 1,
        stories_succeeded: 1,
        stories_failed: 0,
        stories_escalated: 0,
        total_review_cycles: 2,
        total_dispatches: 5,
        concurrency_setting: 1,
        started_at: '2026-03-23T09:00:00Z',
        completed_at: '2026-03-23T10:00:00Z',
        wall_clock_seconds: 3600,
        total_input_tokens: 10000,
        total_output_tokens: 5000,
        total_cost_usd: 0.05,
        is_baseline: 0,
      } as unknown as import('../../../persistence/queries/metrics.js').RunMetricsRow,
    ])

    const { runMetricsAction } = await import('../metrics.js')
    const output = await captureStdout(() =>
      runMetricsAction({ outputFormat: 'json', projectRoot: '/tmp/test-project' }),
    )

    const parsed = JSON.parse(output.trim())
    const sdlcRun = parsed.data.runs[0]
    expect(sdlcRun.type).toBe('sdlc')
  })
})

// ---------------------------------------------------------------------------
// Tests: AC3 — --run returns per-iteration data
// ---------------------------------------------------------------------------

describe('AC3: --run per-iteration detail mode', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGetFactoryRunSummaries.mockResolvedValue([])
    mockGetScenarioResultsForRun.mockResolvedValue(sampleScenarioRows)
  })

  it('returns iteration array in JSON when rows exist', async () => {
    const { existsSync } = await import('fs')
    vi.mocked(existsSync).mockImplementation((p) => String(p).includes('.dolt'))

    const { runMetricsAction } = await import('../metrics.js')
    const output = await captureStdout(() =>
      runMetricsAction({
        outputFormat: 'json',
        projectRoot: '/tmp/test-project',
        run: 'abc12345',
      }),
    )

    const parsed = JSON.parse(output.trim())
    expect(parsed.data).toHaveProperty('run_id', 'abc12345')
    expect(parsed.data).toHaveProperty('type', 'factory')
    expect(Array.isArray(parsed.data.iterations)).toBe(true)
    expect(parsed.data.iterations).toHaveLength(3)
    expect(parsed.data.iterations[0].iteration).toBe(1)
    expect(parsed.data.iterations[1].satisfaction_score).toBe(0.8)
  })

  it('returns exit code 1 when no rows found for run id', async () => {
    const { existsSync } = await import('fs')
    vi.mocked(existsSync).mockImplementation((p) => String(p).includes('.dolt'))

    mockGetScenarioResultsForRun.mockResolvedValue([])

    const { runMetricsAction } = await import('../metrics.js')
    const exitCode = await runMetricsAction({
      outputFormat: 'json',
      projectRoot: '/tmp/test-project',
      run: 'nonexistent-id',
    })

    expect(exitCode).toBe(1)
  })

  it('emits message in JSON when run not found', async () => {
    const { existsSync } = await import('fs')
    vi.mocked(existsSync).mockImplementation((p) => String(p).includes('.dolt'))

    mockGetScenarioResultsForRun.mockResolvedValue([])

    const { runMetricsAction } = await import('../metrics.js')
    const output = await captureStdout(() =>
      runMetricsAction({
        outputFormat: 'json',
        projectRoot: '/tmp/test-project',
        run: 'missing',
      }),
    )

    const parsed = JSON.parse(output.trim())
    expect(parsed.data).toHaveProperty('message')
    expect(parsed.data.message).toContain('No factory run found')
    expect(parsed.data.message).toContain('missing')
  })
})

// ---------------------------------------------------------------------------
// Tests: AC4 & AC5 — human-readable table format
// ---------------------------------------------------------------------------

describe('AC4 + AC5: printFactoryRunTable human-readable format', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGetFactoryRunSummaries.mockResolvedValue([sampleFactoryRun])
    mockGetScenarioResultsForRun.mockResolvedValue([])
  })

  it('prints factory runs section in human-readable output', async () => {
    const { existsSync } = await import('fs')
    vi.mocked(existsSync).mockImplementation((p) => String(p).includes('.dolt'))

    const { runMetricsAction } = await import('../metrics.js')
    const output = await captureStdout(() =>
      runMetricsAction({ outputFormat: 'human', projectRoot: '/tmp/test-project' }),
    )

    expect(output).toContain('Factory Runs')
    expect(output).toContain('abc12345')
  })

  it('formats score as percentage (AC5) — 0.75 → 75.0%', async () => {
    const { existsSync } = await import('fs')
    vi.mocked(existsSync).mockImplementation((p) => String(p).includes('.dolt'))

    const { runMetricsAction } = await import('../metrics.js')
    const output = await captureStdout(() =>
      runMetricsAction({ outputFormat: 'human', projectRoot: '/tmp/test-project' }),
    )

    expect(output).toContain('75.0%')
  })

  it('formats passes=true as ✓ in human-readable output', async () => {
    const { existsSync } = await import('fs')
    vi.mocked(existsSync).mockImplementation((p) => String(p).includes('.dolt'))

    const { runMetricsAction } = await import('../metrics.js')
    const output = await captureStdout(() =>
      runMetricsAction({ outputFormat: 'human', projectRoot: '/tmp/test-project' }),
    )

    expect(output).toContain('✓')
  })

  it('formats passes=false as ✗ in human-readable output', async () => {
    const { existsSync } = await import('fs')
    vi.mocked(existsSync).mockImplementation((p) => String(p).includes('.dolt'))

    mockGetFactoryRunSummaries.mockResolvedValue([
      { ...sampleFactoryRun, passes: false, satisfaction_score: 0.5 },
    ])

    const { runMetricsAction } = await import('../metrics.js')
    const output = await captureStdout(() =>
      runMetricsAction({ outputFormat: 'human', projectRoot: '/tmp/test-project' }),
    )

    expect(output).toContain('✗')
  })
})

// ---------------------------------------------------------------------------
// Tests: AC6 — empty state handled gracefully
// ---------------------------------------------------------------------------

describe('AC6: empty factory runs handled gracefully', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGetFactoryRunSummaries.mockResolvedValue([])
    mockGetScenarioResultsForRun.mockResolvedValue([])
  })

  it('does not throw when getFactoryRunSummaries returns empty array', async () => {
    const { existsSync } = await import('fs')
    vi.mocked(existsSync).mockImplementation((p) => String(p).includes('.dolt'))

    const { runMetricsAction } = await import('../metrics.js')
    await expect(
      runMetricsAction({ outputFormat: 'json', projectRoot: '/tmp/test-project' }),
    ).resolves.not.toThrow()
  })

  it('returns exit code 0 when factory runs are empty', async () => {
    const { existsSync } = await import('fs')
    vi.mocked(existsSync).mockImplementation((p) => String(p).includes('.dolt'))

    const { runMetricsAction } = await import('../metrics.js')
    const exitCode = await runMetricsAction({
      outputFormat: 'json',
      projectRoot: '/tmp/test-project',
    })

    expect(exitCode).toBe(0)
  })

  it('does not print Factory Runs section when empty in human-readable output', async () => {
    const { existsSync } = await import('fs')
    vi.mocked(existsSync).mockImplementation((p) => String(p).includes('.dolt'))

    const { runMetricsAction } = await import('../metrics.js')
    const output = await captureStdout(() =>
      runMetricsAction({ outputFormat: 'human', projectRoot: '/tmp/test-project' }),
    )

    expect(output).not.toContain('Factory Runs')
  })

  it('gracefully handles getFactoryRunSummaries throwing an error (table missing)', async () => {
    const { existsSync } = await import('fs')
    vi.mocked(existsSync).mockImplementation((p) => String(p).includes('.dolt'))

    mockGetFactoryRunSummaries.mockRejectedValue(new Error('no such table: graph_runs'))

    const { runMetricsAction } = await import('../metrics.js')
    const exitCode = await runMetricsAction({
      outputFormat: 'json',
      projectRoot: '/tmp/test-project',
    })

    // Should not throw, should return 0 with empty factory section
    expect(exitCode).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// Tests: AC7 — --factory flag filters output to factory runs only
// ---------------------------------------------------------------------------

describe('AC7: --factory flag filters output to factory runs only', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGetFactoryRunSummaries.mockResolvedValue([sampleFactoryRun])
    mockGetScenarioResultsForRun.mockResolvedValue([])
  })

  it('emits only graph_runs key in JSON when --factory is set', async () => {
    const { existsSync } = await import('fs')
    vi.mocked(existsSync).mockImplementation((p) => String(p).includes('.dolt'))

    const { runMetricsAction } = await import('../metrics.js')
    const output = await captureStdout(() =>
      runMetricsAction({
        outputFormat: 'json',
        projectRoot: '/tmp/test-project',
        factory: true,
      }),
    )

    const parsed = JSON.parse(output.trim())
    expect(parsed.data).toHaveProperty('graph_runs')
    expect(parsed.data).not.toHaveProperty('runs')
    expect(parsed.data).not.toHaveProperty('story_metrics')
  })

  it('does not call listRunMetrics when --factory is set', async () => {
    const { existsSync } = await import('fs')
    vi.mocked(existsSync).mockImplementation((p) => String(p).includes('.dolt'))

    const { listRunMetrics } = await import('../../../persistence/queries/metrics.js')
    const { runMetricsAction } = await import('../metrics.js')
    await runMetricsAction({
      outputFormat: 'json',
      projectRoot: '/tmp/test-project',
      factory: true,
    })

    expect(listRunMetrics).not.toHaveBeenCalled()
  })

  it('returns exit code 0 when --factory is set and factory runs exist', async () => {
    const { existsSync } = await import('fs')
    vi.mocked(existsSync).mockImplementation((p) => String(p).includes('.dolt'))

    const { runMetricsAction } = await import('../metrics.js')
    const exitCode = await runMetricsAction({
      outputFormat: 'json',
      projectRoot: '/tmp/test-project',
      factory: true,
    })

    expect(exitCode).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// Tests: MetricsOptions type — run and factory fields accepted
// ---------------------------------------------------------------------------

describe('MetricsOptions — run and factory fields', () => {
  it('accepts run field', () => {
    const opts: MetricsOptions = {
      outputFormat: 'json',
      projectRoot: '/tmp',
      run: 'abc123',
    }
    expect(opts.run).toBe('abc123')
  })

  it('accepts factory field', () => {
    const opts: MetricsOptions = {
      outputFormat: 'json',
      projectRoot: '/tmp',
      factory: true,
    }
    expect(opts.factory).toBe(true)
  })
})
