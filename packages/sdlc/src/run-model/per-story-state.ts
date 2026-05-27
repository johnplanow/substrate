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
  /**
   * Transient state during cross-story-race recovery (Story 70-1). Story is
   * re-verification pending; not a terminal failure. Once recovery completes
   * the status transitions to 'complete' (pipeline:cross-story-race-recovered)
   * or 'failed' (pipeline:cross-story-race-still-failed).
   */
  z.literal('verification-stale'),
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
  /**
   * Story 70-1: set to `true` when the story's verification was re-run as part
   * of cross-story-race recovery and the fresh result still failed. Allows
   * downstream consumers (e.g. supervisor, post-mortem tooling) to distinguish
   * genuine race-confirmed failures from original first-pass failures.
   *
   * Absent on stories that were not re-verified via recovery — do NOT interpret
   * absence as `false`; use `?? false` at call sites that need a boolean.
   */
  verification_re_run: z.boolean().optional(),
  /**
   * Story 77-4: the root-cause/verdict taxonomy value for why this story
   * escalated (e.g. 'checkpoint-retry-timeout', 'zero-diff-on-complete',
   * 'retry_budget_exhausted'). Written by the orchestrator on every escalation
   * path (via emitEscalation); read by `substrate report` (report.ts) to enrich
   * escalation diagnostics. Absent on stories that did not escalate. Required
   * so decision-replay (story 77-5) can assert escalation reasons.
   */
  escalation_reason: z.string().optional(),
  /**
   * F-commitsha (Story 77-6 prereq): the SHA of substrate's dev-story
   * auto-commit (`feat(story-N-M)`) for this story, recorded at commit time.
   * Enables reconstruction-corpus census (commit↔manifest correlation by SHA,
   * story 77-6) and more robust reconcile-from-disk (HEAD-advance detection).
   * Absent on stories that did not reach a successful auto-commit.
   */
  commit_sha: z.string().optional(),
  /**
   * obs_2026-05-26_027 (reconstruction phase-input persistence): the original
   * repo-relative path of the story file that the producing phase (dev-story)
   * consumed, recorded for provenance. Informational — the recoverable copy is
   * `story_file_input_path` below.
   */
  story_file: z.string().optional(),
  /**
   * obs_2026-05-26_027: location of a durable COPY of the story-file input,
   * relative to the run manifest's directory (`.substrate/runs/`), i.e.
   * `inputs/<run-id>/<story-key>.md`. Written at auto-commit time, BEFORE the
   * per-story worktree is torn down, so the reconstruction harness (Story 77-8)
   * can recover the exact input even when the consumer repo does not git-track
   * its story artifacts (the gap obs_027 documented: strata story 5-2). The
   * census prefers this over recovering the file from git at the parent SHA.
   * Forward-only (mirrors `commit_sha`); absent on pre-fix runs.
   */
  story_file_input_path: z.string().optional(),
  /**
   * obs_2026-05-26_027: SHA-256 of the captured story-file input. Lets the
   * reconstruction grader (Story 77-9) verify the reconstruction was fed the
   * SAME input as the original producing phase (input-drift detection).
   */
  story_file_sha256: z.string().optional(),
})

export type PerStoryState = z.infer<typeof PerStoryStateSchema>
