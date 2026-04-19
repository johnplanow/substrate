/**
 * StoredVerificationSummary Zod schemas — Story 52-7.
 *
 * Defines the typed schemas for persisting VerificationSummary results to the
 * run manifest's `per_story_state[storyKey].verification_result` field.
 *
 * Design notes:
 * - These schemas mirror the shape of VerificationSummary / VerificationCheckResult
 *   from packages/sdlc/src/verification/types.ts WITHOUT importing from that module.
 *   This avoids a circular import between run-model and verification.
 * - `status` uses `z.enum` (closed set) since verification statuses are fixed at
 *   `pass|warn|fail` only — distinct from PerStoryStatusSchema which uses the open
 *   extensible union pattern from v0.19.6.
 * - All imports use `.js` extensions per monorepo convention.
 */

import { z } from 'zod'

// ---------------------------------------------------------------------------
// StoredVerificationFindingSchema — story 55-3
// ---------------------------------------------------------------------------

/**
 * Schema for a single structured verification finding (story 55-1 / 55-3).
 *
 * Mirrors the VerificationFinding interface in
 * packages/sdlc/src/verification/findings.ts without importing from that
 * module to keep run-model free of a dependency on verification.
 */
export const StoredVerificationFindingSchema = z.object({
  category: z.string(),
  severity: z.enum(['error', 'warn', 'info']),
  message: z.string(),
  command: z.string().optional(),
  exitCode: z.number().int().optional(),
  stdoutTail: z.string().optional(),
  stderrTail: z.string().optional(),
  durationMs: z.number().nonnegative().optional(),
})

export type StoredVerificationFinding = z.infer<typeof StoredVerificationFindingSchema>

// ---------------------------------------------------------------------------
// StoredVerificationCheckResultSchema
// ---------------------------------------------------------------------------

/**
 * Schema for a single per-check verification result stored in the manifest.
 *
 * Mirrors VerificationCheckResult from packages/sdlc/src/verification/types.ts
 * without importing from that module (avoids circular dependency).
 */
export const StoredVerificationCheckResultSchema = z.object({
  /** Human-readable check identifier (e.g. 'BuildCheck', 'TrivialOutputCheck'). */
  checkName: z.string(),
  /** Check outcome status. */
  status: z.enum(['pass', 'warn', 'fail']),
  /** Human-readable details about the check outcome. */
  details: z.string(),
  /** Duration of this check in milliseconds. */
  duration_ms: z.number().nonnegative(),
  /**
   * Structured per-issue findings (story 55-1 / 55-3).
   *
   * Optional for backward compatibility with manifests produced before
   * Epic 55 Phase 1 landed — a manifest without this field reads cleanly
   * and callers that read the field see `undefined`.
   */
  findings: z.array(StoredVerificationFindingSchema).optional(),
})

export type StoredVerificationCheckResult = z.infer<typeof StoredVerificationCheckResultSchema>

// ---------------------------------------------------------------------------
// StoredVerificationSummarySchema
// ---------------------------------------------------------------------------

/**
 * Schema for the aggregated verification pipeline summary stored in the manifest.
 *
 * Mirrors VerificationSummary from packages/sdlc/src/verification/types.ts
 * without importing from that module (avoids circular dependency).
 */
export const StoredVerificationSummarySchema = z.object({
  /** Story key that was verified (e.g. '52-7'). */
  storyKey: z.string(),
  /** Per-check results in the order they were executed. */
  checks: z.array(StoredVerificationCheckResultSchema),
  /** Worst-case aggregate status: fail > warn > pass. */
  status: z.enum(['pass', 'warn', 'fail']),
  /** Total duration of the verification pipeline run in milliseconds. */
  duration_ms: z.number().nonnegative(),
})

export type StoredVerificationSummary = z.infer<typeof StoredVerificationSummarySchema>
