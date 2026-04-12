/**
 * Query functions for the phase_outputs table.
 *
 * Stores the raw LLM output string produced by each dispatch step on parse
 * success. Consumers (currently the eval CLI) read these rows instead of
 * reconstructing a `key: value\n` synthesis from parsed decisions. See
 * `docs/eval-system.md` and deferred-work item G2 for the rationale.
 */

import type { DatabaseAdapter } from '../types.js'
import { isUniqueConstraintViolation } from '../upsert-errors.js'
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
 *
 * G10: For non-null run_id, uses an atomic INSERT-catch-UPDATE pattern
 * backed by the `uniq_phase_outputs_composite` UNIQUE index. Pre-G10 this
 * was a SELECT-then-write pattern that raced under concurrent writers.
 *
 * For null run_id, falls back to the legacy SELECT-first path because
 * standard SQL treats NULLs as distinct in UNIQUE indexes (the constraint
 * doesn't fire for NULL values), so orphan captures rely on
 * application-level dedup.
 */
export async function upsertPhaseOutput(
  adapter: DatabaseAdapter,
  input: CreatePhaseOutputInput,
): Promise<PhaseOutput> {
  const validated = CreatePhaseOutputInputSchema.parse(input)

  if (validated.pipeline_run_id == null) {
    // Null run_id: UNIQUE index cannot enforce composite uniqueness
    // because NULLs compare as distinct in standard SQL. Fall back to
    // application-level dedup via SELECT-then-write.
    const existing = await adapter.query<PhaseOutput>(
      'SELECT * FROM phase_outputs WHERE pipeline_run_id IS NULL AND phase = ? AND step_name = ? LIMIT 1',
      [validated.phase, validated.step_name],
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
      [id, null, validated.phase, validated.step_name, validated.raw_output],
    )
    const rows = await adapter.query<PhaseOutput>('SELECT * FROM phase_outputs WHERE id = ?', [id])
    return rows[0]!
  }

  // Non-null run_id: atomic INSERT-catch-UPDATE.
  const id = crypto.randomUUID()
  try {
    await adapter.query(
      `INSERT INTO phase_outputs (id, pipeline_run_id, phase, step_name, raw_output)
       VALUES (?, ?, ?, ?, ?)`,
      [
        id,
        validated.pipeline_run_id,
        validated.phase,
        validated.step_name,
        validated.raw_output,
      ],
    )
    const [row] = await adapter.query<PhaseOutput>('SELECT * FROM phase_outputs WHERE id = ?', [id])
    return row!
  } catch (err) {
    if (!isUniqueConstraintViolation(err)) throw err
    // Composite key collision — UPDATE by composite key (atomic single
    // statement, no read-modify-write race).
    await adapter.query(
      `UPDATE phase_outputs SET raw_output = ?, updated_at = CURRENT_TIMESTAMP
       WHERE pipeline_run_id = ? AND phase = ? AND step_name = ?`,
      [
        validated.raw_output,
        validated.pipeline_run_id,
        validated.phase,
        validated.step_name,
      ],
    )
    const [row] = await adapter.query<PhaseOutput>(
      'SELECT * FROM phase_outputs WHERE pipeline_run_id = ? AND phase = ? AND step_name = ? LIMIT 1',
      [validated.pipeline_run_id, validated.phase, validated.step_name],
    )
    return row!
  }
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
