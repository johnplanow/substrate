/**
 * RunManifest Zod schemas — Story 52-1 / Story 52-8.
 *
 * Provides runtime validation for the run manifest file.
 * All schemas mirror the TypeScript interfaces in `types.ts`.
 */

import { z } from 'zod'
import { CliFlagsSchema } from './cli-flags.js'
import { PerStoryStateSchema } from './per-story-state.js'
import { RecoveryEntrySchema, CostAccumulationSchema } from './recovery-history.js'

// Re-export for convenience (Story 52-8)
export { RecoveryEntrySchema, CostAccumulationSchema } from './recovery-history.js'

// ---------------------------------------------------------------------------
// Sub-schemas
// ---------------------------------------------------------------------------

/**
 * Schema for a pending supervisor proposal.
 * Uses z.union for extensible type field (follows v0.19.6 ReadinessFindingCategory pattern).
 */
export const ProposalSchema = z.object({
  id: z.string(),
  created_at: z.string(),
  description: z.string(),
  type: z.union([
    z.literal('retry'),
    z.literal('fix'),
    z.literal('escalate'),
    z.literal('skip'),
    z.string(), // extensible — accepts unknown future types
  ]),
  story_key: z.string().optional(),
  payload: z.record(z.string(), z.unknown()).optional(),
})

// ---------------------------------------------------------------------------
// RunManifestSchema — primary schema
// ---------------------------------------------------------------------------

/**
 * Zod schema for the full run manifest data.
 * Validated on every read; write validates via JSON round-trip.
 *
 * `cost_accumulation` uses `.default({ per_story: {}, run_total: 0 })` so
 * pre-Phase-D manifests that omit this field parse without error (AC7).
 */
export const RunManifestSchema = z.object({
  run_id: z.string(),
  // Story 52-3: validate cli_flags with CliFlagsSchema so unknown halt_on values
  // (e.g. 'severe') are caught at deserialization time (AC7). Unknown keys are
  // stripped silently (Zod default). Output is cast back to Record<string,unknown>
  // so RunManifestData.cli_flags type is unchanged for all existing consumers.
  cli_flags: CliFlagsSchema.transform((v): Record<string, unknown> => v),
  story_scope: z.array(z.string()),
  supervisor_pid: z.number().nullable(),
  supervisor_session_id: z.string().nullable(),
  per_story_state: z.record(z.string(), PerStoryStateSchema),
  // Story 52-8: typed RecoveryEntry array (replaces placeholder from 52-1)
  recovery_history: z.array(RecoveryEntrySchema),
  // Story 52-8: typed CostAccumulation with .default() for backward compatibility.
  // Pre-Phase-D manifests that omit cost_accumulation parse without error (AC7).
  cost_accumulation: CostAccumulationSchema.default({ per_story: {}, run_total: 0 }),
  pending_proposals: z.array(ProposalSchema),
  generation: z.number().int().nonnegative(),
  created_at: z.string(),
  updated_at: z.string(),
})

// ---------------------------------------------------------------------------
// ManifestReadError
// ---------------------------------------------------------------------------

/**
 * Error thrown when all read sources for a manifest fail.
 *
 * Includes `attempted_sources` listing each path/source tried,
 * so callers can diagnose which files were corrupt or missing.
 */
export class ManifestReadError extends Error {
  /** List of sources (file paths or source names) that were attempted. */
  readonly attempted_sources: string[]

  constructor(message: string, attempted_sources: string[]) {
    super(message)
    this.name = 'ManifestReadError'
    this.attempted_sources = attempted_sources
  }
}
