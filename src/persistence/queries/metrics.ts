/**
 * Metrics query functions for the SQLite persistence layer.
 *
 * Provides CRUD operations for run_metrics and story_metrics tables (Story 17-2).
 */

import type { Database as BetterSqlite3Database } from 'better-sqlite3'

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
 */
export function writeRunMetrics(
  db: BetterSqlite3Database,
  input: RunMetricsInput,
): void {
  const stmt = db.prepare(`
    INSERT OR REPLACE INTO run_metrics (
      run_id, methodology, status, started_at, completed_at,
      wall_clock_seconds, total_input_tokens, total_output_tokens, total_cost_usd,
      stories_attempted, stories_succeeded, stories_failed, stories_escalated,
      total_review_cycles, total_dispatches, concurrency_setting, max_concurrent_actual, restarts,
      is_baseline
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)
  stmt.run(
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
    input.restarts ?? 0,
    input.is_baseline ?? 0,
  )
}

/**
 * Get run metrics for a specific run.
 */
export function getRunMetrics(
  db: BetterSqlite3Database,
  runId: string,
): RunMetricsRow | undefined {
  return db.prepare('SELECT * FROM run_metrics WHERE run_id = ?').get(runId) as RunMetricsRow | undefined
}

/**
 * List the most recent N run metrics rows, newest first.
 */
export function listRunMetrics(
  db: BetterSqlite3Database,
  limit = 10,
): RunMetricsRow[] {
  return db.prepare(
    'SELECT * FROM run_metrics ORDER BY started_at DESC LIMIT ?',
  ).all(limit) as RunMetricsRow[]
}

/**
 * Tag a run as the baseline (clears any existing baseline first).
 */
export function tagRunAsBaseline(
  db: BetterSqlite3Database,
  runId: string,
): void {
  db.transaction(() => {
    db.prepare('UPDATE run_metrics SET is_baseline = 0').run()
    db.prepare('UPDATE run_metrics SET is_baseline = 1 WHERE run_id = ?').run(runId)
  })()
}

/**
 * Get the current baseline run metrics (if any).
 */
export function getBaselineRunMetrics(
  db: BetterSqlite3Database,
): RunMetricsRow | undefined {
  return db.prepare('SELECT * FROM run_metrics WHERE is_baseline = 1 LIMIT 1').get() as RunMetricsRow | undefined
}

// ---------------------------------------------------------------------------
// Story metrics queries
// ---------------------------------------------------------------------------

/**
 * Write or update story-level metrics.
 */
export function writeStoryMetrics(
  db: BetterSqlite3Database,
  input: StoryMetricsInput,
): void {
  const stmt = db.prepare(`
    INSERT INTO story_metrics (
      run_id, story_key, result, phase_durations_json, started_at, completed_at,
      wall_clock_seconds, input_tokens, output_tokens, cost_usd,
      review_cycles, dispatches
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(run_id, story_key) DO UPDATE SET
      result = excluded.result,
      phase_durations_json = excluded.phase_durations_json,
      started_at = COALESCE(excluded.started_at, story_metrics.started_at),
      completed_at = excluded.completed_at,
      wall_clock_seconds = excluded.wall_clock_seconds,
      input_tokens = excluded.input_tokens,
      output_tokens = excluded.output_tokens,
      cost_usd = excluded.cost_usd,
      review_cycles = excluded.review_cycles,
      dispatches = excluded.dispatches
  `)
  stmt.run(
    input.run_id,
    input.story_key,
    input.result,
    input.phase_durations_json ?? null,
    input.started_at ?? null,
    input.completed_at ?? null,
    input.wall_clock_seconds ?? 0,
    input.input_tokens ?? 0,
    input.output_tokens ?? 0,
    input.cost_usd ?? 0,
    input.review_cycles ?? 0,
    input.dispatches ?? 0,
  )
}

/**
 * Get all story metrics for a given run.
 */
export function getStoryMetricsForRun(
  db: BetterSqlite3Database,
  runId: string,
): StoryMetricsRow[] {
  return db.prepare(
    'SELECT * FROM story_metrics WHERE run_id = ? ORDER BY id ASC',
  ).all(runId) as StoryMetricsRow[]
}

// ---------------------------------------------------------------------------
// Comparison (AC3)
// ---------------------------------------------------------------------------

export interface RunMetricsDelta {
  run_id_a: string
  run_id_b: string
  token_input_delta: number
  token_output_delta: number
  token_input_pct: number
  token_output_pct: number
  wall_clock_delta_seconds: number
  wall_clock_pct: number
  review_cycles_delta: number
  review_cycles_pct: number
  cost_delta: number
  cost_pct: number
}

/**
 * Compare two runs and return percentage deltas for key numeric fields.
 * Positive deltas mean run B is larger/longer than run A.
 * Returns null if either run does not exist.
 */
export function compareRunMetrics(
  db: BetterSqlite3Database,
  runIdA: string,
  runIdB: string,
): RunMetricsDelta | null {
  const a = getRunMetrics(db, runIdA)
  const b = getRunMetrics(db, runIdB)
  if (!a || !b) return null

  const pct = (base: number, diff: number): number =>
    base === 0 ? 0 : Math.round((diff / base) * 100 * 10) / 10

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
export function getRunSummaryForSupervisor(
  db: BetterSqlite3Database,
  runId: string,
): RunSummaryForSupervisor | null {
  const run = getRunMetrics(db, runId)
  if (!run) return null

  const stories = getStoryMetricsForRun(db, runId)
  const baseline = getBaselineRunMetrics(db)

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
export function aggregateTokenUsageForRun(
  db: BetterSqlite3Database,
  runId: string,
): TokenAggregate {
  const row = db.prepare(`
    SELECT
      COALESCE(SUM(input_tokens), 0) as input,
      COALESCE(SUM(output_tokens), 0) as output,
      COALESCE(SUM(cost_usd), 0) as cost
    FROM token_usage
    WHERE pipeline_run_id = ?
  `).get(runId) as TokenAggregate | undefined

  return row ?? { input: 0, output: 0, cost: 0 }
}
