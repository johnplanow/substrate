/**
 * PerStoryState — per-story lifecycle state schema — Story 52-4.
 *
 * Provides the typed schema for individual story lifecycle states tracked
 * in the run manifest's `per_story_state` map. Each entry records both
 * a high-level consumer-facing status and the raw orchestrator phase string.
 */

import { z } from 'zod'
import { StoredVerificationSummarySchema } from './verification-result.js'
import { StoredDevStorySignalsSchema } from './dev-story-signals.js'

// ---------------------------------------------------------------------------
// PerStoryStatusSchema — extensible union (v0.19.6 pattern)
// ---------------------------------------------------------------------------

/**
 * High-level consumer-facing status for a story in the run manifest.
 *
 * Known literals cover all states defined in Epic 52–54. The trailing
 * `z.string()` fallback (MUST remain last) accommodates states added by
 * later stories (`gated` from 53-9, `skipped` from 53-3, `recovered` from 54-1)
 * and any future extensions without breaking deserialization.
 */
export const PerStoryStatusSchema = z.union([
  z.literal('pending'),
  z.literal('dispatched'),
  z.literal('in-review'),
  z.literal('complete'),
  z.literal('failed'),
  z.literal('escalated'),
  z.literal('recovered'),
  z.literal('verification-failed'),
  z.literal('gated'),
  z.literal('skipped'),
  z.string(), // extensible fallback — must be last
])

export type PerStoryStatus = z.infer<typeof PerStoryStatusSchema>

// ---------------------------------------------------------------------------
// PerStoryStateSchema
// ---------------------------------------------------------------------------

/**
 * Schema for a single per-story state entry in the run manifest.
 *
 * Field semantics:
 * - `status`: High-level consumer-facing status (state-machine value). Use this
 *   for state-machine decisions and display.
 * - `phase`: Raw orchestrator `StoryPhase` string (e.g., `'IN_DEV'`, `'IN_REVIEW'`).
 *   Informational only — do NOT compare this field in state-machine logic.
 * - `started_at`: ISO-8601 timestamp when the story entered an active phase.
 * - `completed_at`: ISO-8601 timestamp when the story reached a terminal state.
 * - `verification_result`: Verification pipeline result (populated by story 52-7).
 * - `cost_usd`: Accumulated cost in USD (populated at terminal transition).
 */
export const PerStoryStateSchema = z.object({
  /** High-level consumer-facing status (state-machine value). */
  status: PerStoryStatusSchema,
  /** Raw orchestrator StoryPhase string (informational, for debugging). */
  phase: z.string(),
  /** ISO-8601 timestamp when the story entered an active phase. */
  started_at: z.string(),
  /** ISO-8601 timestamp when the story reached a terminal state. */
  completed_at: z.string().optional(),
  /** Verification pipeline result for this story (populated by story 52-7). */
  verification_result: StoredVerificationSummarySchema.optional(),
  /** Accumulated cost in USD for this story (populated at terminal transition). */
  cost_usd: z.number().nonnegative().optional(),
  /** Number of code review cycles this story went through. */
  review_cycles: z.number().int().nonnegative().optional(),
  /** Number of agent dispatches for this story. */
  dispatches: z.number().int().nonnegative().optional(),
  /** Number of retry attempts for this story (code review retries + recovery-engine retries). Initial dispatch is not counted. */
  retry_count: z.number().int().nonnegative().optional(),
  /**
   * Story 60-8: persisted dev-story signals — files_modified, ac_met,
   * ac_failures, tests, result. Required by Story 60-3's under-delivery
   * detection when reading state from manifest (resume / retry-escalated /
   * supervisor-restart / post-mortem). Absent on pre-60-8 manifests
   * (backward-compatible).
   */
  dev_story_signals: StoredDevStorySignalsSchema.optional(),
  /**
   * Story 65-6: trigger-class discriminator for the probe-author phase.
   * Records whether the probe-author dispatch was triggered by an event-driven
   * AC, a state-integrating AC, or both. Absent on pre-65-6 manifests;
   * consumers MUST default to `'event-driven'` when absent (backward-compat).
   *
   * Open string union (z.union([z.literal(...), z.string()])) follows the
   * `dev_story_signals` pattern for forward-compatible extensibility.
   */
  probe_author_triggered_by: z.union([
    z.literal('event-driven'),
    z.literal('state-integrating'),
    z.literal('both'),
    z.string(),
  ]).optional(),
})

export type PerStoryState = z.infer<typeof PerStoryStateSchema>
