// @vitest-environment node
/**
 * Unit tests for `substrate report` command — Story 71-1.
 *
 * Design note: tests use the `_dbRoot` internal option to bypass
 * resolveMainRepoRoot (same pattern as reconcile-from-disk tests).
 *
 * Test cases:
 *   (a) classifyStoryOutcome: verified/recovered/escalated/failed edge cases
 *   (b) --run latest resolves correctly (same as omitting --run)
 *   (c) human output stable for golden-master fixture
 *   (d) JSON output well-formed for golden-master fixture
 *   (e) escalation diagnostic enrichment for checkpoint-retry-timeout
 *   (f) escalation diagnostic for unknown reason (graceful fallback)
 *   (g) no-runs-exist friendly error (no manifest.json pointer)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// ---------------------------------------------------------------------------
// Hoisted mocks — must be declared before any imports
// ---------------------------------------------------------------------------

const { mockReadFile, mockReaddir, mockGetLatestRun, mockAdapterClose, mockAdapterQuery, mockInitSchema } = vi.hoisted(() => {
  const mockReadFile = vi.fn()
  const mockReaddir = vi.fn()
  const mockGetLatestRun = vi.fn().mockResolvedValue(undefined)
  const mockAdapterClose = vi.fn().mockResolvedValue(undefined)
  const mockAdapterQuery = vi.fn().mockResolvedValue([])
  const mockInitSchema = vi.fn().mockResolvedValue(undefined)
  return { mockReadFile, mockReaddir, mockGetLatestRun, mockAdapterClose, mockAdapterQuery, mockInitSchema }
})

vi.mock('fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs/promises')>()
  return {
    ...actual,
    readFile: mockReadFile,
    readdir: mockReaddir,
  }
})

vi.mock('../../persistence/adapter.js', () => ({
  createDatabaseAdapter: vi.fn(() => ({
    query: mockAdapterQuery,
    exec: vi.fn().mockResolvedValue(undefined),
    transaction: vi.fn(),
    close: mockAdapterClose,
    backendType: 'sqlite' as const,
  })),
}))

vi.mock('../../persistence/schema.js', () => ({
  initSchema: mockInitSchema,
}))

vi.mock('../../persistence/queries/decisions.js', () => ({
  getLatestRun: mockGetLatestRun,
}))

vi.mock('../../utils/logger.js', () => ({
  createLogger: vi.fn().mockReturnValue({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}))

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import { classifyStoryOutcome, enrichEscalation, runReportAction } from '../../cli/commands/report.js'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const FAKE_DB_ROOT = '/fake/db-root'

// ---------------------------------------------------------------------------
// Fixture builders (mirrors the internal RawStoryState / RawManifest shapes)
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyStory = any
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyManifest = any

function makeVerifiedStory(): AnyStory {
  return {
    status: 'complete',
    phase: 'COMPLETE',
    started_at: '2026-05-05T10:00:00.000Z',
    completed_at: '2026-05-05T10:10:00.000Z',
    review_cycles: 0,
    cost_usd: 0.05,
    dispatches: 1,
    verification_result: {
      status: 'pass',
      verification_ran: true,
      error_count: 0,
      warn_count: 0,
      info_count: 0,
      findings: [],
    },
  }
}

function makeRecoveredStory(): AnyStory {
  return {
    status: 'complete',
    phase: 'COMPLETE',
    started_at: '2026-05-05T10:10:00.000Z',
    completed_at: '2026-05-05T10:20:00.000Z',
    review_cycles: 1,
    cost_usd: 0.03,
    dispatches: 2,
    verification_result: {
      status: 'pass',
      verification_ran: true,
      error_count: 0,
      warn_count: 1,
      info_count: 0,
      findings: [],
    },
  }
}

function makeEscalatedStory(): AnyStory {
  return {
    status: 'escalated',
    phase: 'ESCALATED',
    started_at: '2026-05-05T10:20:00.000Z',
    completed_at: '2026-05-05T10:30:00.000Z',
    escalation_reason: 'checkpoint-retry-timeout',
    cost_usd: 0.02,
    review_cycles: 2,
    dispatches: 1,
  }
}

function makeFailedStory(): AnyStory {
  return {
    status: 'failed',
    phase: 'FAILED',
    started_at: '2026-05-05T10:30:00.000Z',
    completed_at: '2026-05-05T10:35:00.000Z',
    cost_usd: 0.01,
  }
}

function makeFixtureManifest(): AnyManifest {
  return {
    run_id: 'fixture-run-001',
    created_at: '2026-05-05T10:00:00.000Z',
    updated_at: '2026-05-05T10:30:00.000Z',
    run_status: 'completed',
    story_scope: ['71-1', '71-2', '71-3'],
    cli_flags: {},
    recovery_history: [],
    cost_accumulation: {
      per_story: { '71-1': 0.05, '71-2': 0.03, '71-3': 0.02 },
      run_total: 0.10,
    },
    per_story_state: {
      '71-1': makeVerifiedStory(),
      '71-2': makeRecoveredStory(),
      '71-3': makeEscalatedStory(),
    },
  }
}

// ---------------------------------------------------------------------------
// Mock setup helper
// ---------------------------------------------------------------------------

/**
 * Set up mocks so that the canonical run-discovery chain (Story 71-2 hot-fix)
 * resolves correctly:
 *   - getLatestRun(adapter) returns { id: runId } so the Dolt fallback fires
 *   - per-run JSON file at `<runs>/<runId>.json` returns the fixture manifest
 *   - readdir lists the per-run JSON file
 */
function setupManifestMock(manifest: AnyManifest, runId: string): void {
  mockGetLatestRun.mockResolvedValue({ id: runId, methodology: 'sdlc', status: 'completed' })
  mockReadFile.mockImplementation(async (path: unknown) => {
    const p = String(path)
    if (p.endsWith(`${runId}.json`) || p.endsWith(`${String(manifest.run_id)}.json`)) {
      return JSON.stringify(manifest)
    }
    const err = Object.assign(new Error(`ENOENT: ${p}`), { code: 'ENOENT' })
    throw err
  })
  mockReaddir.mockResolvedValue([`${runId}.json`])
}

/** Shared action options using _dbRoot to bypass git resolution. */
function actionOpts(extra: Partial<Parameters<typeof runReportAction>[0]> = {}) {
  return {
    run: undefined as string | undefined,
    outputFormat: 'human' as const,
    projectRoot: '/fake',
    _dbRoot: FAKE_DB_ROOT,
    ...extra,
  }
}

// ---------------------------------------------------------------------------
// (a) classifyStoryOutcome — pure function tests
// ---------------------------------------------------------------------------

describe('classifyStoryOutcome', () => {
  it('(a1) verified: complete + verification_ran=true + no errors + 0 cycles', () => {
    expect(classifyStoryOutcome(makeVerifiedStory())).toBe('verified')
  })

  it('(a2) recovered: complete + verification_ran=false (Path A reconciled)', () => {
    const state = {
      status: 'complete',
      phase: 'COMPLETE',
      started_at: '2026-05-05T10:00:00.000Z',
      verification_result: { status: 'pass', verification_ran: false, error_count: 0, warn_count: 0, info_count: 0, findings: [] },
    }
    expect(classifyStoryOutcome(state)).toBe('recovered')
  })

  it('(a3) recovered: complete + review_cycles > 0', () => {
    expect(classifyStoryOutcome(makeRecoveredStory())).toBe('recovered')
  })

  it('(a4) recovered: complete + no verification_result (verification never ran)', () => {
    const state = { status: 'complete', phase: 'COMPLETE', started_at: '2026-05-05T10:00:00.000Z' }
    expect(classifyStoryOutcome(state)).toBe('recovered')
  })

  it('(a5) escalated', () => {
    expect(classifyStoryOutcome(makeEscalatedStory())).toBe('escalated')
  })

  it('(a6) failed', () => {
    expect(classifyStoryOutcome(makeFailedStory())).toBe('failed')
  })

  it('(a7) dispatched/unknown status → failed', () => {
    const state = { status: 'dispatched', phase: 'IN_DEV', started_at: '2026-05-05T10:00:00.000Z' }
    expect(classifyStoryOutcome(state)).toBe('failed')
  })

  it('(a8) complete with error findings → recovered', () => {
    const state = {
      status: 'complete',
      phase: 'COMPLETE',
      started_at: '2026-05-05T10:00:00.000Z',
      review_cycles: 0,
      verification_result: { status: 'fail', verification_ran: true, error_count: 1, warn_count: 0, info_count: 0, findings: [] },
    }
    expect(classifyStoryOutcome(state)).toBe('recovered')
  })

  it('(a9) verified using real manifest format (checks array, no error findings, 0 cycles)', () => {
    const state = {
      status: 'complete',
      phase: 'COMPLETE',
      started_at: '2026-05-05T10:00:00.000Z',
      review_cycles: 0,
      verification_result: {
        status: 'pass',
        checks: [
          { findings: [] },
          { findings: [{ severity: 'warn' }] },
        ],
      },
    }
    expect(classifyStoryOutcome(state)).toBe('verified')
  })
})

// ---------------------------------------------------------------------------
// (e) enrichEscalation — checkpoint-retry-timeout
// ---------------------------------------------------------------------------

describe('enrichEscalation — (e) checkpoint-retry-timeout', () => {
  it('maps to reconcile-from-disk suggestion with correct fields', () => {
    const result = enrichEscalation('71-3', makeEscalatedStory(), 'fixture-run-001', makeFixtureManifest())
    expect(result.root_cause).toBe('checkpoint-retry-timeout')
    expect(result.suggested_operator_action).toContain('reconcile-from-disk')
    expect(result.suggested_operator_action).toContain('fixture-run-001')
    expect(result.story_key).toBe('71-3')
    expect(typeof result.recovery_attempts).toBe('number')
    expect(result.blast_radius).toContain('71-3')
  })

  it('verification-fail-after-cycles maps to metrics suggestion', () => {
    const state = { ...makeEscalatedStory(), escalation_reason: 'verification-fail-after-cycles' }
    const result = enrichEscalation('71-2', state, 'run-abc', makeFixtureManifest())
    expect(result.root_cause).toBe('verification-fail-after-cycles')
    expect(result.suggested_operator_action).toContain('metrics')
  })
})

// ---------------------------------------------------------------------------
// (f) enrichEscalation — unknown reason graceful fallback
// ---------------------------------------------------------------------------

describe('enrichEscalation — (f) unknown reason', () => {
  it('falls back gracefully for an unrecognised escalation reason', () => {
    const state = { status: 'escalated', phase: 'ESCALATED', started_at: '2026-05-05T10:00:00.000Z', escalation_reason: 'some-unknown-reason' }
    const result = enrichEscalation('71-1', state, 'test-run', makeFixtureManifest())
    expect(result.root_cause).toBe('some-unknown-reason')
    expect(result.suggested_operator_action).toBeTruthy()
    expect(result.story_key).toBe('71-1')
  })

  it('uses "unknown" root_cause when escalation_reason is absent', () => {
    const state = { status: 'escalated', phase: 'ESCALATED', started_at: '2026-05-05T10:00:00.000Z' }
    const result = enrichEscalation('71-2', state, 'run-xyz', makeFixtureManifest())
    expect(result.root_cause).toBe('unknown')
    expect(result.suggested_operator_action).toBeTruthy()
  })
})

// ---------------------------------------------------------------------------
// (g) no-runs-exist friendly error
// ---------------------------------------------------------------------------

describe('runReportAction — (g) no runs exist', () => {
  let stderrOutput: string

  beforeEach(() => {
    stderrOutput = ''
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      stderrOutput += typeof chunk === 'string' ? chunk : String(chunk)
      return true
    })
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    // No per-run JSON files, no current-run-id, no Dolt rows (Story 71-2 chain)
    mockReadFile.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }))
    mockReaddir.mockResolvedValue([])
    // Re-initialize Dolt fallback mocks (vi.restoreAllMocks in prior tests
    // can blank these out)
    mockGetLatestRun.mockResolvedValue(undefined)
    mockAdapterClose.mockResolvedValue(undefined)
    mockAdapterQuery.mockResolvedValue([])
    mockInitSchema.mockResolvedValue(undefined)
  })

  afterEach(() => {
    vi.restoreAllMocks()
    mockReadFile.mockReset()
    mockReaddir.mockReset()
  })

  it('exits with code 1 and "No runs found" for --run latest', async () => {
    const exitCode = await runReportAction(actionOpts({ run: 'latest' }))
    expect(exitCode).toBe(1)
    expect(stderrOutput).toContain('No runs found')
  })

  it('exits with code 1 when --run is omitted', async () => {
    const exitCode = await runReportAction(actionOpts({ run: undefined }))
    expect(exitCode).toBe(1)
    expect(stderrOutput).toContain('No runs found')
  })
})

// ---------------------------------------------------------------------------
// (b) --run latest resolves same output as omitting --run
// ---------------------------------------------------------------------------

describe('runReportAction — (b) --run latest matches default', () => {
  let stdoutOutput: string
  const FIXTURE_RUN_ID = 'fixture-run-001'
  const manifest = makeFixtureManifest()

  function resetAndSetup(): void {
    stdoutOutput = ''
    vi.restoreAllMocks()
    mockReadFile.mockReset()
    mockReaddir.mockReset()
    // Re-initialize Dolt fallback mocks (Story 71-2 hot-fix)
    mockGetLatestRun.mockResolvedValue(undefined)
    mockAdapterClose.mockResolvedValue(undefined)
    mockAdapterQuery.mockResolvedValue([])
    mockInitSchema.mockResolvedValue(undefined)
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      stdoutOutput += typeof chunk === 'string' ? chunk : String(chunk)
      return true
    })
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    setupManifestMock(manifest, FIXTURE_RUN_ID)
  }

  afterEach(() => {
    vi.restoreAllMocks()
    mockReadFile.mockReset()
    mockReaddir.mockReset()
  })

  it('--run latest produces identical output to omitting --run', async () => {
    resetAndSetup()
    const exitDefault = await runReportAction(actionOpts({ run: undefined }))
    const outputDefault = stdoutOutput

    resetAndSetup()
    const exitLatest = await runReportAction(actionOpts({ run: 'latest' }))
    const outputLatest = stdoutOutput

    expect(exitDefault).toBe(0)
    expect(exitLatest).toBe(0)
    expect(outputLatest).toBe(outputDefault)
  })
})

// ---------------------------------------------------------------------------
// (c) Human output golden-master
// ---------------------------------------------------------------------------

describe('runReportAction — (c) human output', () => {
  let stdoutOutput: string
  const FIXTURE_RUN_ID = 'fixture-run-001'
  const manifest = makeFixtureManifest()

  beforeEach(() => {
    stdoutOutput = ''
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      stdoutOutput += typeof chunk === 'string' ? chunk : String(chunk)
      return true
    })
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    setupManifestMock(manifest, FIXTURE_RUN_ID)
  })

  afterEach(() => {
    vi.restoreAllMocks()
    mockReadFile.mockReset()
    mockReaddir.mockReset()
  })

  it('contains summary line with correct counts', async () => {
    const exitCode = await runReportAction(actionOpts({ run: FIXTURE_RUN_ID }))
    expect(exitCode).toBe(0)
    expect(stdoutOutput).toContain('1 verified')
    expect(stdoutOutput).toContain('1 recovered')
    expect(stdoutOutput).toContain('1 escalated')
    expect(stdoutOutput).toContain('3 total')
  })

  it('contains run ID in banner', async () => {
    await runReportAction(actionOpts({ run: FIXTURE_RUN_ID }))
    expect(stdoutOutput).toContain(FIXTURE_RUN_ID)
  })

  it('findings column uses E:N W:N I:N format', async () => {
    await runReportAction(actionOpts({ run: FIXTURE_RUN_ID }))
    expect(stdoutOutput).toMatch(/E:\d+ W:\d+ I:\d+/)
  })

  it('escalation detail block shows checkpoint-retry-timeout and reconcile-from-disk', async () => {
    await runReportAction(actionOpts({ run: FIXTURE_RUN_ID }))
    expect(stdoutOutput).toContain('checkpoint-retry-timeout')
    expect(stdoutOutput).toContain('reconcile-from-disk')
  })
})

// ---------------------------------------------------------------------------
// (d) JSON output golden-master
// ---------------------------------------------------------------------------

describe('runReportAction — (d) JSON output', () => {
  let stdoutOutput: string
  const FIXTURE_RUN_ID = 'fixture-run-001'
  const manifest = makeFixtureManifest()

  beforeEach(() => {
    stdoutOutput = ''
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      stdoutOutput += typeof chunk === 'string' ? chunk : String(chunk)
      return true
    })
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    setupManifestMock(manifest, FIXTURE_RUN_ID)
  })

  afterEach(() => {
    vi.restoreAllMocks()
    mockReadFile.mockReset()
    mockReaddir.mockReset()
  })

  it('parses cleanly as JSON', async () => {
    const exitCode = await runReportAction(actionOpts({ run: FIXTURE_RUN_ID, outputFormat: 'json' }))
    expect(exitCode).toBe(0)
    expect(() => JSON.parse(stdoutOutput)).not.toThrow()
  })

  it('has all required top-level keys', async () => {
    await runReportAction(actionOpts({ run: FIXTURE_RUN_ID, outputFormat: 'json' }))
    const parsed = JSON.parse(stdoutOutput) as Record<string, unknown>
    expect(parsed).toHaveProperty('runId')
    expect(parsed).toHaveProperty('summary')
    expect(parsed).toHaveProperty('stories')
    expect(parsed).toHaveProperty('escalations')
    expect(parsed).toHaveProperty('cost')
    expect(parsed).toHaveProperty('duration')
  })

  it('stories array has correct per-story outcomes', async () => {
    await runReportAction(actionOpts({ run: FIXTURE_RUN_ID, outputFormat: 'json' }))
    const parsed = JSON.parse(stdoutOutput) as { stories: Array<{ story_key: string; outcome: string }> }
    const outcomes = new Map(parsed.stories.map((s) => [s.story_key, s.outcome]))
    expect(outcomes.get('71-1')).toBe('verified')
    expect(outcomes.get('71-2')).toBe('recovered')
    expect(outcomes.get('71-3')).toBe('escalated')
  })

  it('escalations contains enriched diagnostic detail', async () => {
    await runReportAction(actionOpts({ run: FIXTURE_RUN_ID, outputFormat: 'json' }))
    const parsed = JSON.parse(stdoutOutput) as {
      escalations: Array<{ story_key: string; root_cause: string; suggested_operator_action: string }>
    }
    expect(parsed.escalations.length).toBe(1)
    const esc = parsed.escalations[0]!
    expect(esc.story_key).toBe('71-3')
    expect(esc.root_cause).toBe('checkpoint-retry-timeout')
    expect(esc.suggested_operator_action).toContain('reconcile-from-disk')
  })

  it('stories[].verification_findings has full breakdown with byAuthor', async () => {
    await runReportAction(actionOpts({ run: FIXTURE_RUN_ID, outputFormat: 'json' }))
    const parsed = JSON.parse(stdoutOutput) as {
      stories: Array<{
        story_key: string
        verification_findings: { error: number; warn: number; info: number; byAuthor: object }
      }>
    }
    const s1 = parsed.stories.find((s) => s.story_key === '71-1')
    expect(s1?.verification_findings).toMatchObject({ error: 0, warn: 0, info: 0 })
    expect(s1?.verification_findings).toHaveProperty('byAuthor')
  })
})
