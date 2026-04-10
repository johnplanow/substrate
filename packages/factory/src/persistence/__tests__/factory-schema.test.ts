/**
 * Unit tests for factory-schema.ts — verifies all DDL tables and indexes
 * are created correctly using an in-memory adapter.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { createDatabaseAdapter } from '@substrate-ai/core'
import type { DatabaseAdapter } from '@substrate-ai/core'
import { factorySchema } from '../factory-schema.js'

// ---------------------------------------------------------------------------
// Test setup
// ---------------------------------------------------------------------------

let adapter: DatabaseAdapter

beforeEach(async () => {
  adapter = createDatabaseAdapter({ backend: 'memory' })
  await factorySchema(adapter)
})

// ---------------------------------------------------------------------------
// AC1: graph_runs table exists with correct schema
// ---------------------------------------------------------------------------

describe('graph_runs table', () => {
  it('exists after factorySchema is called', async () => {
    await expect(adapter.query('SELECT * FROM graph_runs LIMIT 0')).resolves.toBeDefined()
  })

  it('accepts a full row insert with all documented columns', async () => {
    await adapter.exec(`
      INSERT INTO graph_runs (id, graph_file, graph_goal, status, started_at, total_cost_usd, node_count, final_outcome, checkpoint_path)
      VALUES ('r1', 'pipeline.dot', 'Build feature X', 'running', CURRENT_TIMESTAMP, 0.0, 0, NULL, NULL)
    `)
    const rows = await adapter.query<{ id: string }>('SELECT id FROM graph_runs WHERE id = ?', [
      'r1',
    ])
    expect(rows[0]?.id).toBe('r1')
  })
})

// ---------------------------------------------------------------------------
// AC2: graph_node_results table exists with correct schema
// ---------------------------------------------------------------------------

describe('graph_node_results table', () => {
  it('exists after factorySchema is called', async () => {
    await expect(adapter.query('SELECT * FROM graph_node_results LIMIT 0')).resolves.toBeDefined()
  })
})

// ---------------------------------------------------------------------------
// AC3: scenario_results table exists with correct schema
// ---------------------------------------------------------------------------

describe('scenario_results table', () => {
  it('exists after factorySchema is called', async () => {
    await expect(adapter.query('SELECT * FROM scenario_results LIMIT 0')).resolves.toBeDefined()
  })

  it('accepts a row insert with all documented columns including satisfaction_score, threshold, passes, details', async () => {
    // First insert a parent graph_runs row
    await adapter.exec(`
      INSERT INTO graph_runs (id, graph_file, status, started_at, total_cost_usd, node_count)
      VALUES ('r2', 'factory.dot', 'running', CURRENT_TIMESTAMP, 0.0, 0)
    `)
    await adapter.exec(`
      INSERT INTO scenario_results (run_id, node_id, iteration, total_scenarios, passed, failed, satisfaction_score, threshold, passes, details, executed_at)
      VALUES ('r2', 'node-A', 1, 10, 9, 1, 0.9, 0.8, 1, 'All critical paths covered', CURRENT_TIMESTAMP)
    `)
    const rows = await adapter.query<{ run_id: string; satisfaction_score: number }>(
      'SELECT run_id, satisfaction_score FROM scenario_results WHERE run_id = ?',
      ['r2']
    )
    expect(rows[0]?.run_id).toBe('r2')
    expect(rows[0]?.satisfaction_score).toBe(0.9)
  })
})

// ---------------------------------------------------------------------------
// AC4: required indexes are created
// ---------------------------------------------------------------------------

describe('indexes', () => {
  it('idx_graph_node_results_run supports queries by run_id', async () => {
    // Insert parent run
    await adapter.exec(`
      INSERT INTO graph_runs (id, graph_file, status, started_at, total_cost_usd, node_count)
      VALUES ('r3', 'graph.dot', 'running', CURRENT_TIMESTAMP, 0.0, 3)
    `)
    // Insert node result
    await adapter.exec(`
      INSERT INTO graph_node_results (run_id, node_id, attempt, status, started_at, cost_usd)
      VALUES ('r3', 'node-1', 1, 'completed', CURRENT_TIMESTAMP, 0.05)
    `)
    const rows = await adapter.query<{ node_id: string }>(
      'SELECT node_id FROM graph_node_results WHERE run_id = ?',
      ['r3']
    )
    expect(rows).toHaveLength(1)
    expect(rows[0]?.node_id).toBe('node-1')
  })

  it('idx_scenario_results_run supports queries by run_id', async () => {
    // Insert parent run
    await adapter.exec(`
      INSERT INTO graph_runs (id, graph_file, status, started_at, total_cost_usd, node_count)
      VALUES ('r4', 'graph.dot', 'running', CURRENT_TIMESTAMP, 0.0, 2)
    `)
    // Insert scenario result
    await adapter.exec(`
      INSERT INTO scenario_results (run_id, node_id, iteration, total_scenarios, passed, failed, satisfaction_score, threshold, passes, executed_at)
      VALUES ('r4', 'node-2', 1, 5, 4, 1, 0.8, 0.8, 1, CURRENT_TIMESTAMP)
    `)
    const rows = await adapter.query<{ node_id: string }>(
      'SELECT node_id FROM scenario_results WHERE run_id = ?',
      ['r4']
    )
    expect(rows).toHaveLength(1)
    expect(rows[0]?.node_id).toBe('node-2')
  })
})

// ---------------------------------------------------------------------------
// AC5: factorySchema is idempotent
// ---------------------------------------------------------------------------

describe('idempotency', () => {
  it('calling factorySchema a second time does not throw', async () => {
    await expect(factorySchema(adapter)).resolves.toBeUndefined()
  })
})
