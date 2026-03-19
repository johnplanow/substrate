/**
 * Tests for Story 39-4: Fix False STALLED Verdict in Health Command
 *
 * Covers:
 *   - AC1: PID file alive + empty child_pids → HEALTHY
 *   - AC2: PID file with dead PID → STALLED
 *   - AC3: No PID file → fallback to existing heuristics
 *   - AC4: Child process count is informational (does not override live PID)
 *   - AC5: DB staleness is informational (does not override live PID)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { InMemoryDatabaseAdapter } from '../../../persistence/memory-adapter.js'
import type { DatabaseAdapter } from '../../../persistence/adapter.js'
import { createPipelineRun } from '../../../persistence/queries/decisions.js'
import type { PipelineRun } from '../../../persistence/queries/decisions.js'
import { getAutoHealthData, DEFAULT_STALL_THRESHOLD_SECONDS } from '../health.js'

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

async function createTestDb(): Promise<DatabaseAdapter> {
  const adapter = new InMemoryDatabaseAdapter()
  const { initSchema: realInitSchema } = await vi.importActual<typeof import('../../../persistence/schema.js')>('../../../persistence/schema.js')
  await realInitSchema(adapter)
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

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

vi.mock('../../../persistence/adapter.js', () => {
  let mockAdapter: DatabaseAdapter | null = null
  return {
    createDatabaseAdapter: () => mockAdapter!,
    __setMockAdapter: (a: DatabaseAdapter) => { mockAdapter = a },
  }
})

vi.mock('../../../persistence/schema.js', () => ({
  initSchema: vi.fn().mockResolvedValue(undefined),
}))

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
// AC1: PID file with alive PID + empty child_pids → HEALTHY
// ---------------------------------------------------------------------------

describe('getAutoHealthData — AC1: PID alive + empty child_pids → HEALTHY', () => {
  let adapter: DatabaseAdapter

  beforeEach(async () => {
    adapter = await createTestDb()
    const dbModule = await import('../../../persistence/adapter.js') as { __setMockAdapter: (a: DatabaseAdapter) => void }
    dbModule.__setMockAdapter(adapter)
  })

  afterEach(async () => {
    await adapter.close()
  })

  it('PID file alive + empty child_pids + active stories → HEALTHY', async () => {
    await createTestRun(adapter, {
      status: 'running',
      current_phase: 'implementation',
      token_usage_json: JSON.stringify({
        stories: { '39-4': { phase: 'IN_DEV', reviewCycles: 0 } },
      }),
      updated_at: new Date().toISOString(),
    })

    const result = await getAutoHealthData({
      projectRoot: '/tmp/test-project',
      _processInfoOverride: { orchestrator_pid: 99999, child_pids: [], zombies: [] },
    })

    expect(result.verdict).toBe('HEALTHY')
    // child_pids is informational — reported but does not influence verdict
    expect(result.process.orchestrator_pid).toBe(99999)
    expect(result.process.child_pids).toHaveLength(0)
  })

  it('PID file alive + empty child_pids + no active stories → HEALTHY', async () => {
    await createTestRun(adapter, {
      status: 'running',
      current_phase: 'implementation',
      updated_at: new Date().toISOString(),
      // no token_usage_json → active = 0
    })

    const result = await getAutoHealthData({
      projectRoot: '/tmp/test-project',
      _processInfoOverride: { orchestrator_pid: 99999, child_pids: [], zombies: [] },
    })

    expect(result.verdict).toBe('HEALTHY')
  })
})

// ---------------------------------------------------------------------------
// AC5: DB staleness does NOT override a live PID → HEALTHY
// ---------------------------------------------------------------------------

describe('getAutoHealthData — AC5: DB staleness is informational, does not override live PID', () => {
  let adapter: DatabaseAdapter

  beforeEach(async () => {
    adapter = await createTestDb()
    const dbModule = await import('../../../persistence/adapter.js') as { __setMockAdapter: (a: DatabaseAdapter) => void }
    dbModule.__setMockAdapter(adapter)
  })

  afterEach(async () => {
    await adapter.close()
  })

  it('PID file alive + stale DB (>600s) → HEALTHY', async () => {
    const staleTime = new Date(Date.now() - 700_000).toISOString() // 11+ minutes ago
    await createTestRun(adapter, {
      status: 'running',
      current_phase: 'implementation',
      updated_at: staleTime,
    })

    const result = await getAutoHealthData({
      projectRoot: '/tmp/test-project',
      _processInfoOverride: { orchestrator_pid: 99999, child_pids: [], zombies: [] },
    })

    // PID alive is authoritative — staleness does not flip it to STALLED
    expect(result.verdict).toBe('HEALTHY')
    expect(result.staleness_seconds).toBeGreaterThan(DEFAULT_STALL_THRESHOLD_SECONDS)
    // staleness is still reported (informational)
    expect(result.process.orchestrator_pid).toBe(99999)
  })

  it('PID file alive + stale DB + active stories → HEALTHY', async () => {
    const staleTime = new Date(Date.now() - 700_000).toISOString()
    await createTestRun(adapter, {
      status: 'running',
      current_phase: 'implementation',
      token_usage_json: JSON.stringify({
        stories: { '39-4': { phase: 'IN_DEV', reviewCycles: 1 } },
      }),
      updated_at: staleTime,
    })

    const result = await getAutoHealthData({
      projectRoot: '/tmp/test-project',
      _processInfoOverride: { orchestrator_pid: 12345, child_pids: [], zombies: [] },
    })

    expect(result.verdict).toBe('HEALTHY')
  })
})

// ---------------------------------------------------------------------------
// AC2: PID file with dead PID → STALLED
// ---------------------------------------------------------------------------

describe('getAutoHealthData — AC2: PID dead → STALLED', () => {
  let adapter: DatabaseAdapter

  beforeEach(async () => {
    adapter = await createTestDb()
    const dbModule = await import('../../../persistence/adapter.js') as { __setMockAdapter: (a: DatabaseAdapter) => void }
    dbModule.__setMockAdapter(adapter)
  })

  afterEach(async () => {
    await adapter.close()
  })

  it('PID file with dead PID + active stories → STALLED', async () => {
    await createTestRun(adapter, {
      status: 'running',
      current_phase: 'implementation',
      token_usage_json: JSON.stringify({
        stories: { '39-4': { phase: 'IN_DEV', reviewCycles: 0 } },
      }),
      updated_at: new Date().toISOString(), // not stale
    })

    // Simulate dead PID: orchestrator_pid = null (PID file existed but PID was dead,
    // and command-line fallback also found nothing)
    const result = await getAutoHealthData({
      projectRoot: '/tmp/test-project',
      _processInfoOverride: { orchestrator_pid: null, child_pids: [], zombies: [] },
    })

    // Process died without cleanup — active stories still in DB
    expect(result.verdict).toBe('STALLED')
  })

  it('PID file with dead PID + stale DB → STALLED', async () => {
    const staleTime = new Date(Date.now() - 700_000).toISOString()
    await createTestRun(adapter, {
      status: 'running',
      current_phase: 'implementation',
      updated_at: staleTime,
    })

    const result = await getAutoHealthData({
      projectRoot: '/tmp/test-project',
      _processInfoOverride: { orchestrator_pid: null, child_pids: [], zombies: [], pid_file_dead: true },
    })

    expect(result.verdict).toBe('STALLED')
    expect(result.staleness_seconds).toBeGreaterThan(DEFAULT_STALL_THRESHOLD_SECONDS)
  })

  it('PID file with dead PID + fresh DB + 0 active stories → STALLED (AC2, no carve-outs)', async () => {
    // This is the gap identified in code review: previously returned HEALTHY
    await createTestRun(adapter, {
      status: 'running',
      current_phase: 'implementation',
      updated_at: new Date().toISOString(), // fresh — not stale
      // no token_usage_json → active = 0
    })

    // pid_file_dead=true: PID file existed, PID was not alive in ps
    const result = await getAutoHealthData({
      projectRoot: '/tmp/test-project',
      _processInfoOverride: { orchestrator_pid: null, child_pids: [], zombies: [], pid_file_dead: true },
    })

    // AC2: PID file exists + PID NOT alive → STALLED with no carve-outs
    expect(result.verdict).toBe('STALLED')
  })
})

// ---------------------------------------------------------------------------
// AC3: No PID file → fallback to existing heuristics (staleness/story state)
// ---------------------------------------------------------------------------

describe('getAutoHealthData — AC3: No PID file falls back to existing heuristics', () => {
  let adapter: DatabaseAdapter

  beforeEach(async () => {
    adapter = await createTestDb()
    const dbModule = await import('../../../persistence/adapter.js') as { __setMockAdapter: (a: DatabaseAdapter) => void }
    dbModule.__setMockAdapter(adapter)
  })

  afterEach(async () => {
    await adapter.close()
  })

  it('no PID file + stale DB → STALLED via staleness fallback', async () => {
    const staleTime = new Date(Date.now() - 700_000).toISOString()
    await createTestRun(adapter, {
      status: 'running',
      current_phase: 'implementation',
      updated_at: staleTime,
    })

    // No _processInfoOverride — uses real inspectProcessTree which finds no process in tests
    // This exercises the fallback path (no PID file, no command-line match → staleness check)
    const result = await getAutoHealthData({ projectRoot: '/tmp/test-project' })

    expect(result.verdict).toBe('STALLED')
    expect(result.staleness_seconds).toBeGreaterThan(DEFAULT_STALL_THRESHOLD_SECONDS)
  })

  it('no PID file + terminal run status → NO_PIPELINE_RUNNING', async () => {
    await createTestRun(adapter, {
      status: 'completed',
      current_phase: 'implementation',
    })

    const result = await getAutoHealthData({ projectRoot: '/tmp/test-project' })

    expect(result.verdict).toBe('NO_PIPELINE_RUNNING')
  })
})

// ---------------------------------------------------------------------------
// AC4: Child process count is informational — does not change verdict
// ---------------------------------------------------------------------------

describe('getAutoHealthData — AC4: Child process count is informational', () => {
  let adapter: DatabaseAdapter

  beforeEach(async () => {
    adapter = await createTestDb()
    const dbModule = await import('../../../persistence/adapter.js') as { __setMockAdapter: (a: DatabaseAdapter) => void }
    dbModule.__setMockAdapter(adapter)
  })

  afterEach(async () => {
    await adapter.close()
  })

  it('orchestrator alive + child_pids empty + active stories → HEALTHY (not STALLED)', async () => {
    // This is the core bug fix: previously this case returned STALLED
    await createTestRun(adapter, {
      status: 'running',
      current_phase: 'implementation',
      token_usage_json: JSON.stringify({
        stories: {
          '39-4a': { phase: 'IN_DEV', reviewCycles: 0 },
          '39-4b': { phase: 'IN_DEV', reviewCycles: 0 },
        },
      }),
      updated_at: new Date().toISOString(),
    })

    const result = await getAutoHealthData({
      projectRoot: '/tmp/test-project',
      // Alive PID but between dispatches (no children yet)
      _processInfoOverride: { orchestrator_pid: 54321, child_pids: [], zombies: [] },
    })

    expect(result.verdict).toBe('HEALTHY')
    expect(result.stories.active).toBe(2)
  })

  it('orchestrator alive + child_pids populated → HEALTHY', async () => {
    await createTestRun(adapter, {
      status: 'running',
      current_phase: 'implementation',
      updated_at: new Date().toISOString(),
    })

    const result = await getAutoHealthData({
      projectRoot: '/tmp/test-project',
      _processInfoOverride: { orchestrator_pid: 54321, child_pids: [54322, 54323], zombies: [] },
    })

    expect(result.verdict).toBe('HEALTHY')
  })

  it('zombie children do NOT override a live orchestrator PID — verdict is HEALTHY (AC1)', async () => {
    await createTestRun(adapter, {
      status: 'running',
      current_phase: 'implementation',
      updated_at: new Date().toISOString(),
    })

    // AC1: orchestrator_pid alive → HEALTHY regardless of child process detection results,
    // which explicitly includes zombie detection. Zombie children are informational.
    const result = await getAutoHealthData({
      projectRoot: '/tmp/test-project',
      _processInfoOverride: { orchestrator_pid: 54321, child_pids: [54322], zombies: [54322] },
    })

    expect(result.verdict).toBe('HEALTHY')
  })
})
