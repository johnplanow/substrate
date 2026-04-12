/**
 * Query functions for the eval_results table (V1b-2).
 *
 * Stores eval reports for queryable score history and run-to-run comparison.
 */

import type { DatabaseAdapter } from '../types.js'
import {
  EvalResultRowSchema,
  CreateEvalResultInputSchema,
  type CreateEvalResultInput,
  type EvalResultRow,
} from '../schemas/eval-results.js'

/**
 * Write an eval result to the database. UNIQUE on eval_id prevents
 * accidental double-writes from retries.
 */
export async function writeEvalResult(
  adapter: DatabaseAdapter,
  input: CreateEvalResultInput,
): Promise<EvalResultRow> {
  const validated = CreateEvalResultInputSchema.parse(input)

  await adapter.query(
    `INSERT INTO eval_results (run_id, eval_id, depth, timestamp, overall_score, pass, phases_json, metadata_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      validated.run_id,
      validated.eval_id,
      validated.depth,
      validated.timestamp,
      validated.overall_score,
      validated.pass ? 1 : 0,
      validated.phases_json,
      validated.metadata_json ?? null,
    ],
  )

  const [row] = await adapter.query<EvalResultRow>(
    'SELECT * FROM eval_results WHERE eval_id = ?',
    [validated.eval_id],
  )
  return EvalResultRowSchema.parse(row)
}

/**
 * Get the most recent eval result for a given pipeline run.
 * Returns undefined if no eval has been run for this run_id.
 */
export async function getLatestEvalForRun(
  adapter: DatabaseAdapter,
  runId: string,
): Promise<EvalResultRow | undefined> {
  const rows = await adapter.query<EvalResultRow>(
    'SELECT * FROM eval_results WHERE run_id = ? ORDER BY timestamp DESC LIMIT 1',
    [runId],
  )
  return rows[0] ? EvalResultRowSchema.parse(rows[0]) : undefined
}

/**
 * Get all eval results for a given pipeline run, ordered newest first.
 */
export async function getEvalsForRun(
  adapter: DatabaseAdapter,
  runId: string,
): Promise<EvalResultRow[]> {
  const rows = await adapter.query<EvalResultRow>(
    'SELECT * FROM eval_results WHERE run_id = ? ORDER BY timestamp DESC',
    [runId],
  )
  return rows.map((r) => EvalResultRowSchema.parse(r))
}

/**
 * Load eval result rows for two runs, for use in --compare (V1b-5).
 * Returns [reportA, reportB] or undefined entries when a run has no DB row.
 */
export async function loadEvalPairForComparison(
  adapter: DatabaseAdapter,
  runIdA: string,
  runIdB: string,
): Promise<[EvalResultRow | undefined, EvalResultRow | undefined]> {
  const [a, b] = await Promise.all([
    getLatestEvalForRun(adapter, runIdA),
    getLatestEvalForRun(adapter, runIdB),
  ])
  return [a, b]
}
