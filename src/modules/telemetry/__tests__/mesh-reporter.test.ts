/**
 * Unit tests for mesh-reporter — RunReport building, pushing, and outbox.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  buildRunReport,
  pushRunReport,
  enqueueReport,
  drainOutbox,
  reportToMesh,
} from '../mesh-reporter.js'
import type { DatabaseAdapter } from '@substrate-ai/core'
import { mkdtempSync, rmSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('../../../utils/logger.js', () => ({
  createLogger: vi.fn(() => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  })),
}))

vi.mock('../../../persistence/queries/metrics.js', () => ({
  getRunMetrics: vi.fn(),
  getStoryMetricsForRun: vi.fn(),
}))

import { getRunMetrics, getStoryMetricsForRun } from '../../../persistence/queries/metrics.js'
const mockGetRunMetrics = vi.mocked(getRunMetrics)
const mockGetStoryMetrics = vi.mocked(getStoryMetricsForRun)

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const mockAdapter: DatabaseAdapter = {
  query: vi.fn(),
  exec: vi.fn(),
  transaction: vi.fn(),
  close: vi.fn().mockResolvedValue(undefined),
}

const sampleRunMetrics = {
  status: 'completed',
  wall_clock_seconds: 5400,
  total_input_tokens: 100000,
  total_output_tokens: 5000,
  total_cost_usd: 2.5,
  stories_attempted: 7,
  stories_succeeded: 6,
  stories_failed: 1,
  stories_escalated: 0,
  total_review_cycles: 4,
  total_dispatches: 20,
  restarts: 0,
  concurrency_setting: 3,
}

const sampleStoryMetrics = [
  {
    story_key: '5-1',
    result: 'completed',
    wall_clock_seconds: 900,
    input_tokens: 15000,
    output_tokens: 800,
    cost_usd: 0.35,
    review_cycles: 1,
    dispatches: 3,
    phase_durations_json: '{"create-story":60,"dev-story":600,"code-review":240}',
  },
]

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('buildRunReport', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('builds a complete RunReport from DB metrics', async () => {
    mockGetRunMetrics.mockResolvedValue(sampleRunMetrics as never)
    mockGetStoryMetrics.mockResolvedValue(sampleStoryMetrics as never)

    const report = await buildRunReport(mockAdapter, 'run-123', {
      projectId: 'test-project',
      substrateVersion: '0.19.27',
      agentBackend: 'claude-code',
      engineType: 'linear',
      concurrency: 3,
    })

    expect(report).not.toBeNull()
    expect(report!.runId).toBe('run-123')
    expect(report!.projectId).toBe('test-project')
    expect(report!.status).toBe('completed')
    expect(report!.totalCostUsd).toBe(2.5)
    expect(report!.storiesAttempted).toBe(7)
    expect(report!.stories).toHaveLength(1)
    expect(report!.stories[0].storyKey).toBe('5-1')
    expect(report!.stories[0].phaseDurations).toEqual({
      'create-story': 60,
      'dev-story': 600,
      'code-review': 240,
    })
  })

  it('returns null when no run_metrics found', async () => {
    mockGetRunMetrics.mockResolvedValue(null as never)

    const report = await buildRunReport(mockAdapter, 'run-missing', {})
    expect(report).toBeNull()
  })

  it('derives projectId from projectRoot when not provided', async () => {
    mockGetRunMetrics.mockResolvedValue(sampleRunMetrics as never)
    mockGetStoryMetrics.mockResolvedValue([] as never)

    const report = await buildRunReport(mockAdapter, 'run-123', {
      projectRoot: '/home/user/code/my-project',
    })

    expect(report!.projectId).toBe('my-project')
  })

  it('maps failed status correctly', async () => {
    mockGetRunMetrics.mockResolvedValue({ ...sampleRunMetrics, status: 'failed' } as never)
    mockGetStoryMetrics.mockResolvedValue([] as never)

    const report = await buildRunReport(mockAdapter, 'run-123', {})
    expect(report!.status).toBe('failed')
  })

  it('maps unknown status to partial', async () => {
    mockGetRunMetrics.mockResolvedValue({ ...sampleRunMetrics, status: 'running' } as never)
    mockGetStoryMetrics.mockResolvedValue([] as never)

    const report = await buildRunReport(mockAdapter, 'run-123', {})
    expect(report!.status).toBe('partial')
  })

  it('handles malformed phase_durations_json gracefully', async () => {
    mockGetRunMetrics.mockResolvedValue(sampleRunMetrics as never)
    mockGetStoryMetrics.mockResolvedValue([
      { ...sampleStoryMetrics[0], phase_durations_json: 'not-json' },
    ] as never)

    const report = await buildRunReport(mockAdapter, 'run-123', {})
    expect(report!.stories[0].phaseDurations).toBeUndefined()
  })
})

describe('pushRunReport', () => {
  const sampleReport = {
    runId: 'run-123',
    projectId: 'test',
    substrateVersion: '0.19.27',
    timestamp: '2026-04-05T00:00:00Z',
    status: 'completed' as const,
    wallClockSeconds: 5400,
    totalInputTokens: 100000,
    totalOutputTokens: 5000,
    totalCostUsd: 2.5,
    storiesAttempted: 7,
    storiesSucceeded: 6,
    storiesFailed: 1,
    storiesEscalated: 0,
    totalReviewCycles: 4,
    totalDispatches: 20,
    restarts: 0,
    stories: [],
    agentBackend: 'claude-code',
    engineType: 'linear',
    concurrency: 3,
  }

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('returns true on successful push', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ result: { status: { state: 'completed' } } }),
      })
    )

    const ok = await pushRunReport('http://localhost:4100', sampleReport)
    expect(ok).toBe(true)
    expect(fetch).toHaveBeenCalledWith(
      'http://localhost:4100/rpc',
      expect.objectContaining({ method: 'POST' })
    )
  })

  it('returns false on non-OK HTTP response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 503,
      })
    )

    const ok = await pushRunReport('http://localhost:4100', sampleReport)
    expect(ok).toBe(false)
  })

  it('returns false on RPC error response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ error: { code: -32600, message: 'Invalid request' } }),
      })
    )

    const ok = await pushRunReport('http://localhost:4100', sampleReport)
    expect(ok).toBe(false)
  })

  it('returns false on network error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')))

    const ok = await pushRunReport('http://localhost:4100', sampleReport)
    expect(ok).toBe(false)
  })

  it('strips trailing slash from meshUrl', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ result: {} }),
      })
    )

    await pushRunReport('http://localhost:4100/', sampleReport)
    expect(fetch).toHaveBeenCalledWith('http://localhost:4100/rpc', expect.anything())
  })
})

describe('outbox', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'mesh-outbox-'))
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
    vi.restoreAllMocks()
  })

  const sampleReport = {
    runId: 'run-456',
    projectId: 'test',
    substrateVersion: '0.19.27',
    timestamp: '2026-04-05T00:00:00Z',
    status: 'completed' as const,
    wallClockSeconds: 100,
    totalInputTokens: 1000,
    totalOutputTokens: 100,
    totalCostUsd: 0.5,
    storiesAttempted: 1,
    storiesSucceeded: 1,
    storiesFailed: 0,
    storiesEscalated: 0,
    totalReviewCycles: 0,
    totalDispatches: 2,
    restarts: 0,
    stories: [],
    agentBackend: 'claude-code',
    engineType: 'linear',
    concurrency: 1,
  }

  it('enqueues a report to the outbox directory', () => {
    enqueueReport(sampleReport, 'http://localhost:4100', tmpDir)

    const outboxDir = join(tmpDir, '.substrate', 'outbox')
    const files = readdirSync(outboxDir)
    expect(files).toHaveLength(1)
    expect(files[0]).toMatch(/^report-run-456-\d+\.json$/)

    const envelope = JSON.parse(readFileSync(join(outboxDir, files[0]), 'utf-8'))
    expect(envelope.meshUrl).toBe('http://localhost:4100')
    expect(envelope.report.runId).toBe('run-456')
  })

  it('drains outbox successfully when server is available', async () => {
    // Queue two reports
    enqueueReport({ ...sampleReport, runId: 'run-a' }, 'http://localhost:4100', tmpDir)
    enqueueReport({ ...sampleReport, runId: 'run-b' }, 'http://localhost:4100', tmpDir)

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ result: {} }),
      })
    )

    const delivered = await drainOutbox('http://localhost:4100', tmpDir)
    expect(delivered).toBe(2)

    const outboxDir = join(tmpDir, '.substrate', 'outbox')
    const remaining = readdirSync(outboxDir).filter((f) => f.endsWith('.json'))
    expect(remaining).toHaveLength(0)
  })

  it('stops draining on push failure and preserves remaining', async () => {
    enqueueReport({ ...sampleReport, runId: 'run-a' }, 'http://localhost:4100', tmpDir)
    enqueueReport({ ...sampleReport, runId: 'run-b' }, 'http://localhost:4100', tmpDir)

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 503,
      })
    )

    const delivered = await drainOutbox('http://localhost:4100', tmpDir)
    expect(delivered).toBe(0)

    const outboxDir = join(tmpDir, '.substrate', 'outbox')
    const remaining = readdirSync(outboxDir).filter((f) => f.endsWith('.json'))
    expect(remaining).toHaveLength(2)
  })

  it('returns 0 when outbox is empty', async () => {
    const delivered = await drainOutbox('http://localhost:4100', tmpDir)
    expect(delivered).toBe(0)
  })
})

describe('reportToMesh (integration)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('returns false when run metrics are missing', async () => {
    mockGetRunMetrics.mockResolvedValue(null as never)

    const ok = await reportToMesh(mockAdapter, 'run-missing', 'http://localhost:4100', {})
    expect(ok).toBe(false)
  })
})
