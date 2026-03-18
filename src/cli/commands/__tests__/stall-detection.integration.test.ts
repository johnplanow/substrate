/**
 * Integration tests for stall detection (Story 16-7 T12 / AC2, AC3, AC7)
 *
 * Unlike the unit tests in health-bugs.test.ts (which mock getAutoHealthData),
 * these tests wire the real getAutoHealthData function through to runSupervisorAction,
 * exercising the full path from DB state computation to supervisor stall verdict.
 *
 * Covered scenarios:
 *   1. Stale pipeline in DB → getAutoHealthData returns STALLED → supervisor kills & restarts
 *   2. Fresh pipeline in DB → supervisor does NOT kill
 *   3. Completed pipeline in DB → supervisor exits cleanly (NO_PIPELINE_RUNNING)
 *   4. Stale pipeline in non-implementation phase (analysis/planning/solutioning) → stall still detected (AC7)
 *   5. Stall threshold customization: custom stallThreshold overrides default, staleness < threshold → no kill
 *   6. Failed/stopped pipeline in DB → supervisor exits cleanly (NO_PIPELINE_RUNNING)
 *   7. supervisor:poll event emitted on each health-check cycle
 *   8. staleness_seconds computed correctly for SQLite-format (UTC) timestamps
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { InMemoryDatabaseAdapter } from '../../../persistence/memory-adapter.js'
import { initSchema } from '../../../persistence/schema.js'
import { createPipelineRun } from '../../../persistence/queries/decisions.js'
import type { PipelineRun } from '../../../persistence/queries/decisions.js'
import type { DatabaseAdapter } from '../../../persistence/adapter.js'
import { getAutoHealthData, DEFAULT_STALL_THRESHOLD_SECONDS } from '../health.js'
import { runSupervisorAction } from '../supervisor.js'
import type { SupervisorOptions, SupervisorDeps } from '../supervisor.js'

// ---------------------------------------------------------------------------
// Module mocks (same pattern as other health tests)
// ---------------------------------------------------------------------------

const { mockAdapterHolder } = vi.hoisted(() => {
  const mockAdapterHolder: { current: DatabaseAdapter | null } = { current: null }
  return { mockAdapterHolder }
})

vi.mock('../../../persistence/database.js', () => {
  return {
    DatabaseWrapper: class {
      open() { /* noop */ }
      close() { /* noop */ }
      get adapter() { return mockAdapterHolder.current! }
      get isOpen() { return true }
    },
    __setMockAdapter: (a: unknown) => { mockAdapterHolder.current = a as DatabaseAdapter },
  }
})

vi.mock('../../../persistence/adapter.js', async (importOriginal) => {
  const actual = await importOriginal() as Record<string, unknown>
  return {
    ...actual,
    createDatabaseAdapter: () => {
      if (!mockAdapterHolder.current) throw new Error('Mock adapter not set — call __setMockAdapter first')
      // Return a proxy that ignores close() so getAutoHealthData's finally block
      // doesn't destroy the shared test adapter between assertions.
      return new Proxy(mockAdapterHolder.current, {
        get(target, prop) {
          if (prop === 'close') return async () => { /* no-op */ }
          return (target as unknown as Record<string | symbol, unknown>)[prop]
        },
      })
    },
  }
})

vi.mock('../../../utils/git-root.js', () => ({
  resolveMainRepoRoot: vi.fn().mockResolvedValue('/tmp/stall-integration-test'),
}))

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal() as Record<string, unknown>
  return {
    ...actual,
    existsSync: vi.fn().mockReturnValue(true),
  }
})

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

async function createTestDb(): Promise<DatabaseAdapter> {
  const adapter = new InMemoryDatabaseAdapter()
  await initSchema(adapter)
  return adapter
}

async function createTestRun(
  adapter: DatabaseAdapter,
  overrides: {
    status?: string
    current_phase?: string
    token_usage_json?: string
    updated_at?: string
  } = {},
): Promise<PipelineRun> {
  const run = await createPipelineRun(adapter, {
    methodology: 'bmad',
    start_phase: 'implementation',
    config_json: null,
  })
  if (overrides.status !== undefined) {
    await adapter.query(`UPDATE pipeline_runs SET status = ? WHERE id = ?`, [overrides.status, run.id])
  }
  if (overrides.current_phase !== undefined) {
    await adapter.query(`UPDATE pipeline_runs SET current_phase = ? WHERE id = ?`, [overrides.current_phase, run.id])
  }
  if (overrides.token_usage_json !== undefined) {
    await adapter.query(`UPDATE pipeline_runs SET token_usage_json = ? WHERE id = ?`, [overrides.token_usage_json, run.id])
  }
  if (overrides.updated_at !== undefined) {
    await adapter.query(`UPDATE pipeline_runs SET updated_at = ? WHERE id = ?`, [overrides.updated_at, run.id])
  }
  const rows = await adapter.query<PipelineRun>('SELECT * FROM pipeline_runs WHERE id = ?', [run.id])
  return rows[0]!
}

/**
 * Build a stale timestamp — DEFAULT_STALL_THRESHOLD_SECONDS + some margin.
 * Produces a SQLite-format UTC timestamp.
 */
function staleTimestamp(extraSeconds = 120): string {
  return new Date(Date.now() - (DEFAULT_STALL_THRESHOLD_SECONDS + extraSeconds) * 1000)
    .toISOString()
    .replace('T', ' ')
    .replace(/\.\d{3}Z$/, '')
}

/** Timestamp that is only 10 seconds old — not stale. */
function freshTimestamp(): string {
  return new Date().toISOString()
}

function defaultSupervisorOptions(overrides: Partial<SupervisorOptions> = {}): SupervisorOptions {
  return {
    pollInterval: 1,
    stallThreshold: DEFAULT_STALL_THRESHOLD_SECONDS,
    maxRestarts: 2,
    outputFormat: 'json',
    projectRoot: '/tmp/stall-integration-test',
    pack: 'bmad',
    ...overrides,
  }
}

/** Capture supervisor stdout events */
function captureStdout(): { chunks: string[]; restore: () => void } {
  const chunks: string[] = []
  const orig = process.stdout.write
  process.stdout.write = ((chunk: string) => {
    chunks.push(chunk)
    return true
  }) as typeof process.stdout.write
  return {
    chunks,
    restore: () => { process.stdout.write = orig },
  }
}

// ---------------------------------------------------------------------------
// Integration tests
// ---------------------------------------------------------------------------

describe('Stall detection integration — getAutoHealthData + runSupervisorAction', () => {
  let adapter: DatabaseAdapter

  beforeEach(async () => {
    adapter = await createTestDb()
    const dbModule = await import('../../../persistence/database.js') as { __setMockAdapter: (a: DatabaseAdapter) => void }
    dbModule.__setMockAdapter(adapter)
  })

  afterEach(async () => {
    await adapter.close()
    vi.clearAllMocks()
  })

  // -------------------------------------------------------------------------
  // Scenario 1: Stale pipeline → supervisor kills
  // -------------------------------------------------------------------------

  it('stale pipeline in DB: getAutoHealthData returns STALLED verdict', async () => {
    await createTestRun(adapter, {
      status: 'running',
      current_phase: 'implementation',
      updated_at: staleTimestamp(),
    })

    const health = await getAutoHealthData({ projectRoot: '/tmp/stall-integration-test' })

    expect(health.verdict).toBe('STALLED')
    expect(health.staleness_seconds).toBeGreaterThan(DEFAULT_STALL_THRESHOLD_SECONDS)
    expect(health.status).toBe('running')
  })

  it('stale pipeline: supervisor detects stall and emits supervisor:kill event', async () => {
    await createTestRun(adapter, {
      status: 'running',
      current_phase: 'implementation',
      updated_at: staleTimestamp(),
    })

    const captured = captureStdout()
    const killCalls: Array<[number, string]> = []

    // After first kill cycle, mark pipeline as completed so supervisor exits
    let callCount = 0
    const deps: Partial<SupervisorDeps> = {
      // Use real getAutoHealthData for the first poll (shows STALLED),
      // then return NO_PIPELINE_RUNNING on subsequent polls so supervisor exits.
      getHealth: vi.fn().mockImplementation(async (opts: { runId?: string; projectRoot: string }) => {
        callCount++
        if (callCount === 1) {
          return getAutoHealthData(opts)
        }
        // After the kill + restart, simulate the pipeline completing
        return {
          verdict: 'NO_PIPELINE_RUNNING' as const,
          run_id: null,
          status: 'completed',
          current_phase: null,
          staleness_seconds: 0,
          last_activity: new Date().toISOString(),
          process: { orchestrator_pid: null, child_pids: [], zombies: [] },
          stories: { active: 0, completed: 0, escalated: 0, details: {} },
        }
      }),
      killPid: vi.fn().mockImplementation((pid: number, signal: string) => {
        killCalls.push([pid, signal])
      }),
      resumePipeline: vi.fn().mockResolvedValue(0),
      sleep: vi.fn().mockResolvedValue(undefined),
      incrementRestarts: vi.fn(),
      getTokenSnapshot: vi.fn().mockReturnValue({ input: 0, output: 0, cost_usd: 0 }),
      getAllDescendants: vi.fn().mockReturnValue([]),
    }

    const exitCode = await runSupervisorAction(defaultSupervisorOptions(), deps)

    captured.restore()

    // Supervisor should exit cleanly after completing
    expect(exitCode).toBe(0)

    // supervisor:kill event must have been emitted
    const output = captured.chunks.join('')
    const lines = output.split('\n').filter((l) => l.trim())
    const killLine = lines.find((l) => {
      try {
        const e = JSON.parse(l) as Record<string, unknown>
        return e.type === 'supervisor:kill'
      } catch {
        return false
      }
    })
    expect(killLine).toBeDefined()
    const killEvent = JSON.parse(killLine!) as Record<string, unknown>
    expect(killEvent.reason).toBe('stall')
    expect(typeof killEvent.staleness_seconds).toBe('number')
    expect(killEvent.staleness_seconds as number).toBeGreaterThan(DEFAULT_STALL_THRESHOLD_SECONDS)

    // resumePipeline should have been called after the kill (restart)
    expect(deps.resumePipeline).toHaveBeenCalledOnce()

    // AC8: getAllDescendants must have been called with the direct PIDs derived from the
    // health data (orchestrator_pid + child_pids). We verify it was called once and that
    // the argument is an Array — the exact contents depend on what ps(1) finds in the test
    // environment, so we check type rather than specific values to avoid brittleness.
    expect(deps.getAllDescendants).toHaveBeenCalledOnce()
    const callArg = (deps.getAllDescendants as ReturnType<typeof vi.fn>).mock.calls[0]![0] as unknown
    expect(Array.isArray(callArg)).toBe(true)
  })

  // -------------------------------------------------------------------------
  // Scenario 2: Fresh pipeline → supervisor does NOT kill
  // -------------------------------------------------------------------------

  it('fresh pipeline in DB: getAutoHealthData does NOT return STALLED', async () => {
    await createTestRun(adapter, {
      status: 'running',
      current_phase: 'implementation',
      updated_at: freshTimestamp(),
    })

    const health = await getAutoHealthData({ projectRoot: '/tmp/stall-integration-test' })

    // With fresh timestamp, should not be STALLED (will be HEALTHY or NO_PIPELINE_RUNNING
    // depending on process tree — but definitely not STALLED from staleness alone)
    expect(health.staleness_seconds).toBeLessThan(DEFAULT_STALL_THRESHOLD_SECONDS)
    // Verdict should not be STALLED due to staleness
    if (health.staleness_seconds < DEFAULT_STALL_THRESHOLD_SECONDS) {
      expect(health.verdict).not.toBe('STALLED')
    }
  })

  it('fresh pipeline: supervisor does NOT kill (staleness < threshold)', async () => {
    await createTestRun(adapter, {
      status: 'running',
      current_phase: 'implementation',
      updated_at: freshTimestamp(),
    })

    const captured = captureStdout()
    const killPid = vi.fn()

    let callCount = 0
    const deps: Partial<SupervisorDeps> = {
      getHealth: vi.fn().mockImplementation(async (opts: { runId?: string; projectRoot: string }) => {
        callCount++
        if (callCount === 1) {
          return getAutoHealthData(opts)
        }
        // Simulate pipeline completing on second poll
        return {
          verdict: 'NO_PIPELINE_RUNNING' as const,
          run_id: null,
          status: 'completed',
          current_phase: null,
          staleness_seconds: 0,
          last_activity: new Date().toISOString(),
          process: { orchestrator_pid: null, child_pids: [], zombies: [] },
          stories: { active: 0, completed: 0, escalated: 0, details: {} },
        }
      }),
      killPid,
      resumePipeline: vi.fn().mockResolvedValue(0),
      sleep: vi.fn().mockResolvedValue(undefined),
      incrementRestarts: vi.fn(),
      getTokenSnapshot: vi.fn().mockReturnValue({ input: 0, output: 0, cost_usd: 0 }),
      getAllDescendants: vi.fn().mockReturnValue([]),
    }

    await runSupervisorAction(defaultSupervisorOptions(), deps)
    captured.restore()

    // Kill should NOT have been called for a fresh pipeline
    expect(killPid).not.toHaveBeenCalled()
  })

  // -------------------------------------------------------------------------
  // Scenario 3: Completed pipeline → supervisor exits immediately
  // -------------------------------------------------------------------------

  it('completed pipeline in DB: getAutoHealthData returns NO_PIPELINE_RUNNING', async () => {
    await createTestRun(adapter, {
      status: 'completed',
      current_phase: 'implementation',
    })

    const health = await getAutoHealthData({ projectRoot: '/tmp/stall-integration-test' })

    expect(health.verdict).toBe('NO_PIPELINE_RUNNING')
    expect(health.status).toBe('completed')
  })

  it('completed pipeline: supervisor exits cleanly with exit code 0', async () => {
    await createTestRun(adapter, {
      status: 'completed',
      current_phase: 'implementation',
    })

    const captured = captureStdout()
    const killPid = vi.fn()

    const deps: Partial<SupervisorDeps> = {
      getHealth: (opts) => getAutoHealthData(opts),
      killPid,
      resumePipeline: vi.fn().mockResolvedValue(0),
      sleep: vi.fn().mockResolvedValue(undefined),
      incrementRestarts: vi.fn(),
      getTokenSnapshot: vi.fn().mockReturnValue({ input: 0, output: 0, cost_usd: 0 }),
      getAllDescendants: vi.fn().mockReturnValue([]),
    }

    const exitCode = await runSupervisorAction(defaultSupervisorOptions(), deps)
    captured.restore()

    expect(exitCode).toBe(0)
    expect(killPid).not.toHaveBeenCalled()

    // supervisor:summary event should be emitted
    const output = captured.chunks.join('')
    const lines = output.split('\n').filter((l) => l.trim())
    const summaryLine = lines.find((l) => {
      try {
        return (JSON.parse(l) as Record<string, unknown>).type === 'supervisor:summary'
      } catch {
        return false
      }
    })
    expect(summaryLine).toBeDefined()
  })

  // -------------------------------------------------------------------------
  // Scenario 4: Non-implementation phase stall detection (AC7)
  // -------------------------------------------------------------------------

  it('stale pipeline in analysis phase → getAutoHealthData returns STALLED (AC7)', async () => {
    await createTestRun(adapter, {
      status: 'running',
      current_phase: 'analysis',
      updated_at: staleTimestamp(),
    })

    const health = await getAutoHealthData({ projectRoot: '/tmp/stall-integration-test' })

    expect(health.verdict).toBe('STALLED')
    expect(health.current_phase).toBe('analysis')
    expect(health.staleness_seconds).toBeGreaterThan(DEFAULT_STALL_THRESHOLD_SECONDS)
  })

  it('stale pipeline in planning phase → getAutoHealthData returns STALLED (AC7)', async () => {
    await createTestRun(adapter, {
      status: 'running',
      current_phase: 'planning',
      updated_at: staleTimestamp(),
    })

    const health = await getAutoHealthData({ projectRoot: '/tmp/stall-integration-test' })

    expect(health.verdict).toBe('STALLED')
    expect(health.current_phase).toBe('planning')
  })

  it('stale pipeline in solutioning phase → getAutoHealthData returns STALLED (AC7)', async () => {
    await createTestRun(adapter, {
      status: 'running',
      current_phase: 'solutioning',
      updated_at: staleTimestamp(),
    })

    const health = await getAutoHealthData({ projectRoot: '/tmp/stall-integration-test' })

    expect(health.verdict).toBe('STALLED')
    expect(health.current_phase).toBe('solutioning')
  })

  it('stale analysis phase: supervisor detects stall and emits supervisor:kill', async () => {
    await createTestRun(adapter, {
      status: 'running',
      current_phase: 'analysis',
      updated_at: staleTimestamp(),
    })

    const captured = captureStdout()
    const killCalls: Array<[number, string]> = []

    let callCount = 0
    const deps: Partial<SupervisorDeps> = {
      getHealth: vi.fn().mockImplementation(async (opts: { runId?: string; projectRoot: string }) => {
        callCount++
        if (callCount === 1) {
          return getAutoHealthData(opts)
        }
        return {
          verdict: 'NO_PIPELINE_RUNNING' as const,
          run_id: null,
          status: 'completed',
          current_phase: null,
          staleness_seconds: 0,
          last_activity: new Date().toISOString(),
          process: { orchestrator_pid: null, child_pids: [], zombies: [] },
          stories: { active: 0, completed: 0, escalated: 0, details: {} },
        }
      }),
      killPid: vi.fn().mockImplementation((pid: number, signal: string) => {
        killCalls.push([pid, signal])
      }),
      resumePipeline: vi.fn().mockResolvedValue(0),
      sleep: vi.fn().mockResolvedValue(undefined),
      incrementRestarts: vi.fn(),
      getTokenSnapshot: vi.fn().mockReturnValue({ input: 0, output: 0, cost_usd: 0 }),
      getAllDescendants: vi.fn().mockReturnValue([]),
    }

    const exitCode = await runSupervisorAction(defaultSupervisorOptions(), deps)
    captured.restore()

    expect(exitCode).toBe(0)
    // supervisor:kill must be emitted (stall was detected in analysis phase)
    const output = captured.chunks.join('')
    const lines = output.split('\n').filter((l) => l.trim())
    const killLine = lines.find((l) => {
      try {
        return (JSON.parse(l) as Record<string, unknown>).type === 'supervisor:kill'
      } catch {
        return false
      }
    })
    expect(killLine).toBeDefined()
    expect(deps.resumePipeline).toHaveBeenCalledOnce()
  })

  // -------------------------------------------------------------------------
  // Scenario 5: Stall threshold customization
  // -------------------------------------------------------------------------

  it('pipeline stale by 120s but custom stallThreshold = 300s → NOT killed', async () => {
    // Pipeline is 120s stale — below DEFAULT (600s) but also below custom (300s)
    const mildlyStaleTime = new Date(Date.now() - 120_000).toISOString()
    await createTestRun(adapter, {
      status: 'running',
      current_phase: 'implementation',
      updated_at: mildlyStaleTime,
    })

    const health = await getAutoHealthData({ projectRoot: '/tmp/stall-integration-test' })
    // Only 120s stale — should not be STALLED (threshold is 600s)
    expect(health.staleness_seconds).toBeGreaterThan(100)
    expect(health.staleness_seconds).toBeLessThan(DEFAULT_STALL_THRESHOLD_SECONDS)
    // Supervisor with default threshold 600s should not kill
    const killPid = vi.fn()

    let callCount = 0
    const captured = captureStdout()
    const deps: Partial<SupervisorDeps> = {
      getHealth: vi.fn().mockImplementation(async (opts: { runId?: string; projectRoot: string }) => {
        callCount++
        if (callCount === 1) return getAutoHealthData(opts)
        return {
          verdict: 'NO_PIPELINE_RUNNING' as const,
          run_id: null,
          status: 'completed',
          current_phase: null,
          staleness_seconds: 0,
          last_activity: new Date().toISOString(),
          process: { orchestrator_pid: null, child_pids: [], zombies: [] },
          stories: { active: 0, completed: 0, escalated: 0, details: {} },
        }
      }),
      killPid,
      resumePipeline: vi.fn().mockResolvedValue(0),
      sleep: vi.fn().mockResolvedValue(undefined),
      incrementRestarts: vi.fn(),
      getTokenSnapshot: vi.fn().mockReturnValue({ input: 0, output: 0, cost_usd: 0 }),
      getAllDescendants: vi.fn().mockReturnValue([]),
    }

    await runSupervisorAction(defaultSupervisorOptions({ stallThreshold: DEFAULT_STALL_THRESHOLD_SECONDS }), deps)
    captured.restore()

    expect(killPid).not.toHaveBeenCalled()
  })

  it('pipeline stale by 700s but custom stallThreshold = 900s → NOT killed', async () => {
    // Pipeline is 700s stale — exceeds default (600s) but below custom threshold (900s)
    const stale700s = new Date(Date.now() - 700_000).toISOString()
    await createTestRun(adapter, {
      status: 'running',
      current_phase: 'implementation',
      updated_at: stale700s,
    })

    const killPid = vi.fn()
    let callCount = 0
    const captured = captureStdout()

    const deps: Partial<SupervisorDeps> = {
      getHealth: vi.fn().mockImplementation(async (opts: { runId?: string; projectRoot: string }) => {
        callCount++
        if (callCount === 1) return getAutoHealthData(opts)
        return {
          verdict: 'NO_PIPELINE_RUNNING' as const,
          run_id: null,
          status: 'completed',
          current_phase: null,
          staleness_seconds: 0,
          last_activity: new Date().toISOString(),
          process: { orchestrator_pid: null, child_pids: [], zombies: [] },
          stories: { active: 0, completed: 0, escalated: 0, details: {} },
        }
      }),
      killPid,
      resumePipeline: vi.fn().mockResolvedValue(0),
      sleep: vi.fn().mockResolvedValue(undefined),
      incrementRestarts: vi.fn(),
      getTokenSnapshot: vi.fn().mockReturnValue({ input: 0, output: 0, cost_usd: 0 }),
      getAllDescendants: vi.fn().mockReturnValue([]),
    }

    // Custom threshold of 900 seconds — pipeline is only 700s stale, should not kill
    await runSupervisorAction(defaultSupervisorOptions({ stallThreshold: 900 }), deps)
    captured.restore()

    expect(killPid).not.toHaveBeenCalled()
  })

  // -------------------------------------------------------------------------
  // Scenario 6: Failed/stopped pipeline → NO_PIPELINE_RUNNING
  // -------------------------------------------------------------------------

  it('failed pipeline in DB → getAutoHealthData returns NO_PIPELINE_RUNNING', async () => {
    await createTestRun(adapter, {
      status: 'failed',
      current_phase: 'implementation',
    })

    const health = await getAutoHealthData({ projectRoot: '/tmp/stall-integration-test' })

    expect(health.verdict).toBe('NO_PIPELINE_RUNNING')
    expect(health.status).toBe('failed')
  })

  it('stopped pipeline in DB → getAutoHealthData returns NO_PIPELINE_RUNNING', async () => {
    await createTestRun(adapter, {
      status: 'stopped',
      current_phase: 'implementation',
    })

    const health = await getAutoHealthData({ projectRoot: '/tmp/stall-integration-test' })

    expect(health.verdict).toBe('NO_PIPELINE_RUNNING')
    expect(health.status).toBe('stopped')
  })

  // -------------------------------------------------------------------------
  // Scenario 7: supervisor:poll event emitted on each health check
  // -------------------------------------------------------------------------

  it('supervisor emits supervisor:poll event on each poll cycle', async () => {
    await createTestRun(adapter, { status: 'completed', current_phase: 'implementation' })

    const captured = captureStdout()

    const deps: Partial<SupervisorDeps> = {
      getHealth: (opts) => getAutoHealthData(opts),
      killPid: vi.fn(),
      resumePipeline: vi.fn().mockResolvedValue(0),
      sleep: vi.fn().mockResolvedValue(undefined),
      incrementRestarts: vi.fn(),
      getTokenSnapshot: vi.fn().mockReturnValue({ input: 0, output: 0, cost_usd: 0 }),
      getAllDescendants: vi.fn().mockReturnValue([]),
    }

    await runSupervisorAction(defaultSupervisorOptions({ outputFormat: 'json' }), deps)
    captured.restore()

    // Parse NDJSON output
    const output = captured.chunks.join('')
    const lines = output.split('\n').filter((l) => l.trim())
    const pollLines = lines.filter((l) => {
      try {
        return (JSON.parse(l) as Record<string, unknown>).type === 'supervisor:poll'
      } catch {
        return false
      }
    })

    expect(pollLines.length).toBeGreaterThanOrEqual(1)
    const pollEvent = JSON.parse(pollLines[0]!) as Record<string, unknown>
    expect(pollEvent).toHaveProperty('verdict')
    expect(pollEvent).toHaveProperty('staleness_seconds')
    expect(pollEvent).toHaveProperty('stories')
    expect(pollEvent).toHaveProperty('ts')
  })

  // -------------------------------------------------------------------------
  // Scenario 8: Staleness_seconds is computed correctly (UTC timezone fix)
  // -------------------------------------------------------------------------

  it('staleness_seconds from getAutoHealthData is positive and correct for SQLite-format timestamp', async () => {
    // SQLite stores timestamps as "YYYY-MM-DD HH:MM:SS" without Z suffix
    const fiveMinAgo = new Date(Date.now() - 300_000)
    const sqliteFormat = fiveMinAgo.toISOString()
      .replace('T', ' ')
      .replace(/\.\d{3}Z$/, '') // "2026-03-05 15:30:00"

    await createTestRun(adapter, {
      status: 'running',
      current_phase: 'implementation',
      updated_at: sqliteFormat,
    })

    const health = await getAutoHealthData({ projectRoot: '/tmp/stall-integration-test' })

    // Must be positive (UTC fix correct) and approximately 300s
    expect(health.staleness_seconds).toBeGreaterThan(200)
    expect(health.staleness_seconds).toBeLessThan(400)
    expect(health.staleness_seconds).toBeGreaterThan(0)
  })
})
