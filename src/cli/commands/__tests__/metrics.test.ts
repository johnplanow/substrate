// @vitest-environment node
/**
 * Unit tests for the `substrate metrics` command.
 *
 * Verifies:
 * - MetricsOptions accepts new filter fields (AC3, AC4, AC5)
 * - Dolt path detection logic (AC4)
 * - StateStore is queried when Dolt path exists (AC4)
 * - Existing SQLite-only behavior is unchanged (no regression)
 * - New flags are wired into runMetricsAction (AC3, AC5)
 *
 * Story 26-5, AC7.
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
}

vi.mock('../../../modules/state/index.js', () => ({
  createStateStore: vi.fn().mockReturnValue(mockStateStore),
}))

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('MetricsOptions — new filter fields', () => {
  it('accepts sprint field', () => {
    const opts: MetricsOptions = {
      outputFormat: 'json',
      projectRoot: '/tmp',
      sprint: 'sprint-1',
    }
    expect(opts.sprint).toBe('sprint-1')
  })

  it('accepts story field', () => {
    const opts: MetricsOptions = {
      outputFormat: 'json',
      projectRoot: '/tmp',
      story: '26-1',
    }
    expect(opts.story).toBe('26-1')
  })

  it('accepts taskType field', () => {
    const opts: MetricsOptions = {
      outputFormat: 'json',
      projectRoot: '/tmp',
      taskType: 'dev-story',
    }
    expect(opts.taskType).toBe('dev-story')
  })

  it('accepts since field', () => {
    const opts: MetricsOptions = {
      outputFormat: 'json',
      projectRoot: '/tmp',
      since: '2026-03-01T00:00:00.000Z',
    }
    expect(opts.since).toBe('2026-03-01T00:00:00.000Z')
  })

  it('accepts aggregate field', () => {
    const opts: MetricsOptions = {
      outputFormat: 'json',
      projectRoot: '/tmp',
      aggregate: true,
    }
    expect(opts.aggregate).toBe(true)
  })
})

describe('runMetricsAction — no Dolt path (no-op)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns 0 when no database exists', async () => {
    const { existsSync } = await import('fs')
    vi.mocked(existsSync).mockReturnValue(false)

    const { runMetricsAction } = await import('../metrics.js')
    const exitCode = await runMetricsAction({
      outputFormat: 'json',
      projectRoot: '/tmp/test-project',
    })
    expect(exitCode).toBe(0)
  })

  it('does not call createStateStore when no Dolt path exists', async () => {
    const { existsSync } = await import('fs')
    vi.mocked(existsSync).mockReturnValue(false)

    const { createStateStore } = await import('../../../modules/state/index.js')
    const { runMetricsAction } = await import('../metrics.js')
    await runMetricsAction({
      outputFormat: 'json',
      projectRoot: '/tmp/test-project',
    })
    expect(createStateStore).not.toHaveBeenCalled()
  })
})

describe('runMetricsAction — Dolt path present', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('calls createStateStore and queryMetrics when Dolt path exists and filter flag is provided', async () => {
    const { existsSync } = await import('fs')
    // First call for substrate.db → false (so we hit no-database early return and skip SQLite)
    // We need to make the db exist but the dolt path also exist
    // Return true for both checks (db and dolt)
    vi.mocked(existsSync).mockImplementation((p) => {
      const path = String(p)
      // substrate.db exists (so we proceed to the main query section)
      if (path.includes('substrate.db')) return true
      // Dolt state path exists
      if (path.includes('.dolt')) return true
      return false
    })

    const { createStateStore } = await import('../../../modules/state/index.js')
    const { runMetricsAction } = await import('../metrics.js')
    // A filter flag (sprint) must be provided for Dolt path to be activated (AC5 of Story 26-5 issue 5 fix)
    await runMetricsAction({
      outputFormat: 'json',
      projectRoot: '/tmp/test-project',
      sprint: 'sprint-1',
    })
    expect(createStateStore).toHaveBeenCalledWith(
      expect.objectContaining({ backend: 'dolt' }),
    )
    expect(mockStateStore.initialize).toHaveBeenCalled()
    expect(mockStateStore.queryMetrics).toHaveBeenCalled()
    expect(mockStateStore.close).toHaveBeenCalled()
  })

  it('does not call createStateStore when Dolt path exists but no filter flags provided', async () => {
    const { existsSync } = await import('fs')
    vi.mocked(existsSync).mockImplementation((p) => {
      const path = String(p)
      if (path.includes('substrate.db')) return true
      if (path.includes('.dolt')) return true
      return false
    })

    const { createStateStore } = await import('../../../modules/state/index.js')
    const { runMetricsAction } = await import('../metrics.js')
    // No filter flags — Dolt path must NOT be activated
    await runMetricsAction({
      outputFormat: 'json',
      projectRoot: '/tmp/test-project',
    })
    expect(createStateStore).not.toHaveBeenCalled()
  })

  it('passes sprint filter to StateStore queryMetrics', async () => {
    const { existsSync } = await import('fs')
    vi.mocked(existsSync).mockImplementation((p) => {
      const path = String(p)
      if (path.includes('substrate.db')) return true
      if (path.includes('.dolt')) return true
      return false
    })

    const { runMetricsAction } = await import('../metrics.js')
    await runMetricsAction({
      outputFormat: 'json',
      projectRoot: '/tmp/test-project',
      sprint: 'sprint-2',
    })
    expect(mockStateStore.queryMetrics).toHaveBeenCalledWith(
      expect.objectContaining({ sprint: 'sprint-2' }),
    )
  })

  it('passes story filter to StateStore queryMetrics as storyKey', async () => {
    const { existsSync } = await import('fs')
    vi.mocked(existsSync).mockImplementation((p) => {
      const path = String(p)
      if (path.includes('substrate.db')) return true
      if (path.includes('.dolt')) return true
      return false
    })

    const { runMetricsAction } = await import('../metrics.js')
    await runMetricsAction({
      outputFormat: 'json',
      projectRoot: '/tmp/test-project',
      story: '26-1',
    })
    expect(mockStateStore.queryMetrics).toHaveBeenCalledWith(
      expect.objectContaining({ storyKey: '26-1' }),
    )
  })

  it('passes aggregate flag to StateStore queryMetrics', async () => {
    const { existsSync } = await import('fs')
    vi.mocked(existsSync).mockImplementation((p) => {
      const path = String(p)
      if (path.includes('substrate.db')) return true
      if (path.includes('.dolt')) return true
      return false
    })

    const { runMetricsAction } = await import('../metrics.js')
    await runMetricsAction({
      outputFormat: 'json',
      projectRoot: '/tmp/test-project',
      aggregate: true,
    })
    expect(mockStateStore.queryMetrics).toHaveBeenCalledWith(
      expect.objectContaining({ aggregate: true }),
    )
  })

  it('includes dolt_metrics in JSON output when dolt results available', async () => {
    const { existsSync } = await import('fs')
    vi.mocked(existsSync).mockImplementation((p) => {
      const path = String(p)
      if (path.includes('substrate.db')) return true
      if (path.includes('.dolt')) return true
      return false
    })

    const doltResult = [
      { storyKey: '26-1', taskType: 'dev-story', tokensIn: 1000, tokensOut: 500, result: 'success' },
    ]
    mockStateStore.queryMetrics.mockResolvedValueOnce(doltResult)

    const { runMetricsAction } = await import('../metrics.js')
    const writes: string[] = []
    const originalWrite = process.stdout.write.bind(process.stdout)
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
      writes.push(String(chunk))
      return true
    })

    // Must pass at least one filter flag so hasDoltFilters is true and the
    // Dolt path is activated (bare metrics calls skip Dolt to avoid
    // unnecessary DB connections).
    await runMetricsAction({
      outputFormat: 'json',
      projectRoot: '/tmp/test-project',
      story: '26-1',
    })

    process.stdout.write = originalWrite

    const outputStr = writes.join('')
    const parsed = JSON.parse(outputStr.trim())
    expect(parsed.data).toHaveProperty('dolt_metrics')
    expect(parsed.data.dolt_metrics).toHaveLength(1)
    expect(parsed.data.dolt_metrics[0].storyKey).toBe('26-1')
  })
})
