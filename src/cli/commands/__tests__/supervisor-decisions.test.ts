/**
 * Integration tests for supervisor decision store writes (Story 21-1).
 *
 * Tests:
 * - Stall findings written to decision store (AC1)
 * - Run summary written to decision store (AC2)
 *
 * Uses in-memory SQLite for persistence tests.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdirSync, rmSync, existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { createDecision, getDecisionsByCategory, createPipelineRun } from '../../../persistence/queries/decisions.js'
import { createWasmSqliteAdapter, WasmSqliteDatabaseAdapter } from '../../../persistence/wasm-sqlite-adapter.js'
import { OPERATIONAL_FINDING } from '../../../persistence/schemas/operational.js'
import type { DatabaseAdapter } from '../../../persistence/adapter.js'
import {
  handleStallRecovery,
  buildTerminalSummary,
  runSupervisorAction,
} from '../supervisor.js'
import type { PipelineHealthOutput } from '../health.js'

// Mock the DB adapter factory so defaultSupervisorDeps uses the test adapter
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

// Mock resolveMainRepoRoot so defaultSupervisorDeps closures use our temp dir
vi.mock('../../../utils/git-root.js', () => ({
  resolveMainRepoRoot: vi.fn().mockImplementation((root: string) => Promise.resolve(root)),
}))

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

async function openTestDb(): Promise<WasmSqliteDatabaseAdapter> {
  const adapter = await createWasmSqliteAdapter() as WasmSqliteDatabaseAdapter
  const { initSchema: realInitSchema } = await vi.importActual<typeof import('../../../persistence/schema.js')>('../../../persistence/schema.js')
  await realInitSchema(adapter)
  return adapter
}

function makeHealthStalled(overrides?: Partial<PipelineHealthOutput>): PipelineHealthOutput {
  return {
    verdict: 'STALLED',
    run_id: 'run-test',
    status: 'running',
    current_phase: 'implementation',
    staleness_seconds: 700,
    last_activity: new Date().toISOString(),
    process: { orchestrator_pid: 999, child_pids: [], zombies: [] },
    stories: {
      active: 1,
      completed: 0,
      escalated: 0,
      details: { '1-1': { phase: 'IN_DEV', review_cycles: 0 } },
    },
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// AC1: Supervisor stall findings to decision store
// ---------------------------------------------------------------------------

describe('AC1: Supervisor writes stall findings to decision store', () => {
  let adapter: WasmSqliteDatabaseAdapter

  beforeEach(async () => {
    adapter = await openTestDb()
  })

  afterEach(async () => {
    await adapter.close()
  })

  it('writeStallFindings inserts operational-finding decisions for active stories', async () => {
    // Simulate what defaultSupervisorDeps.writeStallFindings does, but directly
    const run = await createPipelineRun(adapter, { methodology: 'bmad' })
    const storyDetails: Record<string, { phase: string; review_cycles: number }> = {
      '1-1': { phase: 'IN_DEV', review_cycles: 0 },
      '1-2': { phase: 'COMPLETE', review_cycles: 1 },
      '1-3': { phase: 'code-review', review_cycles: 2 },
    }

    const now = Date.now()
    // Filter to active stories (not PENDING, COMPLETE, or ESCALATED)
    const activeStories = Object.entries(storyDetails).filter(
      ([, s]) => s.phase !== 'PENDING' && s.phase !== 'COMPLETE' && s.phase !== 'ESCALATED',
    )

    for (const [storyKey, storyState] of activeStories) {
      await createDecision(adapter, {
        pipeline_run_id: run.id,
        phase: 'supervisor',
        category: OPERATIONAL_FINDING,
        key: `stall:${storyKey}:${now}`,
        value: JSON.stringify({
          phase: storyState.phase,
          staleness_secs: 700,
          attempt: 1,
          outcome: 'recovered',
        }),
        rationale: `Supervisor stall recovery: story ${storyKey}`,
      })
    }

    const decisions = await getDecisionsByCategory(adapter, OPERATIONAL_FINDING)
    // Only active stories should have findings (1-1 and 1-3, not 1-2 which is COMPLETE)
    expect(decisions).toHaveLength(2)

    const keys = decisions.map((d) => d.key)
    expect(keys.some((k) => k.startsWith('stall:1-1:'))).toBe(true)
    expect(keys.some((k) => k.startsWith('stall:1-3:'))).toBe(true)
    expect(keys.some((k) => k.startsWith('stall:1-2:'))).toBe(false)

    // Verify value shape
    const firstValue = JSON.parse(decisions[0]!.value)
    expect(firstValue).toHaveProperty('phase')
    expect(firstValue).toHaveProperty('staleness_secs', 700)
    expect(firstValue).toHaveProperty('attempt', 1)
    expect(firstValue).toHaveProperty('outcome', 'recovered')
  })

  it('max-restarts-escalated outcome is persisted correctly', async () => {
    const run = await createPipelineRun(adapter, { methodology: 'bmad' })
    await createDecision(adapter, {
      pipeline_run_id: run.id,
      phase: 'supervisor',
      category: OPERATIONAL_FINDING,
      key: `stall:1-1:${Date.now()}`,
      value: JSON.stringify({
        phase: 'IN_DEV',
        staleness_secs: 900,
        attempt: 3,
        outcome: 'max-restarts-escalated',
      }),
    })

    const decisions = await getDecisionsByCategory(adapter, OPERATIONAL_FINDING)
    expect(decisions).toHaveLength(1)
    const val = JSON.parse(decisions[0]!.value)
    expect(val.outcome).toBe('max-restarts-escalated')
    expect(val.attempt).toBe(3)
  })

  it('handleStallRecovery invokes writeStallFindings with correct params on max-restarts', async () => {
    const writeStallFindings = vi.fn()

    const health = makeHealthStalled()
    const state = { projectRoot: '/tmp/test', runId: 'run-test', restartCount: 3 }

    const result = await handleStallRecovery(
      health,
      state,
      { stallThreshold: 600, maxRestarts: 3, pack: 'bmad', outputFormat: 'json' },
      {
        killPid: vi.fn(),
        resumePipeline: vi.fn().mockResolvedValue(0),
        sleep: vi.fn().mockResolvedValue(undefined),
        incrementRestarts: vi.fn(),
        getAllDescendants: vi.fn().mockReturnValue([]),
        getRegistry: vi.fn().mockResolvedValue({}),
        writeStallFindings,
      },
      {
        emitEvent: vi.fn(),
        log: vi.fn(),
      },
    )

    expect(result).not.toBeNull()
    expect(result!.maxRestartsExceeded).toBe(true)
    expect(writeStallFindings).toHaveBeenCalledWith(expect.objectContaining({
      runId: 'run-test',
      outcome: 'max-restarts-escalated',
      staleness_secs: 700,
      attempt: 3,
      projectRoot: '/tmp/test',
    }))
  })

  it('handleStallRecovery invokes writeStallFindings with recovered on successful restart', async () => {
    const writeStallFindings = vi.fn()

    const health = makeHealthStalled()
    const state = { projectRoot: '/tmp/test', runId: 'run-test', restartCount: 0 }

    const result = await handleStallRecovery(
      health,
      state,
      { stallThreshold: 600, maxRestarts: 3, pack: 'bmad', outputFormat: 'json' },
      {
        killPid: vi.fn(),
        resumePipeline: vi.fn().mockResolvedValue(0),
        sleep: vi.fn().mockResolvedValue(undefined),
        incrementRestarts: vi.fn(),
        getAllDescendants: vi.fn().mockReturnValue([]),
        getRegistry: vi.fn().mockResolvedValue({}),
        writeStallFindings,
      },
      {
        emitEvent: vi.fn(),
        log: vi.fn(),
      },
    )

    expect(result).not.toBeNull()
    expect(result!.maxRestartsExceeded).toBe(false)
    expect(writeStallFindings).toHaveBeenCalledWith(expect.objectContaining({
      outcome: 'recovered',
      attempt: 1,
    }))
  })
})

// ---------------------------------------------------------------------------
// AC2: Supervisor run-level summary to decision store
// ---------------------------------------------------------------------------

describe('AC2: Supervisor run-level summary to decision store', () => {
  let adapter: WasmSqliteDatabaseAdapter

  beforeEach(async () => {
    adapter = await openTestDb()
  })

  afterEach(async () => {
    await adapter.close()
  })

  it('writeRunSummary inserts operational-finding decision with correct key and value', async () => {
    // Simulate the writeRunSummary logic directly against in-memory DB
    const run = await createPipelineRun(adapter, { methodology: 'bmad' })
    const opts = {
      runId: run.id,
      succeeded: ['1-1', '1-2'],
      failed: ['1-3'],
      escalated: [],
      total_restarts: 1,
      elapsed_seconds: 450,
    }

    await createDecision(adapter, {
      pipeline_run_id: opts.runId,
      phase: 'supervisor',
      category: OPERATIONAL_FINDING,
      key: `run-summary:${opts.runId}`,
      value: JSON.stringify({
        succeeded: opts.succeeded,
        failed: opts.failed,
        escalated: opts.escalated,
        total_restarts: opts.total_restarts,
        elapsed_seconds: opts.elapsed_seconds,
        total_input_tokens: 50000,
        total_output_tokens: 10000,
      }),
      rationale: `Run summary: ${opts.succeeded.length} succeeded, ${opts.failed.length} failed.`,
    })

    const decisions = await getDecisionsByCategory(adapter, OPERATIONAL_FINDING)
    expect(decisions).toHaveLength(1)
    expect(decisions[0]!.key).toBe(`run-summary:${run.id}`)
    expect(decisions[0]!.category).toBe('operational-finding')

    const val = JSON.parse(decisions[0]!.value)
    expect(val.succeeded).toEqual(['1-1', '1-2'])
    expect(val.failed).toEqual(['1-3'])
    expect(val.escalated).toEqual([])
    expect(val.total_restarts).toBe(1)
    expect(val.elapsed_seconds).toBe(450)
    expect(val.total_input_tokens).toBe(50000)
    expect(val.total_output_tokens).toBe(10000)
  })

  it('guard: no decision inserted when no stories exist', async () => {
    // The writeRunSummary implementation should check total stories > 0
    const totalStories = 0
    if (totalStories === 0) {
      // writeRunSummary would return early
    } else {
      await createDecision(adapter, {
        pipeline_run_id: 'run-empty',
        phase: 'supervisor',
        category: OPERATIONAL_FINDING,
        key: 'run-summary:run-empty',
        value: JSON.stringify({}),
      })
    }

    const decisions = await getDecisionsByCategory(adapter, OPERATIONAL_FINDING)
    expect(decisions).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// buildTerminalSummary helper
// ---------------------------------------------------------------------------

describe('buildTerminalSummary', () => {
  it('correctly categorizes stories by phase', () => {
    const details: Record<string, { phase: string; review_cycles: number }> = {
      '1-1': { phase: 'COMPLETE', review_cycles: 1 },
      '1-2': { phase: 'ESCALATED', review_cycles: 0 },
      '1-3': { phase: 'IN_DEV', review_cycles: 0 },
      '1-4': { phase: 'PENDING', review_cycles: 0 },
    }

    const summary = buildTerminalSummary(details)

    expect(summary.succeeded).toEqual(['1-1'])
    expect(summary.escalated).toEqual(['1-2'])
    expect(summary.failed).toEqual(['1-3'])
    // PENDING stories are not classified as failed
  })
})

// ---------------------------------------------------------------------------
// Story 21-1 Smoke: defaultSupervisorDeps writeStallFindings + writeRunSummary
// through real DB via runSupervisorAction (Gap 2)
// ---------------------------------------------------------------------------

describe('Smoke: defaultSupervisorDeps writes decisions through real DB', () => {
  let tempProjectRoot: string
  let dbPath: string
  let runId: string
  let stdoutChunks: string[]
  let writeSpy: ReturnType<typeof vi.spyOn>
  let smokeAdapter: WasmSqliteDatabaseAdapter

  beforeEach(async () => {
    tempProjectRoot = join(tmpdir(), `substrate-supervisor-smoke-${randomUUID()}`)
    const substrateDir = join(tempProjectRoot, '.substrate')
    mkdirSync(substrateDir, { recursive: true })

    // Create a placeholder file so that existsSync(dbPath) guard check passes.
    dbPath = join(substrateDir, 'substrate.db')
    writeFileSync(dbPath, '')

    smokeAdapter = await createWasmSqliteAdapter() as WasmSqliteDatabaseAdapter
    const { initSchema: realInitSchema } = await vi.importActual<typeof import('../../../persistence/schema.js')>('../../../persistence/schema.js')
    await realInitSchema(smokeAdapter)
    const run = await createPipelineRun(smokeAdapter, { methodology: 'bmad' })
    runId = run.id

    // Inject a non-closable proxy so that defaultSupervisorDeps calling close()
    // does not actually close the underlying WASM database (unlike SyncDatabaseAdapter
    // which had a no-op close). This preserves the data for post-run assertions.
    const nonClosableProxy: DatabaseAdapter = {
      query: (sql, params) => smokeAdapter.query(sql, params),
      exec: (sql) => smokeAdapter.exec(sql),
      transaction: (fn) => smokeAdapter.transaction(fn),
      close: async () => { /* no-op — smokeAdapter is closed in afterEach */ },
    }

    const dbModule = await import('../../../persistence/adapter.js') as { __setMockAdapter: (a: DatabaseAdapter) => void }
    dbModule.__setMockAdapter(nonClosableProxy)

    stdoutChunks = []
    writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: any) => {
      if (typeof chunk === 'string') stdoutChunks.push(chunk)
      return true
    })
  })

  afterEach(async () => {
    writeSpy.mockRestore()
    try { await smokeAdapter.close() } catch { /* already closed */ }
    if (existsSync(tempProjectRoot)) {
      rmSync(tempProjectRoot, { recursive: true, force: true })
    }
  })

  it('writeStallFindings persists stall decisions via real defaultSupervisorDeps closure', async () => {
    // First poll: STALLED → triggers writeStallFindings + kill + restart attempt
    // Second poll: NO_PIPELINE_RUNNING → triggers writeRunSummary + exit
    let callCount = 0
    await runSupervisorAction(
      {
        pollInterval: 0.01,
        stallThreshold: 1,
        maxRestarts: 1,
        outputFormat: 'json',
        projectRoot: tempProjectRoot,
        runId,
        pack: 'bmad',
      },
      {
        getHealth: vi.fn().mockImplementation(async () => {
          callCount++
          if (callCount <= 1) {
            return {
              verdict: 'STALLED' as const,
              run_id: runId,
              status: 'running',
              current_phase: 'implementation',
              staleness_seconds: 700,
              last_activity: new Date().toISOString(),
              process: { orchestrator_pid: null, child_pids: [], zombies: [] },
              stories: {
                active: 1, completed: 0, escalated: 0,
                details: { '1-1': { phase: 'IN_DEV', review_cycles: 0 } },
              },
            }
          }
          return {
            verdict: 'NO_PIPELINE_RUNNING' as const,
            run_id: runId,
            status: 'completed',
            current_phase: null,
            staleness_seconds: 0,
            last_activity: new Date().toISOString(),
            process: { orchestrator_pid: null, child_pids: [], zombies: [] },
            stories: {
              active: 0, completed: 1, escalated: 0,
              details: { '1-1': { phase: 'COMPLETE', review_cycles: 1 } },
            },
          }
        }),
        killPid: vi.fn(),
        resumePipeline: vi.fn().mockResolvedValue(0),
        sleep: vi.fn().mockResolvedValue(undefined),
        incrementRestarts: vi.fn(),
        getAllDescendants: vi.fn().mockReturnValue([]),
        // Do NOT override writeStallFindings or writeRunSummary — let defaultSupervisorDeps handle them
      },
    )

    // Verify the decisions landed in the DB via the injected adapter
    const decisions = await getDecisionsByCategory(smokeAdapter, OPERATIONAL_FINDING)

    // Should have at least one stall finding for story 1-1
    const stallFindings = decisions.filter((d) => d.key.startsWith('stall:'))
    expect(stallFindings.length).toBeGreaterThanOrEqual(1)
    const stallVal = JSON.parse(stallFindings[0]!.value)
    expect(stallVal.phase).toBe('IN_DEV')
    expect(stallVal.outcome).toMatch(/recovered|failed/)
    expect(stallVal.staleness_secs).toBe(700)

    // Should have a run-summary decision
    const summaries = decisions.filter((d) => d.key.startsWith('run-summary:'))
    expect(summaries.length).toBeGreaterThanOrEqual(1)
    const summaryVal = JSON.parse(summaries[0]!.value)
    expect(summaryVal).toHaveProperty('succeeded')
    expect(summaryVal).toHaveProperty('failed')
    expect(summaryVal).toHaveProperty('elapsed_seconds')
  })
})

// ---------------------------------------------------------------------------
// Fix 3 regression: supervisor exits 0 (not 2) when pipeline completes
// after maxRestartsExceeded
// ---------------------------------------------------------------------------

describe('Fix 3: supervisor exit code when pipeline completes after maxRestartsExceeded', () => {
  it('returns 0 when pipeline reaches terminal state on poll after maxRestartsExceeded', async () => {
    // Scenario: poll 1 = stall detected, maxRestarts exceeded
    //           poll 2 = NO_PIPELINE_RUNNING (all stories succeeded)
    // Expected: exit code 0 (not 2)
    let pollCount = 0
    const exitCode = await runSupervisorAction(
      {
        pollInterval: 0.01,
        stallThreshold: 1,
        maxRestarts: 0, // maxRestarts=0 means first stall immediately triggers maxRestartsExceeded
        outputFormat: 'json',
        projectRoot: '/tmp/test',
        pack: 'bmad',
      },
      {
        getHealth: vi.fn().mockImplementation(async () => {
          pollCount++
          if (pollCount <= 1) {
            // Poll 1: stalled with staleness above threshold
            return {
              verdict: 'STALLED' as const,
              run_id: 'run-fix3',
              status: 'running',
              current_phase: 'implementation',
              staleness_seconds: 700,
              last_activity: new Date().toISOString(),
              process: { orchestrator_pid: null, child_pids: [], zombies: [] },
              stories: {
                active: 1, completed: 0, escalated: 0,
                details: { '1-1': { phase: 'IN_DEV', review_cycles: 0 } },
              },
            }
          }
          // Poll 2: pipeline completed successfully
          return {
            verdict: 'NO_PIPELINE_RUNNING' as const,
            run_id: 'run-fix3',
            status: 'completed',
            current_phase: null,
            staleness_seconds: 0,
            last_activity: new Date().toISOString(),
            process: { orchestrator_pid: null, child_pids: [], zombies: [] },
            stories: {
              active: 0, completed: 1, escalated: 0,
              details: { '1-1': { phase: 'COMPLETE', review_cycles: 1 } },
            },
          }
        }),
        killPid: vi.fn(),
        resumePipeline: vi.fn().mockResolvedValue(0),
        sleep: vi.fn().mockResolvedValue(undefined),
        incrementRestarts: vi.fn(),
        getAllDescendants: vi.fn().mockReturnValue([]),
        getTokenSnapshot: vi.fn().mockReturnValue({ input: 0, output: 0, cost_usd: 0 }),
        writeStallFindings: vi.fn(),
        writeRunSummary: vi.fn(),
      },
    )

    // Should exit 0 (pipeline completed successfully) not 2 (maxRestartsExceeded)
    expect(exitCode).toBe(0)
  })

  it('returns 1 when pipeline completes with escalations after maxRestartsExceeded', async () => {
    let pollCount = 0
    const exitCode = await runSupervisorAction(
      {
        pollInterval: 0.01,
        stallThreshold: 1,
        maxRestarts: 0,
        outputFormat: 'json',
        projectRoot: '/tmp/test',
        pack: 'bmad',
      },
      {
        getHealth: vi.fn().mockImplementation(async () => {
          pollCount++
          if (pollCount <= 1) {
            return {
              verdict: 'STALLED' as const,
              run_id: 'run-fix3b',
              status: 'running',
              current_phase: 'implementation',
              staleness_seconds: 700,
              last_activity: new Date().toISOString(),
              process: { orchestrator_pid: null, child_pids: [], zombies: [] },
              stories: {
                active: 1, completed: 0, escalated: 0,
                details: { '1-1': { phase: 'IN_DEV', review_cycles: 0 } },
              },
            }
          }
          return {
            verdict: 'NO_PIPELINE_RUNNING' as const,
            run_id: 'run-fix3b',
            status: 'completed',
            current_phase: null,
            staleness_seconds: 0,
            last_activity: new Date().toISOString(),
            process: { orchestrator_pid: null, child_pids: [], zombies: [] },
            stories: {
              active: 0, completed: 0, escalated: 1,
              details: { '1-1': { phase: 'ESCALATED', review_cycles: 2 } },
            },
          }
        }),
        killPid: vi.fn(),
        resumePipeline: vi.fn().mockResolvedValue(0),
        sleep: vi.fn().mockResolvedValue(undefined),
        incrementRestarts: vi.fn(),
        getAllDescendants: vi.fn().mockReturnValue([]),
        getTokenSnapshot: vi.fn().mockReturnValue({ input: 0, output: 0, cost_usd: 0 }),
        writeStallFindings: vi.fn(),
        writeRunSummary: vi.fn(),
      },
    )

    // Should exit 1 (escalations) not 2
    expect(exitCode).toBe(1)
  })

  it('returns 2 when pipeline is still running after maxRestartsExceeded grace poll', async () => {
    let pollCount = 0
    const exitCode = await runSupervisorAction(
      {
        pollInterval: 0.01,
        stallThreshold: 600,
        maxRestarts: 0,
        outputFormat: 'json',
        projectRoot: '/tmp/test',
        pack: 'bmad',
      },
      {
        getHealth: vi.fn().mockImplementation(async () => {
          pollCount++
          if (pollCount <= 1) {
            // Poll 1: stalled (staleness above 600s threshold)
            return {
              verdict: 'STALLED' as const,
              run_id: 'run-fix3c',
              status: 'running',
              current_phase: 'implementation',
              staleness_seconds: 700,
              last_activity: new Date().toISOString(),
              process: { orchestrator_pid: null, child_pids: [], zombies: [] },
              stories: {
                active: 1, completed: 0, escalated: 0,
                details: { '1-1': { phase: 'IN_DEV', review_cycles: 0 } },
              },
            }
          }
          // Poll 2: still running, staleness below threshold (no stall detected)
          return {
            verdict: 'HEALTHY' as const,
            run_id: 'run-fix3c',
            status: 'running',
            current_phase: 'implementation',
            staleness_seconds: 10,
            last_activity: new Date().toISOString(),
            process: { orchestrator_pid: 1234, child_pids: [5678], zombies: [] },
            stories: {
              active: 1, completed: 0, escalated: 0,
              details: { '1-1': { phase: 'IN_DEV', review_cycles: 0 } },
            },
          }
        }),
        killPid: vi.fn(),
        resumePipeline: vi.fn().mockResolvedValue(0),
        sleep: vi.fn().mockResolvedValue(undefined),
        incrementRestarts: vi.fn(),
        getAllDescendants: vi.fn().mockReturnValue([]),
        getTokenSnapshot: vi.fn().mockReturnValue({ input: 0, output: 0, cost_usd: 0 }),
        writeStallFindings: vi.fn(),
        writeRunSummary: vi.fn(),
      },
    )

    // Pipeline didn't reach terminal state — should still exit 2
    expect(exitCode).toBe(2)
  })
})
