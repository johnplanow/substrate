/**
 * Query functions for the phase_outputs table.
 *
 * Stores the raw LLM output string produced by each dispatch step on parse
 * success. Consumers (currently the eval CLI) read these rows instead of
 * reconstructing a `key: value\n` synthesis from parsed decisions. See
 * `docs/eval-system.md` and deferred-work item G2 for the rationale.
 */

import type { DatabaseAdapter } from '../types.js'
import {
  CreatePhaseOutputInputSchema,
  type CreatePhaseOutputInput,
  type PhaseOutput,
} from '../schemas/phase-outputs.js'

/**
 * Insert or update a phase_outputs row keyed by
 * `(pipeline_run_id, phase, step_name)`. Idempotent: a second call with the
 * same composite key updates the existing row's `raw_output` and
 * `updated_at` without changing the `id`, so resume and retry paths are
 * safe.
 */
export async function upsertPhaseOutput(
  adapter: DatabaseAdapter,
  input: CreatePhaseOutputInput,
): Promise<PhaseOutput> {
  const validated = CreatePhaseOutputInputSchema.parse(input)

  // SQL NULL != NULL, so `WHERE pipeline_run_id = ?` with a null param
  // returns zero rows and breaks upsert idempotency for orphan captures.
  // Branch on null so the IS NULL variant is used when appropriate.
  const runIdIsNull = validated.pipeline_run_id == null
  const existing = runIdIsNull
    ? await adapter.query<PhaseOutput>(
        'SELECT * FROM phase_outputs WHERE pipeline_run_id IS NULL AND phase = ? AND step_name = ? LIMIT 1',
        [validated.phase, validated.step_name],
      )
    : await adapter.query<PhaseOutput>(
        'SELECT * FROM phase_outputs WHERE pipeline_run_id = ? AND phase = ? AND step_name = ? LIMIT 1',
        [validated.pipeline_run_id, validated.phase, validated.step_name],
      )

  if (existing[0]) {
    await adapter.query(
      'UPDATE phase_outputs SET raw_output = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
      [validated.raw_output, existing[0].id],
    )
    const updated = await adapter.query<PhaseOutput>(
      'SELECT * FROM phase_outputs WHERE id = ?',
      [existing[0].id],
    )
    return updated[0]!
  }

  const id = crypto.randomUUID()
  await adapter.query(
    `INSERT INTO phase_outputs (id, pipeline_run_id, phase, step_name, raw_output)
     VALUES (?, ?, ?, ?, ?)`,
    [
      id,
      validated.pipeline_run_id ?? null,
      validated.phase,
      validated.step_name,
      validated.raw_output,
    ],
  )

  const rows = await adapter.query<PhaseOutput>(
    'SELECT * FROM phase_outputs WHERE id = ?',
    [id],
  )
  return rows[0]!
}

/**
 * Return all phase_outputs rows for a given run and phase, ordered by
 * `created_at` ascending so multi-step phases preserve execution order.
 * `step_name` is used as a deterministic tiebreaker for rows that share a
 * timestamp (possible when two steps complete inside the same DB tick,
 * especially with the in-memory adapter's lower resolution). Returns an
 * empty array when no rows exist — the eval CLI treats that as "legacy run"
 * and falls back to decision reconstruction.
 */
export async function getRawOutputsByPhaseForRun(
  adapter: DatabaseAdapter,
  runId: string,
  phase: string,
): Promise<PhaseOutput[]> {
  return adapter.query<PhaseOutput>(
    'SELECT * FROM phase_outputs WHERE pipeline_run_id = ? AND phase = ? ORDER BY created_at ASC, step_name ASC',
    [runId, phase],
  )
}
