/**
 * Integration tests: Database persistence (Story 44-10 AC4).
 *
 * Verifies that scenario_results rows are persisted correctly after each
 * validation node execution, using an in-memory DatabaseAdapter.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { createDatabaseAdapter } from '@substrate-ai/core'
import type { DatabaseAdapter } from '@substrate-ai/core'
import { factorySchema } from '../../persistence/factory-schema.js'
import { computeSatisfactionScore } from '../../scenarios/scorer.js'
import { buildScenarioRunResult } from './helpers.js'

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

let adapter: DatabaseAdapter

beforeEach(async () => {
  adapter = createDatabaseAdapter({ backend: 'memory' })
  await factorySchema(adapter)
  // Insert a parent graph_runs row (required by foreign key constraint)
  await adapter.exec(`
    INSERT INTO graph_runs (id, graph_file, status, started_at, total_cost_usd, node_count)
    VALUES ('test-run-1', 'pipeline.dot', 'running', CURRENT_TIMESTAMP, 0.0, 5)
  `)
})

// ---------------------------------------------------------------------------
// AC4: scenario_results persistence
// ---------------------------------------------------------------------------

describe('scenario_results persistence (AC4)', () => {
  it('AC4a: row inserted for iteration 1 (2/3 pass) is queryable with correct columns', async () => {
    const result = buildScenarioRunResult(2, 3)
    const score = computeSatisfactionScore(result)

    await adapter.exec(`
      INSERT INTO scenario_results
        (run_id, node_id, iteration, total_scenarios, passed, failed,
         satisfaction_score, threshold, passes, executed_at)
      VALUES ('test-run-1', 'validate', 1, 3, 2, 1, ${score.score}, ${score.threshold}, ${score.passes ? 1 : 0}, CURRENT_TIMESTAMP)
    `)

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
    }>('SELECT * FROM scenario_results WHERE run_id = ?', ['test-run-1'])

    expect(rows).toHaveLength(1)
    expect(rows[0]?.passed).toBe(2)
    expect(rows[0]?.failed).toBe(1)
    expect(rows[0]?.total_scenarios).toBe(3)
    expect(rows[0]?.satisfaction_score).toBeCloseTo(2 / 3, 5)
    expect(rows[0]?.passes).toBe(0) // 0.667 < 0.8 → false (stored as 0)
  })

  it('AC4b: iteration 2 row (3/3 pass) has satisfaction_score = 1.0 and passes = 1', async () => {
    const result2 = buildScenarioRunResult(3, 3)
    const score2 = computeSatisfactionScore(result2)

    await adapter.exec(`
      INSERT INTO scenario_results
        (run_id, node_id, iteration, total_scenarios, passed, failed,
         satisfaction_score, threshold, passes, executed_at)
      VALUES ('test-run-1', 'validate', 2, 3, 3, 0, ${score2.score}, ${score2.threshold}, ${score2.passes ? 1 : 0}, CURRENT_TIMESTAMP)
    `)

    const rows = await adapter.query<{
      satisfaction_score: number
      passes: number
    }>('SELECT satisfaction_score, passes FROM scenario_results WHERE run_id = ?', ['test-run-1'])

    expect(rows[0]?.satisfaction_score).toBe(1.0)
    expect(rows[0]?.passes).toBe(1)
  })

  it('AC4c: two iterations inserted and queried in order', async () => {
    const result1 = buildScenarioRunResult(2, 3)
    const score1 = computeSatisfactionScore(result1)
    const result2 = buildScenarioRunResult(3, 3)
    const score2 = computeSatisfactionScore(result2)

    await adapter.exec(`
      INSERT INTO scenario_results
        (run_id, node_id, iteration, total_scenarios, passed, failed,
         satisfaction_score, threshold, passes, executed_at)
      VALUES ('test-run-1', 'validate', 1, 3, 2, 1, ${score1.score}, ${score1.threshold}, ${score1.passes ? 1 : 0}, CURRENT_TIMESTAMP)
    `)
    await adapter.exec(`
      INSERT INTO scenario_results
        (run_id, node_id, iteration, total_scenarios, passed, failed,
         satisfaction_score, threshold, passes, executed_at)
      VALUES ('test-run-1', 'validate', 2, 3, 3, 0, ${score2.score}, ${score2.threshold}, ${score2.passes ? 1 : 0}, CURRENT_TIMESTAMP)
    `)

    const rows = await adapter.query<{ iteration: number }>(
      'SELECT iteration FROM scenario_results WHERE run_id = ? ORDER BY iteration',
      ['test-run-1'],
    )

    expect(rows).toHaveLength(2)
    expect(rows[0]?.iteration).toBe(1)
    expect(rows[1]?.iteration).toBe(2)
  })

  it('AC4d: node_id column is stored and queryable', async () => {
    const result = buildScenarioRunResult(2, 3)
    const score = computeSatisfactionScore(result)

    await adapter.exec(`
      INSERT INTO scenario_results
        (run_id, node_id, iteration, total_scenarios, passed, failed,
         satisfaction_score, threshold, passes, executed_at)
      VALUES ('test-run-1', 'validate', 1, 3, 2, 1, ${score.score}, ${score.threshold}, 0, CURRENT_TIMESTAMP)
    `)

    const rows = await adapter.query<{ node_id: string }>(
      'SELECT node_id FROM scenario_results WHERE run_id = ?',
      ['test-run-1'],
    )

    expect(rows[0]?.node_id).toBe('validate')
  })

  it('AC4e: threshold defaults to 0.8 when not explicitly overridden', async () => {
    // Insert without specifying threshold — column DEFAULT is 0.8
    await adapter.exec(`
      INSERT INTO scenario_results
        (run_id, node_id, iteration, total_scenarios, passed, failed,
         satisfaction_score, passes, executed_at)
      VALUES ('test-run-1', 'validate', 1, 3, 2, 1, 0.667, 0, CURRENT_TIMESTAMP)
    `)

    const rows = await adapter.query<{ threshold: number }>(
      'SELECT threshold FROM scenario_results WHERE run_id = ?',
      ['test-run-1'],
    )

    expect(rows[0]?.threshold).toBe(0.8)
  })

  it('AC4f: details column accepts NULL (omitted on insert)', async () => {
    const result = buildScenarioRunResult(2, 3)
    const score = computeSatisfactionScore(result)

    await adapter.exec(`
      INSERT INTO scenario_results
        (run_id, node_id, iteration, total_scenarios, passed, failed,
         satisfaction_score, passes, executed_at)
      VALUES ('test-run-1', 'validate', 1, 3, 2, 1, ${score.score}, 0, CURRENT_TIMESTAMP)
    `)

    const rows = await adapter.query<{ details: string | null }>(
      'SELECT details FROM scenario_results WHERE run_id = ?',
      ['test-run-1'],
    )

    // details should be null when omitted
    expect(rows[0]?.details == null).toBe(true)
  })

  it('AC4f-json: details column accepts a JSON string when provided', async () => {
    const detailsJson = JSON.stringify({ note: 'all critical paths covered' })

    await adapter.exec(`
      INSERT INTO scenario_results
        (run_id, node_id, iteration, total_scenarios, passed, failed,
         satisfaction_score, passes, details, executed_at)
      VALUES ('test-run-1', 'validate', 1, 3, 3, 0, 1.0, 1, '${detailsJson}', CURRENT_TIMESTAMP)
    `)

    const rows = await adapter.query<{ details: string }>(
      'SELECT details FROM scenario_results WHERE run_id = ?',
      ['test-run-1'],
    )

    expect(rows[0]?.details).toBe(detailsJson)
  })
})
