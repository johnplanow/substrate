/**
 * Unit tests for mesh-reporter — RunReport building, pushing, and outbox.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { buildRunReport, pushRunReport, enqueueReport, drainOutbox, reportToMesh } from '../mesh-reporter.js'
import type { DatabaseAdapter } from '@substrate-ai/core'
import { mkdtempSync, rmSync, readdirSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs'
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
  total_cost_usd: 2.50,
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
    expect(report!.totalCostUsd).toBe(2.50)
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

  // -------------------------------------------------------------------------
  // Story 57-3: verification_ran signal on per-story StoryReport
  //
  // buildRunReport derives verification_ran from loadVerificationResults(),
  // which opens the run manifest JSON and inspects
  // per_story_state[key].verification_result. The signal must be true when
  // the field is populated and false when absent — independent of
  // verification_findings counts, which are zero in both cases.
  // -------------------------------------------------------------------------

  describe('Story 57-3: verification_ran signal', () => {
    let tmpProjectRoot: string
    let runsDir: string
    const runId = 'run-57-3'

    beforeEach(() => {
      tmpProjectRoot = mkdtempSync(join(tmpdir(), 'mesh-verif-ran-'))
      runsDir = join(tmpProjectRoot, '.substrate', 'runs')
      mkdirSync(runsDir, { recursive: true })
    })

    afterEach(() => {
      rmSync(tmpProjectRoot, { recursive: true, force: true })
    })

    function writeManifest(perStoryState: Record<string, unknown>): void {
      const manifestData = {
        run_id: runId,
        cli_flags: {},
        story_scope: [],
        supervisor_pid: null,
        supervisor_session_id: null,
        per_story_state: perStoryState,
        recovery_history: [],
        cost_accumulation: { per_story: {}, run_total: 0 },
        pending_proposals: [],
        created_at: '2026-04-20T00:00:00.000Z',
        generation: 1,
        updated_at: '2026-04-20T00:00:00.000Z',
      }
      writeFileSync(join(runsDir, `${runId}.json`), JSON.stringify(manifestData))
    }

    it('emits verification_ran: true when per_story_state.verification_result is populated', async () => {
      writeManifest({
        '5-1': {
          status: 'complete',
          phase: 'COMPLETE',
          started_at: '2026-04-20T00:00:00.000Z',
          verification_result: {
            storyKey: '5-1',
            status: 'pass',
            duration_ms: 100,
            checks: [
              { checkName: 'phantom-review', status: 'pass', details: 'ok', duration_ms: 10 },
            ],
          },
        },
      })

      mockGetRunMetrics.mockResolvedValue(sampleRunMetrics as never)
      mockGetStoryMetrics.mockResolvedValue(sampleStoryMetrics as never)

      const report = await buildRunReport(mockAdapter, runId, {
        projectRoot: tmpProjectRoot,
      })

      expect(report!.stories).toHaveLength(1)
      expect((report!.stories[0] as { verification_ran?: boolean }).verification_ran).toBe(true)
      expect(report!.stories[0].verificationStatus).toBe('pass')
    })

    it('emits verification_ran: false when per_story_state.verification_result is absent', async () => {
      writeManifest({
        '5-1': {
          status: 'complete',
          phase: 'COMPLETE',
          started_at: '2026-04-20T00:00:00.000Z',
          // verification_result intentionally absent — story reached COMPLETE
          // without the verification phase running (the strata 1-11a case).
        },
      })

      mockGetRunMetrics.mockResolvedValue(sampleRunMetrics as never)
      mockGetStoryMetrics.mockResolvedValue(sampleStoryMetrics as never)

      const report = await buildRunReport(mockAdapter, runId, {
        projectRoot: tmpProjectRoot,
      })

      expect(report!.stories).toHaveLength(1)
      expect((report!.stories[0] as { verification_ran?: boolean }).verification_ran).toBe(false)
      expect(report!.stories[0].verificationStatus).toBeUndefined()
    })

    it('emits verification_ran: false when the run manifest file itself is missing', async () => {
      // Manifest file is never written — loadVerificationResults returns {}
      mockGetRunMetrics.mockResolvedValue(sampleRunMetrics as never)
      mockGetStoryMetrics.mockResolvedValue(sampleStoryMetrics as never)

      const report = await buildRunReport(mockAdapter, runId, {
        projectRoot: tmpProjectRoot,
      })

      expect((report!.stories[0] as { verification_ran?: boolean }).verification_ran).toBe(false)
    })

    it('emits verification_ran per-story — mixed populated/absent across multiple stories', async () => {
      writeManifest({
        '5-1': {
          status: 'complete',
          phase: 'COMPLETE',
          started_at: '2026-04-20T00:00:00.000Z',
          verification_result: { storyKey: '5-1', status: 'pass', duration_ms: 10, checks: [] },
        },
        '5-2': {
          status: 'complete',
          phase: 'COMPLETE',
          started_at: '2026-04-20T00:00:00.000Z',
          // no verification_result
        },
      })

      mockGetRunMetrics.mockResolvedValue(sampleRunMetrics as never)
      mockGetStoryMetrics.mockResolvedValue([
        { ...sampleStoryMetrics[0], story_key: '5-1' },
        { ...sampleStoryMetrics[0], story_key: '5-2' },
      ] as never)

      const report = await buildRunReport(mockAdapter, runId, {
        projectRoot: tmpProjectRoot,
      })

      const byKey = new Map(report!.stories.map((s) => [s.storyKey, s as { verification_ran?: boolean }]))
      expect(byKey.get('5-1')?.verification_ran).toBe(true)
      expect(byKey.get('5-2')?.verification_ran).toBe(false)
    })
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
    totalCostUsd: 2.50,
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
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ result: { status: { state: 'completed' } } }),
    }))

    const ok = await pushRunReport('http://localhost:4100', sampleReport)
    expect(ok).toBe(true)
    expect(fetch).toHaveBeenCalledWith(
      'http://localhost:4100/rpc',
      expect.objectContaining({ method: 'POST' }),
    )
  })

  it('returns false on non-OK HTTP response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 503,
    }))

    const ok = await pushRunReport('http://localhost:4100', sampleReport)
    expect(ok).toBe(false)
  })

  it('returns false on RPC error response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ error: { code: -32600, message: 'Invalid request' } }),
    }))

    const ok = await pushRunReport('http://localhost:4100', sampleReport)
    expect(ok).toBe(false)
  })

  it('returns false on network error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')))

    const ok = await pushRunReport('http://localhost:4100', sampleReport)
    expect(ok).toBe(false)
  })

  it('strips trailing slash from meshUrl', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ result: {} }),
    }))

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
    totalCostUsd: 0.50,
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

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ result: {} }),
    }))

    const delivered = await drainOutbox('http://localhost:4100', tmpDir)
    expect(delivered).toBe(2)

    const outboxDir = join(tmpDir, '.substrate', 'outbox')
    const remaining = readdirSync(outboxDir).filter(f => f.endsWith('.json'))
    expect(remaining).toHaveLength(0)
  })

  it('stops draining on push failure and preserves remaining', async () => {
    enqueueReport({ ...sampleReport, runId: 'run-a' }, 'http://localhost:4100', tmpDir)
    enqueueReport({ ...sampleReport, runId: 'run-b' }, 'http://localhost:4100', tmpDir)

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 503,
    }))

    const delivered = await drainOutbox('http://localhost:4100', tmpDir)
    expect(delivered).toBe(0)

    const outboxDir = join(tmpDir, '.substrate', 'outbox')
    const remaining = readdirSync(outboxDir).filter(f => f.endsWith('.json'))
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
