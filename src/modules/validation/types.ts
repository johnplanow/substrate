/**
 * Validation module — shared type definitions.
 * No implementation logic lives here; this file is purely types.
 */

import type { StoryPhase } from '../implementation-orchestrator/types.js'

/**
 * Story metadata passed to validation levels.
 *
 * Lives here (not in `../state`) because validation is the only consumer
 * post-Item-7-arc. Was previously re-exported from `../state` when the
 * orchestrator's `StateStore` interface owned cross-module story records.
 */
export interface StoryRecord {
  /** Unique story identifier, e.g. "26-1" */
  storyKey: string
  /** Current lifecycle phase */
  phase: StoryPhase
  /** Number of code-review cycles completed */
  reviewCycles: number
  /** Last verdict from code review, if any */
  lastVerdict?: string
  /** Error message if the story encountered a fatal error */
  error?: string
  /** ISO timestamp when processing started */
  startedAt?: string
  /** ISO timestamp when processing completed or was escalated */
  completedAt?: string
  /** Sprint identifier, e.g. "sprint-1" */
  sprint?: string
  /**
   * Number of files modified at the time of a dev-story timeout checkpoint.
   * Only set when phase === 'CHECKPOINT'.
   */
  checkpointFilesCount?: number
}

// ---------------------------------------------------------------------------
// LevelFailure
// ---------------------------------------------------------------------------

/**
 * A single failure detail reported by a validation level.
 */
export interface LevelFailure {
  /** Which category of check produced this failure */
  category: 'schema' | 'build' | 'test' | 'invariant'
  /** Human-readable description of the failure */
  description: string
  /** Optional file/line location associated with the failure */
  location?: string
  /** Raw output, diff, or other evidence supporting the failure */
  evidence: string
  /** Optional recommended remediation action */
  suggestedAction?: string
}

/**
 * Alias for LevelFailure — used in specialised level implementations
 * (e.g. BuildValidationLevel) to match their interface contract naming.
 */
export type FailureDetail = LevelFailure

// ---------------------------------------------------------------------------
// LevelResult
// ---------------------------------------------------------------------------

/**
 * The result returned by a single `ValidationLevel.run()` call.
 */
export interface LevelResult {
  passed: boolean
  failures: LevelFailure[]
  canAutoRemediate: boolean
  /**
   * Optional pre-built remediation context from the level.
   *
   * When present the cascade runner uses this directly (preserving scope,
   * location, etc.) instead of building a generic context from `failures`.
   * Specialised levels such as `BuildValidationLevel` populate this to
   * carry precise scope information (surgical vs partial) back to callers.
   */
  remediationContext?: RemediationContext
}

// ---------------------------------------------------------------------------
// ValidationContext
// ---------------------------------------------------------------------------

/**
 * Context passed into each `ValidationLevel.run()` call.
 */
export interface ValidationContext {
  story: StoryRecord
  result: unknown
  attempt: number
  projectRoot: string
}

// ---------------------------------------------------------------------------
// ValidationLevel
// ---------------------------------------------------------------------------

/**
 * Interface that all pluggable validation levels must implement.
 */
export interface ValidationLevel {
  /** Numeric priority — levels execute in ascending order */
  level: number
  /** Human-readable name for logging and debugging */
  name: string
  run(context: ValidationContext): Promise<LevelResult>
}

// ---------------------------------------------------------------------------
// RemediationContext
// ---------------------------------------------------------------------------

/**
 * Packed context that the orchestrator/retry strategy uses to guide re-tries.
 */
export interface RemediationContext {
  /** The level number at which the first failure occurred */
  level: number
  /** Failures collected from the failing level */
  failures: LevelFailure[]
  /** Budget tracking for retry attempts — populated by the orchestrator (Story 33-4) */
  retryBudget: {
    spent: number
    remaining: number
  }
  /** Remediation scope hint */
  scope: 'surgical' | 'partial' | 'full'
  canAutoRemediate: boolean
}

// ---------------------------------------------------------------------------
// ValidationResult
// ---------------------------------------------------------------------------

/**
 * Aggregate result returned by `ValidationHarness.runCascade()`.
 */
export interface ValidationResult {
  passed: boolean
  /** The highest level number that was actually executed */
  highestLevelReached: number
  failures: LevelFailure[]
  canAutoRemediate: boolean
  remediationContext: RemediationContext | null
}

// ---------------------------------------------------------------------------
// CascadeRunnerConfig
// ---------------------------------------------------------------------------

/**
 * Configuration for a `CascadeRunner` instance.
 */
export interface CascadeRunnerConfig {
  /**
   * Optional upper bound on which levels to execute.
   * When set, only levels with `level <= maxLevel` are run.
   */
  maxLevel?: number
  /** Absolute path to the project root (forwarded to ValidationContext) */
  projectRoot: string
}
