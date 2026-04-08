/**
 * Metrics query functions for the persistence layer.
 *
 * Provides CRUD operations for run_metrics and story_metrics tables (Story 17-2).
 *
 * All functions are async and accept a DatabaseAdapter, making them
 * compatible with both the SqliteDatabaseAdapter and DoltDatabaseAdapter.
 */

import type { DatabaseAdapter } from '../types.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RunMetricsInput {
  run_id: string
  methodology: string
  status: string
  started_at: string
  completed_at?: string
  wall_clock_seconds?: number
  total_input_tokens?: number
  total_output_tokens?: number
  total_cost_usd?: number
  stories_attempted?: number
  stories_succeeded?: number
  stories_failed?: number
  stories_escalated?: number
  total_review_cycles?: number
  total_dispatches?: number
  concurrency_setting?: number
  max_concurrent_actual?: number
  restarts?: number
  is_baseline?: number
}

export interface RunMetricsRow extends Required<RunMetricsInput> {
  created_at: string
}

export interface StoryMetricsInput {
  run_id: string
  story_key: string
  result: string
  phase_durations_json?: string
  started_at?: string
  completed_at?: string
  wall_clock_seconds?: number
  input_tokens?: number
  output_tokens?: number
  cost_usd?: number
  review_cycles?: number
  dispatches?: number
  primary_agent_id?: string
  primary_model?: string
  dispatch_agents_json?: string
}

export interface StoryMetricsRow extends Required<StoryMetricsInput> {
  id: number
  created_at: string
}

export interface TokenAggregate {
  input: number
  output: number
  cost: number
}

// ---------------------------------------------------------------------------
// Run metrics queries
// ---------------------------------------------------------------------------

/**
 * Write or update run-level metrics.
 *
 * Uses a portable delete-then-insert pattern inside a transaction to work on
 * both SQLite/WASM and Dolt/MySQL. When a row already exists, the `restarts`
 * and `is_baseline` values are preserved from the existing row (so any
 * `incrementRunRestarts()` calls made by the supervisor between the caller's
 * read and this write are not silently overwritten).
 */
export async function writeRunMetrics(
  adapter: DatabaseAdapter,
  input: RunMetricsInput,
): Promise<void> {
  await adapter.transaction(async (tx) => {
    // Read existing row to preserve restarts and is_baseline
    const existing = await tx.query<{ restarts: number; is_baseline: number }>(
      'SELECT restarts, is_baseline FROM run_metrics WHERE run_id = ?',
      [input.run_id],
    )
    if (existing.length > 0) {
      await tx.query('DELETE FROM run_metrics WHERE run_id = ?', [input.run_id])
    }
    const restarts = existing[0]?.restarts ?? (input.restarts ?? 0)
    const isBaseline = existing[0]?.is_baseline ?? (input.is_baseline ?? 0)

    await tx.query(
      `INSERT INTO run_metrics (
        run_id, methodology, status, started_at, completed_at,
        wall_clock_seconds, total_input_tokens, total_output_tokens, total_cost_usd,
        stories_attempted, stories_succeeded, stories_failed, stories_escalated,
        total_review_cycles, total_dispatches, concurrency_setting, max_concurrent_actual, restarts,
        is_baseline
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        input.run_id,
        input.methodology,
        input.status,
        input.started_at,
        input.completed_at ?? null,
        input.wall_clock_seconds ?? 0,
        input.total_input_tokens ?? 0,
        input.total_output_tokens ?? 0,
        input.total_cost_usd ?? 0,
        input.stories_attempted ?? 0,
        input.stories_succeeded ?? 0,
        input.stories_failed ?? 0,
        input.stories_escalated ?? 0,
        input.total_review_cycles ?? 0,
        input.total_dispatches ?? 0,
        input.concurrency_setting ?? 1,
        input.max_concurrent_actual ?? 1,
        restarts,
        isBaseline,
      ],
    )
  })
}

/**
 * Get run metrics for a specific run.
 */
export async function getRunMetrics(
  adapter: DatabaseAdapter,
  runId: string,
): Promise<RunMetricsRow | undefined> {
  const rows = await adapter.query<RunMetricsRow>(
    'SELECT * FROM run_metrics WHERE run_id = ?',
    [runId],
  )
  return rows[0]
}

/**
 * List the most recent N run metrics rows, newest first.
 */
export async function listRunMetrics(
  adapter: DatabaseAdapter,
  limit = 10,
): Promise<RunMetricsRow[]> {
  return adapter.query<RunMetricsRow>(
    'SELECT * FROM run_metrics ORDER BY started_at DESC LIMIT ?',
    [limit],
  )
}

/**
 * Tag a run as the baseline (clears any existing baseline first).
 */
export async function tagRunAsBaseline(
  adapter: DatabaseAdapter,
  runId: string,
): Promise<void> {
  await adapter.transaction(async (tx) => {
    await tx.query('UPDATE run_metrics SET is_baseline = 0')
    await tx.query('UPDATE run_metrics SET is_baseline = 1 WHERE run_id = ?', [runId])
  })
}

/**
 * Get the current baseline run metrics (if any).
 */
export async function getBaselineRunMetrics(
  adapter: DatabaseAdapter,
): Promise<RunMetricsRow | undefined> {
  const rows = await adapter.query<RunMetricsRow>(
    'SELECT * FROM run_metrics WHERE is_baseline = 1 LIMIT 1',
  )
  return rows[0]
}

/**
 * Increment the restart count for a run by 1.
 * Called by the supervisor each time it successfully restarts the pipeline.
 * If the run_id does not yet exist in run_metrics, a placeholder row is
 * inserted so the restart count is not lost — writeRunMetrics will overwrite
 * all other fields when the run reaches a terminal state.
 *
 * Uses a portable select-then-update/insert pattern inside a transaction to
 * work on both SQLite/WASM and Dolt/MySQL.
 */
export async function incrementRunRestarts(
  adapter: DatabaseAdapter,
  runId: string,
): Promise<void> {
  await adapter.transaction(async (tx) => {
    const existing = await tx.query<{ restarts: number }>(
      'SELECT restarts FROM run_metrics WHERE run_id = ?',
      [runId],
    )
    if (existing.length > 0) {
      await tx.query(
        'UPDATE run_metrics SET restarts = ? WHERE run_id = ?',
        [existing[0]!.restarts + 1, runId],
      )
    } else {
      await tx.query(
        `INSERT INTO run_metrics (run_id, methodology, status, started_at, restarts)
         VALUES (?, 'unknown', 'running', ?, 1)`,
        [runId, new Date().toISOString()],
      )
    }
  })
}

// ---------------------------------------------------------------------------
// Story metrics queries
// ---------------------------------------------------------------------------

/**
 * Write or update story-level metrics.
 *
 * Uses a portable delete-then-insert pattern inside a transaction to work on
 * both SQLite/WASM and Dolt/MySQL. When a row already exists, the `started_at`
 * value is preserved from the existing row if the new value is null.
 */
export async function writeStoryMetrics(
  adapter: DatabaseAdapter,
  input: StoryMetricsInput,
): Promise<void> {
  await adapter.transaction(async (tx) => {
    // Read existing row to preserve started_at when new value is null
    const existing = await tx.query<{ started_at: string | null }>(
      'SELECT started_at FROM story_metrics WHERE run_id = ? AND story_key = ?',
      [input.run_id, input.story_key],
    )
    if (existing.length > 0) {
      await tx.query(
        'DELETE FROM story_metrics WHERE run_id = ? AND story_key = ?',
        [input.run_id, input.story_key],
      )
    }
    const startedAt = input.started_at ?? existing[0]?.started_at ?? null

    await tx.query(
      `INSERT INTO story_metrics (
        run_id, story_key, result, phase_durations_json, started_at, completed_at,
        wall_clock_seconds, input_tokens, output_tokens, cost_usd,
        review_cycles, dispatches, primary_agent_id, primary_model, dispatch_agents_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        input.run_id,
        input.story_key,
        input.result,
        input.phase_durations_json ?? null,
        startedAt,
        input.completed_at ?? null,
        input.wall_clock_seconds ?? 0,
        input.input_tokens ?? 0,
        input.output_tokens ?? 0,
        input.cost_usd ?? 0,
        input.review_cycles ?? 0,
        input.dispatches ?? 0,
        input.primary_agent_id ?? null,
        input.primary_model ?? null,
        input.dispatch_agents_json ?? null,
      ],
    )
  })
}

/**
 * Get all story metrics for a given run.
 */
export async function getStoryMetricsForRun(
  adapter: DatabaseAdapter,
  runId: string,
): Promise<StoryMetricsRow[]> {
  return adapter.query<StoryMetricsRow>(
    'SELECT * FROM story_metrics WHERE run_id = ? ORDER BY id ASC',
    [runId],
  )
}

// ---------------------------------------------------------------------------
// Comparison (AC3)
// ---------------------------------------------------------------------------

export interface RunMetricsDelta {
  run_id_a: string
  run_id_b: string
  token_input_delta: number
  token_output_delta: number
  /** null when the base run had 0 input tokens (change is undefined/infinite) */
  token_input_pct: number | null
  /** null when the base run had 0 output tokens */
  token_output_pct: number | null
  wall_clock_delta_seconds: number
  /** null when the base run had 0 wall-clock seconds */
  wall_clock_pct: number | null
  review_cycles_delta: number
  /** null when the base run had 0 review cycles */
  review_cycles_pct: number | null
  cost_delta: number
  /** null when the base run had 0 cost */
  cost_pct: number | null
}

/**
 * Compare two runs and return percentage deltas for key numeric fields.
 * Positive deltas mean run B is larger/longer than run A.
 * Returns null if either run does not exist.
 */
export async function compareRunMetrics(
  adapter: DatabaseAdapter,
  runIdA: string,
  runIdB: string,
): Promise<RunMetricsDelta | null> {
  const a = await getRunMetrics(adapter, runIdA)
  const b = await getRunMetrics(adapter, runIdB)
  if (!a || !b) return null

  const pct = (base: number, diff: number): number | null =>
    base === 0 ? null : Math.round((diff / base) * 100 * 10) / 10

  const inputDelta = b.total_input_tokens - a.total_input_tokens
  const outputDelta = b.total_output_tokens - a.total_output_tokens
  const clockDelta = (b.wall_clock_seconds ?? 0) - (a.wall_clock_seconds ?? 0)
  const cycleDelta = b.total_review_cycles - a.total_review_cycles
  const costDelta = (b.total_cost_usd ?? 0) - (a.total_cost_usd ?? 0)

  return {
    run_id_a: runIdA,
    run_id_b: runIdB,
    token_input_delta: inputDelta,
    token_output_delta: outputDelta,
    token_input_pct: pct(a.total_input_tokens, inputDelta),
    token_output_pct: pct(a.total_output_tokens, outputDelta),
    wall_clock_delta_seconds: clockDelta,
    wall_clock_pct: pct(a.wall_clock_seconds ?? 0, clockDelta),
    review_cycles_delta: cycleDelta,
    review_cycles_pct: pct(a.total_review_cycles, cycleDelta),
    cost_delta: costDelta,
    cost_pct: pct(a.total_cost_usd ?? 0, costDelta),
  }
}

// ---------------------------------------------------------------------------
// Supervisor queries (AC5)
// ---------------------------------------------------------------------------

export interface RunSummaryForSupervisor {
  run: RunMetricsRow
  stories: StoryMetricsRow[]
  baseline: RunMetricsRow | undefined
  token_vs_baseline_pct: number | null
  review_cycles_vs_baseline_pct: number | null
}

/**
 * Fetch a full run summary for consumption by the supervisor agent (AC5).
 * Includes per-story metrics and baseline delta percentages.
 */
export async function getRunSummaryForSupervisor(
  adapter: DatabaseAdapter,
  runId: string,
): Promise<RunSummaryForSupervisor | null> {
  const run = await getRunMetrics(adapter, runId)
  if (!run) return null

  const stories = await getStoryMetricsForRun(adapter, runId)
  const baseline = await getBaselineRunMetrics(adapter)

  let token_vs_baseline_pct: number | null = null
  let review_cycles_vs_baseline_pct: number | null = null

  if (baseline && baseline.run_id !== runId) {
    const pct = (base: number, val: number): number =>
      base === 0 ? 0 : Math.round(((val - base) / base) * 100 * 10) / 10
    token_vs_baseline_pct = pct(
      (baseline.total_input_tokens ?? 0) + (baseline.total_output_tokens ?? 0),
      (run.total_input_tokens ?? 0) + (run.total_output_tokens ?? 0),
    )
    review_cycles_vs_baseline_pct = pct(
      baseline.total_review_cycles ?? 0,
      run.total_review_cycles ?? 0,
    )
  }

  return { run, stories, baseline, token_vs_baseline_pct, review_cycles_vs_baseline_pct }
}

// ---------------------------------------------------------------------------
// Token aggregation
// ---------------------------------------------------------------------------

/**
 * Aggregate token usage from the token_usage table for a pipeline run.
 */
export async function aggregateTokenUsageForRun(
  adapter: DatabaseAdapter,
  runId: string,
): Promise<TokenAggregate> {
  const rows = await adapter.query<TokenAggregate>(
    `SELECT
      COALESCE(SUM(input_tokens), 0) as input,
      COALESCE(SUM(output_tokens), 0) as output,
      COALESCE(SUM(cost_usd), 0) as cost
    FROM token_usage
    WHERE pipeline_run_id = ?`,
    [runId],
  )
  return rows[0] ?? { input: 0, output: 0, cost: 0 }
}

/**
 * Aggregate token usage for a specific story within a pipeline run.
 * Matches rows where the metadata JSON contains the given storyKey.
 */
export async function aggregateTokenUsageForStory(
  adapter: DatabaseAdapter,
  runId: string,
  storyKey: string,
): Promise<TokenAggregate> {
  const rows = await adapter.query<TokenAggregate>(
    `SELECT
      COALESCE(SUM(input_tokens), 0) as input,
      COALESCE(SUM(output_tokens), 0) as output,
      COALESCE(SUM(cost_usd), 0) as cost
    FROM token_usage
    WHERE pipeline_run_id = ?
      AND metadata IS NOT NULL
      AND metadata LIKE ?`,
    [runId, `%"storyKey":"${storyKey}"%`],
  )
  return rows[0] ?? { input: 0, output: 0, cost: 0 }
}
