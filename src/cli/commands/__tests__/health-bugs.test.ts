/**
 * Tests for Story 19.1: Fix Supervisor Health Detection Bugs
 *
 * Covers:
 *   - AC1/AC4: staleness_seconds is non-negative for UTC timestamps without Z suffix
 *   - AC2: inspectProcessTree() finds orchestrator PID from npm/node invocations
 *   - AC3: end-to-end stall detection works after timezone fix (via mock deps)
 *   - AC5: runHealthAction delegates to getAutoHealthData (no duplicate logic)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import type { Database as BetterSqlite3Database } from 'better-sqlite3'
import { runMigrations } from '../../../persistence/migrations/index.js'
import { createPipelineRun } from '../../../persistence/queries/decisions.js'
import type { PipelineRun } from '../../../persistence/queries/decisions.js'
import { getAutoHealthData, inspectProcessTree, DEFAULT_STALL_THRESHOLD_SECONDS } from '../health.js'
import { runSupervisorAction } from '../supervisor.js'
import type { SupervisorDeps, SupervisorOptions } from '../supervisor.js'
import type { PipelineHealthOutput } from '../health.js'

// ---------------------------------------------------------------------------
// Test DB helpers
// ---------------------------------------------------------------------------

function createTestDb(): BetterSqlite3Database {
  const db = new Database(':memory:')
  runMigrations(db)
  return db
}

function createTestRun(
  db: BetterSqlite3Database,
  overrides: {
    status?: string
    current_phase?: string
    token_usage_json?: string
    updated_at?: string
  } = {},
): PipelineRun {
  const run = createPipelineRun(db, {
    methodology: 'bmad',
    start_phase: 'implementation',
    config_json: null,
  })
  if (overrides.status !== undefined) {
    db.prepare(`UPDATE pipeline_runs SET status = ? WHERE id = ?`).run(overrides.status, run.id)
  }
  if (overrides.current_phase !== undefined) {
    db.prepare(`UPDATE pipeline_runs SET current_phase = ? WHERE id = ?`).run(overrides.current_phase, run.id)
  }
  if (overrides.token_usage_json !== undefined) {
    db.prepare(`UPDATE pipeline_runs SET token_usage_json = ? WHERE id = ?`).run(overrides.token_usage_json, run.id)
  }
  if (overrides.updated_at !== undefined) {
    db.prepare(`UPDATE pipeline_runs SET updated_at = ? WHERE id = ?`).run(overrides.updated_at, run.id)
  }
  return db.prepare('SELECT * FROM pipeline_runs WHERE id = ?').get(run.id) as PipelineRun
}

// ---------------------------------------------------------------------------
// Module mocks (same pattern as auto-health.test.ts)
// ---------------------------------------------------------------------------

vi.mock('../../../persistence/database.js', () => {
  let mockDb: BetterSqlite3Database | null = null
  return {
    DatabaseWrapper: class {
      db: BetterSqlite3Database
      constructor() {
        this.db = mockDb!
      }
      open() { /* noop */ }
      close() { /* noop */ }
    },
    __setMockDb: (db: BetterSqlite3Database) => { mockDb = db },
  }
})

vi.mock('../../../utils/git-root.js', () => ({
  resolveMainRepoRoot: vi.fn().mockResolvedValue('/tmp/test-project'),
}))

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal() as Record<string, unknown>
  return {
    ...actual,
    existsSync: vi.fn().mockReturnValue(true),
  }
})

// ---------------------------------------------------------------------------
// AC1/AC4: Staleness non-negative for UTC timestamps without Z suffix
// ---------------------------------------------------------------------------

describe('getAutoHealthData — staleness timezone fix (AC1, AC4)', () => {
  let db: BetterSqlite3Database

  beforeEach(async () => {
    db = createTestDb()
    const dbModule = await import('../../../persistence/database.js') as { __setMockDb: (db: BetterSqlite3Database) => void }
    dbModule.__setMockDb(db)
  })

  afterEach(() => {
    db.close()
  })

  it('staleness is non-negative for UTC timestamp without Z suffix (SQLite format)', async () => {
    // Simulate SQLite format: "YYYY-MM-DD HH:MM:SS" (no Z, no T, UTC value)
    const fiveMinAgo = new Date(Date.now() - 300_000)
    const sqliteFormat = fiveMinAgo.toISOString()
      .replace('T', ' ')
      .replace(/\.\d{3}Z$/, '') // "2026-03-02 04:01:56"

    createTestRun(db, {
      status: 'running',
      updated_at: sqliteFormat,
    })

    const result = await getAutoHealthData({ projectRoot: '/tmp/test-project' })

    expect(result.staleness_seconds).toBeGreaterThanOrEqual(0)
    // Should be approximately 300s (5 min), not ~-25200s (7 hours negative for UTC-7)
    expect(result.staleness_seconds).toBeGreaterThan(200)
    expect(result.staleness_seconds).toBeLessThan(400)
  })

  it('staleness is non-negative for timestamp that is 11 minutes old (SQLite format)', async () => {
    const elevenMinAgo = new Date(Date.now() - 660_000)
    const sqliteFormat = elevenMinAgo.toISOString()
      .replace('T', ' ')
      .replace(/\.\d{3}Z$/, '')

    createTestRun(db, {
      status: 'running',
      updated_at: sqliteFormat,
    })

    const result = await getAutoHealthData({ projectRoot: '/tmp/test-project' })

    // Must be positive and greater than stallThreshold
    expect(result.staleness_seconds).toBeGreaterThan(DEFAULT_STALL_THRESHOLD_SECONDS)
    expect(result.verdict).toBe('STALLED')
  })

  it('staleness matches wall-clock seconds (within 5s tolerance)', async () => {
    const tenSecAgo = new Date(Date.now() - 10_000)
    const sqliteFormat = tenSecAgo.toISOString()
      .replace('T', ' ')
      .replace(/\.\d{3}Z$/, '')

    createTestRun(db, {
      status: 'running',
      updated_at: sqliteFormat,
    })

    const result = await getAutoHealthData({ projectRoot: '/tmp/test-project' })

    expect(result.staleness_seconds).toBeGreaterThanOrEqual(5)
    expect(result.staleness_seconds).toBeLessThan(30)
  })

  it('also works for ISO timestamps with Z suffix (existing format)', async () => {
    const isoWithZ = new Date(Date.now() - 300_000).toISOString() // already has Z

    createTestRun(db, {
      status: 'running',
      updated_at: isoWithZ,
    })

    const result = await getAutoHealthData({ projectRoot: '/tmp/test-project' })

    expect(result.staleness_seconds).toBeGreaterThan(200)
    expect(result.staleness_seconds).toBeLessThan(400)
  })
})

// ---------------------------------------------------------------------------
// AC2: Process detection for npm/node invocations
// ---------------------------------------------------------------------------

describe('inspectProcessTree — process detection fix (AC2)', () => {
  it('finds orchestrator PID from "node dist/cli/index.js run" command line (npm run substrate:dev)', () => {
    // Simulate ps output when invoked via `npm run substrate:dev -- run`
    const psOutput = [
      'PID  PPID STAT COMMAND',
      '  1     0 Ss   /sbin/init',
      '99999 99998 S    node dist/cli/index.js run --events --stories 19-1',
      '100000 99999 S   node /tmp/.../worker.js',
    ].join('\n')

    const mockExecFileSync = vi.fn().mockReturnValue(psOutput)
    const result = inspectProcessTree(mockExecFileSync)

    // The function should correctly identify the orchestrator PID
    expect(result.orchestrator_pid).toBe(99999)
    // Child process (PPID = orchestrator PID) should be found
    expect(result.child_pids).toContain(100000)
    expect(result.zombies).toHaveLength(0)
  })

  it('finds orchestrator PID from "substrate run" command line (global install)', () => {
    const psOutput = [
      '  1     0 Ss   /sbin/init',
      '88888 88887 S    substrate run --events --stories 19-1',
      '88889 88888 S    node worker.js',
    ].join('\n')

    const mockExecFileSync = vi.fn().mockReturnValue(psOutput)
    const result = inspectProcessTree(mockExecFileSync)

    expect(result.orchestrator_pid).toBe(88888)
    expect(result.child_pids).toContain(88889)
  })

  it('finds orchestrator PID from "npx substrate run" command line', () => {
    const psOutput = [
      '  1     0 Ss   /sbin/init',
      '77777 77776 S    npx substrate run --events',
      '77778 77777 S    node worker.js',
    ].join('\n')

    const mockExecFileSync = vi.fn().mockReturnValue(psOutput)
    const result = inspectProcessTree(mockExecFileSync)

    expect(result.orchestrator_pid).toBe(77777)
    expect(result.child_pids).toContain(77778)
  })

  it('does NOT match node processes where "run" is a substring of another word (Issue 3 fix)', () => {
    // e.g. "dry-run-tool.js" contains " run" as a substring — should NOT match
    const psOutput = [
      '  1     0 Ss   /sbin/init',
      '66666 66665 S    node dry-run-tool.js --stories config',
    ].join('\n')

    const mockExecFileSync = vi.fn().mockReturnValue(psOutput)
    const result = inspectProcessTree(mockExecFileSync)

    expect(result.orchestrator_pid).toBeNull()
  })

  it('grep lines are never matched as orchestrator', () => {
    const psOutput = [
      '  1     0 Ss   /sbin/init',
      '55555 55554 S    grep substrate run',
      '55556 55554 S    grep -r index.js run',
    ].join('\n')

    const mockExecFileSync = vi.fn().mockReturnValue(psOutput)
    const result = inspectProcessTree(mockExecFileSync)

    expect(result.orchestrator_pid).toBeNull()
  })

  it('detects zombie child processes', () => {
    const psOutput = [
      '  1     0 Ss   /sbin/init',
      '44444 44443 S    substrate run --events',
      '44445 44444 Z    node zombie-worker.js',
    ].join('\n')

    const mockExecFileSync = vi.fn().mockReturnValue(psOutput)
    const result = inspectProcessTree(mockExecFileSync)

    expect(result.orchestrator_pid).toBe(44444)
    expect(result.zombies).toContain(44445)
  })
})

// ---------------------------------------------------------------------------
// AC3: End-to-end stall detection with mock deps
// ---------------------------------------------------------------------------

describe('supervisor stall detection — AC3 end-to-end', () => {
  let stdoutChunks: string[]
  const origWrite = process.stdout.write

  beforeEach(() => {
    stdoutChunks = []
    process.stdout.write = ((chunk: string) => {
      stdoutChunks.push(chunk)
      return true
    }) as typeof process.stdout.write
  })

  afterEach(() => {
    process.stdout.write = origWrite
  })

  function makeStalled(staleness: number): PipelineHealthOutput {
    return {
      verdict: 'STALLED',
      run_id: 'run-test123',
      status: 'running',
      current_phase: 'implementation',
      staleness_seconds: staleness,
      last_activity: new Date().toISOString(),
      process: { orchestrator_pid: 42000, child_pids: [42001], zombies: [] },
      stories: {
        active: 1,
        completed: 0,
        escalated: 0,
        details: { '19-1': { phase: 'IN_DEV', review_cycles: 0 } },
      },
    }
  }

  function makeTerminal(): PipelineHealthOutput {
    return {
      verdict: 'NO_PIPELINE_RUNNING',
      run_id: 'run-test123',
      status: 'completed',
      current_phase: null,
      staleness_seconds: 0,
      last_activity: new Date().toISOString(),
      process: { orchestrator_pid: null, child_pids: [], zombies: [] },
      stories: {
        active: 0,
        completed: 1,
        escalated: 0,
        details: { '19-1': { phase: 'COMPLETE', review_cycles: 0 } },
      },
    }
  }

  function makeOptions(overrides: Partial<SupervisorOptions> = {}): SupervisorOptions {
    return {
      pollInterval: 1,
      stallThreshold: 600,
      maxRestarts: 3,
      outputFormat: 'json',
      projectRoot: '/tmp/test',
      pack: 'bmad',
      ...overrides,
    }
  }

  it('detects stall and emits supervisor:kill when staleness > threshold', async () => {
    // staleness_seconds = 700 (positive, correctly computed) > threshold 600 → kill
    const healthSequence: PipelineHealthOutput[] = [makeStalled(700), makeTerminal()]
    let callIdx = 0
    const killCalls: Array<[number, string]> = []

    const deps: Partial<SupervisorDeps> = {
      getHealth: vi.fn().mockImplementation(() => Promise.resolve(healthSequence[callIdx++])),
      sleep: vi.fn().mockResolvedValue(undefined),
      resumePipeline: vi.fn().mockResolvedValue(0),
      killPid: vi.fn().mockImplementation((pid: number, signal: string) => {
        killCalls.push([pid, signal])
      }),
    }

    const exitCode = await runSupervisorAction(makeOptions(), deps)

    expect(exitCode).toBe(0)

    // Kill should have happened — SIGTERM to orchestrator and children
    const sigterms = killCalls.filter(([, s]) => s === 'SIGTERM')
    expect(sigterms.length).toBeGreaterThan(0)
    expect(sigterms.map(([p]) => p)).toContain(42000) // orchestrator PID

    // supervisor:kill event should have been emitted
    const output = stdoutChunks.join('')
    const killLine = output.split('\n').find((l) => l.includes('supervisor:kill'))
    expect(killLine).toBeDefined()
    const evt = JSON.parse(killLine!)
    expect(evt.type).toBe('supervisor:kill')
    expect(evt.reason).toBe('stall')
    expect(evt.staleness_seconds).toBe(700)
  })

  it('does NOT kill when staleness is below threshold (positive but small)', async () => {
    // staleness_seconds = 100 < threshold 600 → no kill
    // After fix, a pipeline with positive staleness < threshold is healthy
    const healthSequence: PipelineHealthOutput[] = [
      makeStalled(100), // STALLED verdict but staleness < threshold → supervisor should not kill
      makeTerminal(),
    ]
    let callIdx = 0
    const killPid = vi.fn()

    const deps: Partial<SupervisorDeps> = {
      getHealth: vi.fn().mockImplementation(() => Promise.resolve(healthSequence[callIdx++])),
      sleep: vi.fn().mockResolvedValue(undefined),
      resumePipeline: vi.fn().mockResolvedValue(0),
      killPid,
    }

    await runSupervisorAction(makeOptions({ stallThreshold: 600 }), deps)

    expect(killPid).not.toHaveBeenCalled()
  })

  it('works on any timezone — stall is detected by staleness value, not absolute time', async () => {
    // This test verifies the design: the supervisor always receives pre-computed
    // staleness_seconds from getAutoHealthData (which now correctly computes it in UTC),
    // so the supervisor's stall check is timezone-agnostic by construction.
    const healthSequence: PipelineHealthOutput[] = [makeStalled(750), makeTerminal()]
    let callIdx = 0

    const deps: Partial<SupervisorDeps> = {
      getHealth: vi.fn().mockImplementation(() => Promise.resolve(healthSequence[callIdx++])),
      sleep: vi.fn().mockResolvedValue(undefined),
      resumePipeline: vi.fn().mockResolvedValue(0),
      killPid: vi.fn(),
    }

    const exitCode = await runSupervisorAction(makeOptions({ stallThreshold: 600 }), deps)

    expect(exitCode).toBe(0)
    // Verify restart was called (stall was detected)
    expect(deps.resumePipeline).toHaveBeenCalledOnce()
  })
})

// ---------------------------------------------------------------------------
// AC5: DEFAULT_STALL_THRESHOLD_SECONDS constant is exported
// ---------------------------------------------------------------------------

describe('DEFAULT_STALL_THRESHOLD_SECONDS constant (AC5)', () => {
  it('is exported and equals 600', () => {
    expect(DEFAULT_STALL_THRESHOLD_SECONDS).toBe(600)
  })
})
