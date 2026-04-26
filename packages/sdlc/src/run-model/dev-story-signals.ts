/**
 * StoredDevStorySignals Zod schema — Story 60-8.
 *
 * Defines the typed schema for persisting the dev-story handler's normalized
 * output (`DevStorySignals` from `packages/sdlc/src/verification/types.ts`)
 * to the run manifest's `per_story_state[storyKey].dev_story_signals` field.
 *
 * Why this exists:
 *   - Story 60-3 (under-delivery detection) reads `context.devStoryResult.files_modified`
 *     during verification. The orchestrator passes it in-memory at dispatch time
 *     (verification-integration.ts:62 → assembleVerificationContext), so the
 *     check works in the SAME run.
 *   - But the field is never persisted to the manifest. Resume / retry-escalated
 *     / supervisor-restart / post-mortem analysis paths read state from the
 *     manifest and see `dev_story_signals: undefined`, which falls through to
 *     "no signal → benefit of doubt" warn instead of the intended under-delivery
 *     error. Epic 52's design contract is that the manifest is the single
 *     source of truth — devStorySignals omission contradicts that.
 *
 * Mirrors the DevStorySignals interface without importing verification module
 * to keep run-model free of a dependency on verification (same pattern as
 * StoredVerificationFindingSchema in verification-result.ts).
 */

import { z } from 'zod'

/**
 * Persisted shape of the normalized dev-story signals.
 *
 * All fields optional because:
 *   - Different dev-story dispatches surface different subsets of fields
 *     depending on the agent's YAML output (some omit `tests`, some omit
 *     `ac_failures` when none failed, etc.).
 *   - `result` uses the open extensible-union pattern (v0.19.6 convention)
 *     so future result strings (e.g. 'partial-checkpoint') don't break
 *     deserialization.
 */
export const StoredDevStorySignalsSchema = z.object({
  /** Dev agent's overall verdict — open union for forward-compat. */
  result: z
    .union([
      z.literal('completed'),
      z.literal('failed'),
      z.literal('partial'),
      z.string(),
    ])
    .optional(),
  /** ACs the dev agent claims it satisfied. */
  ac_met: z.array(z.string()).optional(),
  /** ACs the dev agent flagged as not satisfied. */
  ac_failures: z.array(z.string()).optional(),
  /**
   * List of project-relative file paths the dev agent created or modified
   * during this dispatch. Required by Story 60-3's under-delivery detection
   * in source-ac-fidelity check; absence forces the check into "benefit of
   * doubt" warn mode.
   */
  files_modified: z.array(z.string()).optional(),
  /** Test outcome from the dev-story workflow — open union for forward-compat. */
  tests: z
    .union([
      z.literal('pass'),
      z.literal('fail'),
      z.literal('unknown'),
      z.string(),
    ])
    .optional(),
})

export type StoredDevStorySignals = z.infer<typeof StoredDevStorySignalsSchema>
