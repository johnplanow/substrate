/**
 * RecoveryEntry and CostAccumulation schemas — Story 52-8.
 *
 * Provides Zod schemas and TypeScript types for recovery history and cost
 * accumulation data stored in the run manifest. Consumed by Epic 53 cost
 * governance and Epic 54 recovery engine.
 */

import { z } from 'zod'

// ---------------------------------------------------------------------------
// RecoveryOutcome
// ---------------------------------------------------------------------------

/**
 * Outcome of a recovery attempt.
 *
 * The string fallback must be last in the union so Zod evaluates the literal
 * variants first — a leading z.string() would swallow all literals. This
 * follows the v0.19.6 extensible union pattern used throughout the codebase.
 */
export const RecoveryOutcomeSchema = z.union([
  z.literal('retried'),
  z.literal('escalated'),
  z.literal('skipped'),
  z.string(), // extensible fallback — must be last (v0.19.6 pattern)
])

export type RecoveryOutcome = z.infer<typeof RecoveryOutcomeSchema>

// ---------------------------------------------------------------------------
// RecoveryEntry
// ---------------------------------------------------------------------------

/**
 * A single recovery attempt recorded in the run manifest.
 *
 * `attempt_number` is 1-indexed: 1 = first retry, NOT the initial dispatch.
 * The initial dispatch of a story is never recorded as a RecoveryEntry.
 *
 * `strategy` is free-form (e.g., `'retry-with-context'`, `'re-scope'`).
 *
 * `cost_usd` is the cost of THIS single retry attempt only — NOT cumulative.
 * Cumulative per-story retry cost is tracked in `CostAccumulation.per_story`.
 */
export const RecoveryEntrySchema = z.object({
  /** Story key that triggered this recovery attempt (e.g. '52-8'). */
  story_key: z.string(),
  /** 1-indexed attempt number — 1 = first retry, not initial dispatch. */
  attempt_number: z.number().int().nonnegative(),
  /** Recovery strategy applied (e.g., 'retry-with-context', 're-scope'). */
  strategy: z.string(),
  /** Root cause classification string (informational, for completion report). */
  root_cause: z.string(),
  /** Outcome of this recovery attempt. */
  outcome: RecoveryOutcomeSchema,
  /** Cost of this single retry attempt in USD (NOT cumulative). */
  cost_usd: z.number().nonnegative(),
  /** ISO-8601 timestamp when this recovery was initiated. */
  timestamp: z.string(),
})

export type RecoveryEntry = z.infer<typeof RecoveryEntrySchema>

// ---------------------------------------------------------------------------
// CostAccumulation
// ---------------------------------------------------------------------------

/**
 * Accumulated retry cost data for a pipeline run.
 *
 * `per_story` maps story_key → sum of all RecoveryEntry.cost_usd for that
 * story. It does NOT include the initial dispatch cost, which is tracked in
 * `PerStoryState.cost_usd`.
 *
 * `run_total` is the sum of all RecoveryEntry.cost_usd values in the run
 * (i.e., total retry cost only, not total run cost).
 *
 * An empty `{ per_story: {}, run_total: 0 }` is the valid initial value.
 */
export const CostAccumulationSchema = z.object({
  /**
   * Per-story cumulative retry cost in USD.
   * Maps story_key → sum of all RecoveryEntry.cost_usd for that story.
   * Does NOT include the initial dispatch cost (tracked in PerStoryState.cost_usd).
   */
  per_story: z.record(z.string(), z.number().nonnegative()),
  /**
   * Total retry cost for the entire run in USD.
   * Equal to sum of all RecoveryEntry.cost_usd values.
   */
  run_total: z.number().nonnegative(),
})

export type CostAccumulation = z.infer<typeof CostAccumulationSchema>
