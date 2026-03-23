/**
 * Factory persistence query functions for graph runs, node results, and scenario results.
 *
 * All functions accept a DatabaseAdapter as first argument, follow the established
 * pattern from @substrate-ai/core's metrics queries, and use portable SQL patterns
 * (select-then-delete-then-insert in transactions) compatible with both
 * InMemoryDatabaseAdapter and DoltDatabaseAdapter.
 *
 * Story 46-3: Score Persistence to Database.
 */

import type { DatabaseAdapter } from '@substrate-ai/core'

// ---------------------------------------------------------------------------
// GraphRun types
// ---------------------------------------------------------------------------

export interface GraphRunInput {
  /** Unique run identifier */
  id: string
  /** Path to the DOT graph file */
  graph_file: string
  /** Run goal/objective (optional) */
  graph_goal?: string
  /** Run status: 'running' | 'completed' | 'failed' */
  status: string
  /** ISO timestamp when the run started */
  started_at: string
  /** ISO timestamp when the run completed (optional) */
  completed_at?: string
  /** Total cost in USD (optional) */
  total_cost_usd?: number
  /** Number of nodes in the graph */
  node_count?: number
  /** Final outcome string (optional) */
  final_outcome?: string
  /** Path to checkpoint file (optional) */
  checkpoint_path?: string
}

export interface GraphRunRow {
  id: string
  graph_file: string
  /** Nullable in DB — undefined when column was NULL */
  graph_goal: string | null
  status: string
  started_at: string
  /** Nullable in DB — null until the run completes */
  completed_at: string | null
  total_cost_usd: number
  node_count: number
  /** Nullable in DB — null until the run terminates */
  final_outcome: string | null
  /** Nullable in DB — null when no checkpoint was used */
  checkpoint_path: string | null
}

// ---------------------------------------------------------------------------
// GraphNodeResult types
// ---------------------------------------------------------------------------

export interface GraphNodeResultInput {
  /** Parent run identifier */
  run_id: string
  /** Node identifier */
  node_id: string
  /** Attempt number (1-indexed) */
  attempt: number
  /** Node execution status */
  status: string
  /** ISO timestamp when node started */
  started_at: string
  /** ISO timestamp when node completed (optional) */
  completed_at?: string
  /** Execution duration in milliseconds (optional) */
  duration_ms?: number
  /** Cost in USD for this node (optional, default 0) */
  cost_usd?: number
  /** Failure reason if status is FAIL (optional) */
  failure_reason?: string
  /** JSON snapshot of context at completion (optional) */
  context_snapshot?: string
}

export interface GraphNodeResultRow {
  /** Auto-generated row id */
  id: number
  run_id: string
  node_id: string
  attempt: number
  status: string
  started_at: string
  /** Nullable in DB — null if node was interrupted */
  completed_at: string | null
  /** Nullable in DB — null if not recorded */
  duration_ms: number | null
  cost_usd: number
  /** Nullable in DB — null when node succeeded */
  failure_reason: string | null
  /** Nullable in DB — null when not captured */
  context_snapshot: string | null
}

// ---------------------------------------------------------------------------
// ScenarioResult types
// ---------------------------------------------------------------------------

export interface ScenarioResultInput {
  /** Parent run identifier */
  run_id: string
  /** Node identifier that triggered the scenario run */
  node_id: string
  /** Convergence iteration number */
  iteration: number
  /** Total number of scenarios */
  total_scenarios: number
  /** Number of scenarios that passed */
  passed: number
  /** Number of scenarios that failed */
  failed: number
  /** Satisfaction score (0.0 – 1.0) */
  satisfaction_score: number
  /** Minimum threshold for passing */
  threshold: number
  /** Whether satisfaction_score >= threshold */
  passes: boolean
  /** JSON-serialized score breakdown (optional) */
  details?: string
  /** ISO timestamp when scenarios were executed (optional) */
  executed_at?: string
}

export interface ScenarioResultRow {
  /** Auto-generated row id */
  id: number
  run_id: string
  node_id: string
  iteration: number
  total_scenarios: number
  passed: number
  failed: number
  satisfaction_score: number
  threshold: number
  passes: boolean
  /** Nullable in DB — null when no breakdown details were recorded */
  details: string | null
  executed_at: string
}

// ---------------------------------------------------------------------------
// upsertGraphRun
// ---------------------------------------------------------------------------

/**
 * Insert or replace a graph_runs row.
 *
 * Uses portable select-then-delete-then-insert pattern inside a transaction
 * (not INSERT OR REPLACE which is SQLite-specific).
 *
 * - First call (status: 'running'): inserts the row.
 * - Second call (status: 'completed'/'failed'): deletes the old row and inserts
 *   the updated row with completion details.
 */
export async function upsertGraphRun(
  adapter: DatabaseAdapter,
  input: GraphRunInput,
): Promise<void> {
  await adapter.transaction(async (tx) => {
    const existing = await tx.query<{ id: string }>(
      'SELECT id FROM graph_runs WHERE id = ?',
      [input.id],
    )
    if (existing.length > 0) {
      await tx.query('DELETE FROM graph_runs WHERE id = ?', [input.id])
    }
    await tx.query(
      `INSERT INTO graph_runs (
        id, graph_file, graph_goal, status, started_at, completed_at,
        total_cost_usd, node_count, final_outcome, checkpoint_path
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        input.id,
        input.graph_file,
        input.graph_goal ?? null,
        input.status,
        input.started_at,
        input.completed_at ?? null,
        input.total_cost_usd ?? 0,
        input.node_count ?? 0,
        input.final_outcome ?? null,
        input.checkpoint_path ?? null,
      ],
    )
  })
}

// ---------------------------------------------------------------------------
// insertGraphNodeResult
// ---------------------------------------------------------------------------

/**
 * Append a graph_node_results row for a single node execution attempt.
 *
 * Each attempt is a distinct row — no upsert needed since run_id + node_id + attempt
 * together uniquely identify each record.
 */
export async function insertGraphNodeResult(
  adapter: DatabaseAdapter,
  input: GraphNodeResultInput,
): Promise<void> {
  await adapter.transaction(async (tx) => {
    await tx.query(
      `INSERT INTO graph_node_results (
        run_id, node_id, attempt, status, started_at, completed_at,
        duration_ms, cost_usd, failure_reason, context_snapshot
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        input.run_id,
        input.node_id,
        input.attempt,
        input.status,
        input.started_at,
        input.completed_at ?? null,
        input.duration_ms ?? null,
        input.cost_usd ?? 0,
        input.failure_reason ?? null,
        input.context_snapshot ?? null,
      ],
    )
  })
}

// ---------------------------------------------------------------------------
// insertScenarioResult
// ---------------------------------------------------------------------------

/**
 * Append a scenario_results row for a single scenario run iteration.
 *
 * The `details` field (score breakdown) should be serialized as JSON string
 * before calling this function, or passed raw if already serialized.
 */
export async function insertScenarioResult(
  adapter: DatabaseAdapter,
  input: ScenarioResultInput,
): Promise<void> {
  await adapter.transaction(async (tx) => {
    await tx.query(
      `INSERT INTO scenario_results (
        run_id, node_id, iteration, total_scenarios, passed, failed,
        satisfaction_score, threshold, passes, details, executed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        input.run_id,
        input.node_id,
        input.iteration,
        input.total_scenarios,
        input.passed,
        input.failed,
        input.satisfaction_score,
        input.threshold,
        input.passes ? 1 : 0,
        input.details ?? null,
        input.executed_at ?? new Date().toISOString(),
      ],
    )
  })
}

// ---------------------------------------------------------------------------
// getScenarioResultsForRun
// ---------------------------------------------------------------------------

/**
 * Retrieve all scenario results for a given run, ordered by iteration ascending.
 *
 * @returns Array of ScenarioResultRow ordered by iteration. Empty array if none exist.
 */
export async function getScenarioResultsForRun(
  adapter: DatabaseAdapter,
  runId: string,
): Promise<ScenarioResultRow[]> {
  const rows = await adapter.query<ScenarioResultRow>(
    'SELECT * FROM scenario_results WHERE run_id = ? ORDER BY iteration ASC',
    [runId],
  )
  // Coerce `passes` from integer (0/1) to boolean — adapters store it as an
  // integer for portability, so `row.passes` may be 0 or 1 on read.
  return rows.map((row) => ({ ...row, passes: Boolean(row.passes) }))
}

// ---------------------------------------------------------------------------
// listGraphRuns
// ---------------------------------------------------------------------------

/**
 * List graph run records in descending started_at order.
 *
 * @param limit - Maximum number of rows to return (default 20).
 */
export async function listGraphRuns(
  adapter: DatabaseAdapter,
  limit = 20,
): Promise<GraphRunRow[]> {
  return adapter.query<GraphRunRow>(
    'SELECT * FROM graph_runs ORDER BY started_at DESC LIMIT ?',
    [limit],
  )
}

// ---------------------------------------------------------------------------
// FactoryRunSummary types
// ---------------------------------------------------------------------------

/**
 * Summarized view of a factory graph run for display in `substrate metrics`.
 * Combines data from `graph_runs` and `scenario_results`.
 */
export interface FactoryRunSummary {
  /** Unique run identifier */
  run_id: string
  /** Latest satisfaction score (0.0–1.0); null if no scenario results exist */
  satisfaction_score: number | null
  /** Number of scenario result iterations recorded for this run */
  iterations: number
  /** Final outcome of the run (maps to final_outcome in graph_runs); null if not set */
  convergence_status: string | null
  /** ISO timestamp when the run started */
  started_at: string
  /** ISO timestamp when the run completed; null if still running */
  completed_at: string | null
  /** Total cost in USD */
  total_cost_usd: number
  /** Discriminator to distinguish from SDLC runs in JSON output */
  type: 'factory'
  /** Whether the latest iteration passed the satisfaction threshold; null if no scenario results */
  passes: boolean | null
}

// ---------------------------------------------------------------------------
// getFactoryRunSummaries
// ---------------------------------------------------------------------------

/**
 * Retrieve a summarized list of factory graph runs, enriched with per-run
 * iteration counts and latest satisfaction scores from `scenario_results`.
 *
 * Uses two queries (not a JOIN) for portability across adapters:
 * 1. SELECT from graph_runs ordered by started_at DESC
 * 2. GROUP BY aggregation on scenario_results for iteration counts and scores
 *
 * @param adapter - Database adapter (already opened)
 * @param limit   - Maximum number of graph runs to return (default 20)
 * @returns Array of FactoryRunSummary ordered by started_at DESC; empty array on error
 */
export async function getFactoryRunSummaries(
  adapter: DatabaseAdapter,
  limit = 20,
): Promise<FactoryRunSummary[]> {
  // Query 1: fetch run list
  const runs = await adapter.query<{
    id: string
    started_at: string
    completed_at: string | null
    total_cost_usd: number
    final_outcome: string | null
  }>('SELECT id, started_at, completed_at, total_cost_usd, final_outcome FROM graph_runs ORDER BY started_at DESC LIMIT ?', [limit])

  if (runs.length === 0) {
    return []
  }

  // Query 2: aggregate scenario_results by run_id (iteration count and max satisfaction score)
  const scenarioAgg = await adapter.query<{
    run_id: string
    iterations: number
    satisfaction_score: number
  }>(
    'SELECT run_id, COUNT(*) as iterations, MAX(satisfaction_score) as satisfaction_score FROM scenario_results GROUP BY run_id',
    [],
  )

  // Query 3: get the passes value from the latest iteration for each run_id.
  // Using a JOIN with a MAX(iteration) subquery is the most portable approach
  // (works in both SQLite and MySQL/Dolt) and avoids the MAX(passes) pitfall
  // where any passing iteration would incorrectly show ✓ for a regressed run.
  const latestPassesRows = await adapter.query<{
    run_id: string
    passes: number
  }>(
    'SELECT s.run_id, s.passes FROM scenario_results s INNER JOIN (SELECT run_id, MAX(iteration) AS max_iter FROM scenario_results GROUP BY run_id) latest ON s.run_id = latest.run_id AND s.iteration = latest.max_iter',
    [],
  )

  // Build a lookup map from run_id → scenario aggregation
  const scenarioMap = new Map<string, { iterations: number; satisfaction_score: number }>()
  for (const row of scenarioAgg) {
    scenarioMap.set(row.run_id, {
      iterations: row.iterations,
      satisfaction_score: row.satisfaction_score,
    })
  }

  // Build a lookup map from run_id → latest-iteration passes (boolean)
  const latestPassesMap = new Map<string, boolean>()
  for (const row of latestPassesRows) {
    latestPassesMap.set(row.run_id, row.passes !== 0)
  }

  // Combine
  return runs.map((run) => {
    const agg = scenarioMap.get(run.id)
    return {
      run_id: run.id,
      satisfaction_score: agg !== undefined ? agg.satisfaction_score : null,
      iterations: agg !== undefined ? agg.iterations : 0,
      convergence_status: run.final_outcome,
      started_at: run.started_at,
      completed_at: run.completed_at,
      total_cost_usd: run.total_cost_usd,
      type: 'factory' as const,
      passes: latestPassesMap.has(run.id) ? (latestPassesMap.get(run.id) ?? null) : null,
    }
  })
}
