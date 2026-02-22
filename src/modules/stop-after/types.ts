/**
 * Stop-After Gate Module — Types
 *
 * Defines the PhaseName type and all parameter/result types for the stop-after gate.
 * VALID_PHASES is the canonical source for pipeline phase names; auto.ts imports from here.
 */

/** Canonical pipeline phase names. This is the single source of truth for all phase lists. */
export const VALID_PHASES = [
  'analysis',
  'planning',
  'solutioning',
  'implementation',
] as const

/**
 * Alias for VALID_PHASES retained for backward compatibility with existing imports.
 * @deprecated Use VALID_PHASES directly.
 */
export const STOP_AFTER_VALID_PHASES = VALID_PHASES

/** Phase name type */
export type PhaseName = (typeof VALID_PHASES)[number]

/**
 * Parameters for creating a stop-after gate.
 */
export interface StopAfterGateParams {
  phaseName: PhaseName
}

/**
 * Parameters for formatting a phase completion summary.
 */
export interface CompletionSummaryParams {
  /** The phase that completed */
  phaseName: PhaseName
  /** ISO 8601 start timestamp */
  startedAt: string
  /** ISO 8601 completion timestamp */
  completedAt: string
  /** Number of decisions written during this phase */
  decisionsCount: number
  /** Artifact file paths (relative to project root) */
  artifactPaths: string[]
  /** Pipeline run ID for resume command */
  runId: string
  /** Optional: description of what the next phase will consume */
  nextPhaseDescription?: string
}

/**
 * Result of a validation check.
 */
export interface ValidationResult {
  valid: boolean
  error?: string
}
