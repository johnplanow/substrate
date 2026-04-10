/**
 * Unit tests for factory-queries.ts — verifies all query functions against
 * an in-memory adapter with factorySchema initialized.
 *
 * Story 46-3: Score Persistence to Database.
 * AC: #1, #2, #3, #4, #7
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createDatabaseAdapter } from '@substrate-ai/core'
import type { DatabaseAdapter } from '@substrate-ai/core'
import { factorySchema } from '../factory-schema.js'
import {
  upsertGraphRun,
  insertGraphNodeResult,
  insertScenarioResult,
  getScenarioResultsForRun,
  listGraphRuns,
} from '../factory-queries.js'
import { parseGraph } from '../../graph/parser.js'
import { createGraphExecutor } from '../../graph/executor.js'
import { makeTmpDir, cleanDir, makeMockRegistry } from '../../__tests__/integration/helpers.js'

// ---------------------------------------------------------------------------
// Test setup
// ---------------------------------------------------------------------------

let adapter: DatabaseAdapter

beforeEach(async () => {
  adapter = createDatabaseAdapter({ backend: 'memory' })
  await factorySchema(adapter)
})

// Helper: insert a parent graph_runs row before child inserts (FK constraint)
async function insertParentRun(id: string, startedAt?: string): Promise<void> {
  await upsertGraphRun(adapter, {
    id,
    graph_file: 'pipeline.dot',
    graph_goal: 'Test goal',
    status: 'running',
    started_at: startedAt ?? new Date().toISOString(),
  })
}

// ---------------------------------------------------------------------------
// upsertGraphRun
// ---------------------------------------------------------------------------

describe('upsertGraphRun', () => {
  it('first call inserts a row with status running', async () => {
    const started = new Date().toISOString()
    await upsertGraphRun(adapter, {
      id: 'run-1',
      graph_file: 'pipeline.dot',
      status: 'running',
      started_at: started,
    })

    const rows = await adapter.query<{ id: string; status: string }>(
      'SELECT id, status FROM graph_runs WHERE id = ?',
      ['run-1']
    )
    expect(rows).toHaveLength(1)
    expect(rows[0]!.id).toBe('run-1')
    expect(rows[0]!.status).toBe('running')
  })

  it('second call with same id replaces the row with updated status and final_outcome', async () => {
    const started = new Date().toISOString()
    // First call: insert running row
    await upsertGraphRun(adapter, {
      id: 'run-2',
      graph_file: 'pipeline.dot',
      status: 'running',
      started_at: started,
    })

    // Second call: update to completed
    const completed = new Date().toISOString()
    await upsertGraphRun(adapter, {
      id: 'run-2',
      graph_file: 'pipeline.dot',
      status: 'completed',
      started_at: started,
      completed_at: completed,
      final_outcome: 'SUCCESS',
      total_cost_usd: 1.23,
    })

    const rows = await adapter.query<{
      id: string
      status: string
      final_outcome: string
      total_cost_usd: number
    }>('SELECT id, status, final_outcome, total_cost_usd FROM graph_runs WHERE id = ?', ['run-2'])

    expect(rows).toHaveLength(1)
    expect(rows[0]!.status).toBe('completed')
    expect(rows[0]!.final_outcome).toBe('SUCCESS')
    expect(rows[0]!.total_cost_usd).toBe(1.23)
  })

  it('stores all optional fields (graph_goal, node_count, checkpoint_path)', async () => {
    await upsertGraphRun(adapter, {
      id: 'run-3',
      graph_file: 'factory.dot',
      graph_goal: 'Build feature X',
      status: 'running',
      started_at: new Date().toISOString(),
      node_count: 5,
      checkpoint_path: '/tmp/checkpoint.json',
    })

    const rows = await adapter.query<{
      graph_goal: string
      node_count: number
      checkpoint_path: string
    }>('SELECT graph_goal, node_count, checkpoint_path FROM graph_runs WHERE id = ?', ['run-3'])

    expect(rows[0]!.graph_goal).toBe('Build feature X')
    expect(rows[0]!.node_count).toBe(5)
    expect(rows[0]!.checkpoint_path).toBe('/tmp/checkpoint.json')
  })
})

// ---------------------------------------------------------------------------
// insertScenarioResult + getScenarioResultsForRun (AC1, AC2)
// ---------------------------------------------------------------------------

describe('insertScenarioResult', () => {
  it('inserts a row with all required fields populated (AC1)', async () => {
    await insertParentRun('run-s1')
    const executedAt = new Date().toISOString()
    await insertScenarioResult(adapter, {
      run_id: 'run-s1',
      node_id: 'scenario-node',
      iteration: 1,
      total_scenarios: 20,
      passed: 17,
      failed: 3,
      satisfaction_score: 0.85,
      threshold: 0.8,
      passes: true,
      details: JSON.stringify({ breakdown: [] }),
      executed_at: executedAt,
    })

    const rows = await adapter.query<{
      run_id: string
      node_id: string
      iteration: number
      total_scenarios: number
      passed: number
      failed: number
      satisfaction_score: number
      threshold: number
      passes: number
      details: string
    }>('SELECT * FROM scenario_results WHERE run_id = ?', ['run-s1'])

    expect(rows).toHaveLength(1)
    const row = rows[0]!
    expect(row.run_id).toBe('run-s1')
    expect(row.node_id).toBe('scenario-node')
    expect(row.iteration).toBe(1)
    expect(row.total_scenarios).toBe(20)
    expect(row.passed).toBe(17)
    expect(row.failed).toBe(3)
    expect(row.satisfaction_score).toBe(0.85)
    expect(row.threshold).toBe(0.8)
    // passes is stored as 1 (truthy) in SQLite-like adapters
    expect(row.passes).toBeTruthy()
    expect(JSON.parse(row.details)).toEqual({ breakdown: [] })
  })

  it('details field round-trips as JSON', async () => {
    await insertParentRun('run-s2')
    const breakdown = [
      { name: 'scenario-a.sh', passed: true, weight: 1.0, contribution: 0.5 },
      { name: 'scenario-b.sh', passed: true, weight: 1.0, contribution: 0.5 },
    ]
    await insertScenarioResult(adapter, {
      run_id: 'run-s2',
      node_id: 'node-A',
      iteration: 1,
      total_scenarios: 2,
      passed: 2,
      failed: 0,
      satisfaction_score: 1.0,
      threshold: 0.8,
      passes: true,
      details: JSON.stringify(breakdown),
    })

    const rows = await adapter.query<{ details: string }>(
      'SELECT details FROM scenario_results WHERE run_id = ?',
      ['run-s2']
    )
    expect(rows).toHaveLength(1)
    expect(JSON.parse(rows[0]!.details)).toEqual(breakdown)
  })
})

describe('getScenarioResultsForRun', () => {
  it('returns rows in iteration order (AC2)', async () => {
    await insertParentRun('run-s3')

    // Insert 3 iterations out of order
    await insertScenarioResult(adapter, {
      run_id: 'run-s3',
      node_id: 'node-A',
      iteration: 3,
      total_scenarios: 20,
      passed: 18,
      failed: 2,
      satisfaction_score: 0.9,
      threshold: 0.8,
      passes: true,
    })
    await insertScenarioResult(adapter, {
      run_id: 'run-s3',
      node_id: 'node-A',
      iteration: 1,
      total_scenarios: 20,
      passed: 14,
      failed: 6,
      satisfaction_score: 0.7,
      threshold: 0.8,
      passes: false,
    })
    await insertScenarioResult(adapter, {
      run_id: 'run-s3',
      node_id: 'node-A',
      iteration: 2,
      total_scenarios: 20,
      passed: 16,
      failed: 4,
      satisfaction_score: 0.8,
      threshold: 0.8,
      passes: true,
    })

    const results = await getScenarioResultsForRun(adapter, 'run-s3')

    expect(results).toHaveLength(3)
    expect(results[0]!.iteration).toBe(1)
    expect(results[1]!.iteration).toBe(2)
    expect(results[2]!.iteration).toBe(3)
  })

  it('returns exactly N rows for N iterations and correct satisfaction_score per iteration', async () => {
    await insertParentRun('run-s4')

    for (let i = 1; i <= 3; i++) {
      await insertScenarioResult(adapter, {
        run_id: 'run-s4',
        node_id: 'scenario-node',
        iteration: i,
        total_scenarios: 10,
        passed: i * 3,
        failed: 10 - i * 3,
        satisfaction_score: i * 0.3,
        threshold: 0.8,
        passes: i * 0.3 >= 0.8,
      })
    }

    const results = await getScenarioResultsForRun(adapter, 'run-s4')
    expect(results).toHaveLength(3)
    expect(results[0]!.satisfaction_score).toBeCloseTo(0.3)
    expect(results[1]!.satisfaction_score).toBeCloseTo(0.6)
    expect(results[2]!.satisfaction_score).toBeCloseTo(0.9)
    // Only iteration 3 should pass (0.9 >= 0.8)
    expect(results[2]!.passes).toBeTruthy()
  })

  it('returns empty array when no rows exist for runId', async () => {
    const results = await getScenarioResultsForRun(adapter, 'nonexistent-run')
    expect(results).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// insertGraphNodeResult
// ---------------------------------------------------------------------------

describe('insertGraphNodeResult', () => {
  it('inserts a row with timing and cost data (AC4)', async () => {
    await insertParentRun('run-n1')

    const started = new Date().toISOString()
    const completed = new Date().toISOString()
    await insertGraphNodeResult(adapter, {
      run_id: 'run-n1',
      node_id: 'node-A',
      attempt: 1,
      status: 'SUCCESS',
      started_at: started,
      completed_at: completed,
      duration_ms: 1500,
      cost_usd: 0.05,
    })

    const rows = await adapter.query<{
      run_id: string
      node_id: string
      attempt: number
      status: string
      duration_ms: number
      cost_usd: number
    }>('SELECT * FROM graph_node_results WHERE run_id = ?', ['run-n1'])

    expect(rows).toHaveLength(1)
    const row = rows[0]!
    expect(row.run_id).toBe('run-n1')
    expect(row.node_id).toBe('node-A')
    expect(row.attempt).toBe(1)
    expect(row.status).toBe('SUCCESS')
    expect(row.duration_ms).toBe(1500)
    expect(row.cost_usd).toBe(0.05)
  })

  it('multiple rows for same run_id are all returned', async () => {
    await insertParentRun('run-n2')

    await insertGraphNodeResult(adapter, {
      run_id: 'run-n2',
      node_id: 'node-A',
      attempt: 1,
      status: 'SUCCESS',
      started_at: new Date().toISOString(),
      duration_ms: 500,
      cost_usd: 0.01,
    })
    await insertGraphNodeResult(adapter, {
      run_id: 'run-n2',
      node_id: 'node-B',
      attempt: 2,
      status: 'FAIL',
      started_at: new Date().toISOString(),
      duration_ms: 200,
      cost_usd: 0.02,
      failure_reason: 'Handler error',
    })

    const rows = await adapter.query<{ node_id: string; attempt: number }>(
      'SELECT node_id, attempt FROM graph_node_results WHERE run_id = ? ORDER BY node_id',
      ['run-n2']
    )

    expect(rows).toHaveLength(2)
    expect(rows[0]!.node_id).toBe('node-A')
    expect(rows[0]!.attempt).toBe(1)
    expect(rows[1]!.node_id).toBe('node-B')
    expect(rows[1]!.attempt).toBe(2)
  })

  it('stores failure_reason for failed nodes', async () => {
    await insertParentRun('run-n3')

    await insertGraphNodeResult(adapter, {
      run_id: 'run-n3',
      node_id: 'node-X',
      attempt: 1,
      status: 'FAIL',
      started_at: new Date().toISOString(),
      failure_reason: 'Timeout exceeded',
    })

    const rows = await adapter.query<{ failure_reason: string }>(
      'SELECT failure_reason FROM graph_node_results WHERE run_id = ?',
      ['run-n3']
    )
    expect(rows[0]!.failure_reason).toBe('Timeout exceeded')
  })
})

// ---------------------------------------------------------------------------
// listGraphRuns
// ---------------------------------------------------------------------------

describe('listGraphRuns', () => {
  it('returns rows in descending started_at order', async () => {
    // Insert three runs with distinct timestamps
    await upsertGraphRun(adapter, {
      id: 'run-l1',
      graph_file: 'a.dot',
      status: 'completed',
      started_at: '2026-01-01T10:00:00.000Z',
    })
    await upsertGraphRun(adapter, {
      id: 'run-l2',
      graph_file: 'b.dot',
      status: 'completed',
      started_at: '2026-01-03T10:00:00.000Z',
    })
    await upsertGraphRun(adapter, {
      id: 'run-l3',
      graph_file: 'c.dot',
      status: 'running',
      started_at: '2026-01-02T10:00:00.000Z',
    })

    const rows = await listGraphRuns(adapter)

    expect(rows.length).toBeGreaterThanOrEqual(3)
    // First row should be the most recent (run-l2 = 2026-01-03)
    const ids = rows.map((r) => r.id)
    expect(ids[0]).toBe('run-l2')
    expect(ids[1]).toBe('run-l3')
    expect(ids[2]).toBe('run-l1')
  })

  it('respects the limit parameter', async () => {
    for (let i = 1; i <= 5; i++) {
      await upsertGraphRun(adapter, {
        id: `run-limit-${i}`,
        graph_file: 'x.dot',
        status: 'completed',
        started_at: `2026-02-0${i}T10:00:00.000Z`,
      })
    }

    const rows = await listGraphRuns(adapter, 3)
    expect(rows).toHaveLength(3)
  })

  it('returns empty array when no runs exist', async () => {
    const rows = await listGraphRuns(adapter)
    expect(rows).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// AC5: Executor backward-compatibility — no adapter, no errors
// ---------------------------------------------------------------------------

describe('AC5: executor runs normally without adapter (backward-compatible)', () => {
  let logsRoot: string

  beforeEach(async () => {
    logsRoot = await makeTmpDir()
  })

  afterEach(async () => {
    await cleanDir(logsRoot)
  })

  it('returns SUCCESS with no adapter field in config — no persistence calls, no errors thrown', async () => {
    // Minimal graph: start → exit (no intermediate nodes)
    const dot = `
      digraph test_no_adapter {
        start [shape=Mdiamond]
        exit [shape=Msquare]
        start -> exit
      }
    `
    const graph = parseGraph(dot)
    const { registry } = makeMockRegistry()
    const executor = createGraphExecutor()

    // No adapter field — AC5 requires this to complete normally
    const outcome = await executor.run(graph, {
      runId: 'ac5-no-adapter',
      logsRoot,
      handlerRegistry: registry,
    })

    expect(outcome.status).toBe('SUCCESS')
  })
})
