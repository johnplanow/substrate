/**
 * run-model barrel export — Story 52-1/52-3.
 *
 * Exports RunManifest, RunManifestData, RunManifestSchema, ManifestReadError,
 * CliFlags, CliFlagsSchema, and all sub-types consumed by Epic 52 stories.
 */

export { RunManifest } from './run-manifest.js'
export type { IDoltAdapter } from './run-manifest.js'

export type {
  RunManifestData,
  RecoveryEntry,
  CostAccumulation,
  Proposal,
} from './types.js'

export {
  RunManifestSchema,
  RecoveryEntrySchema,
  CostAccumulationSchema,
  ProposalSchema,
  ManifestReadError,
} from './schemas.js'

// Story 52-8: Recovery history schemas and types (additional exports not covered above)
export { RecoveryOutcomeSchema } from './recovery-history.js'
export type { RecoveryOutcome } from './recovery-history.js'

// Story 52-3: CLI flag persistence schema
export { CliFlagsSchema } from './cli-flags.js'
export type { CliFlags } from './cli-flags.js'

// Story 52-4: Per-story lifecycle state schema and types
export { PerStoryStatusSchema, PerStoryStateSchema } from './per-story-state.js'
export type { PerStoryStatus, PerStoryState } from './per-story-state.js'

// Story 52-7: Stored verification result schemas and types
// Story 55-3: StoredVerificationFinding schema (part of findings persistence)
export {
  StoredVerificationFindingSchema,
  StoredVerificationCheckResultSchema,
  StoredVerificationSummarySchema,
} from './verification-result.js'
export type {
  StoredVerificationFinding,
  StoredVerificationCheckResult,
  StoredVerificationSummary,
} from './verification-result.js'

// Story 55-3b: roll-up helper for surfacing finding counts in CLI JSON output
export { rollupFindingCounts, ZERO_FINDING_COUNTS } from './verification-findings-counts.js'
export type { VerificationFindingsCounts } from './verification-findings-counts.js'

// Story 52-2: Supervisor locking and ownership
export { SupervisorLock } from './supervisor-lock.js'
export type { SupervisorLockOptions } from './supervisor-lock.js'
