/**
 * Verification framework types — Story 51-1.
 *
 * Defines the VerificationCheck interface and all supporting types
 * consumed by VerificationPipeline and future concrete check implementations
 * (Stories 51-2 through 51-6).
 *
 * Package placement: packages/sdlc/src/verification/ — SDLC-specific fields
 * (storyKey, commitSha, priorStoryFiles) make these types inappropriate for @substrate-ai/core.
 */

import type { VerificationFinding } from './findings.js'

// Re-export so callers can reach the finding types via the types barrel.
export type { VerificationFinding, VerificationFindingSeverity } from './findings.js'

// ---------------------------------------------------------------------------
// ReviewSignals
// ---------------------------------------------------------------------------

/**
 * Slim projection of code-review dispatch signals needed by PhantomReviewCheck.
 *
 * Intentionally narrow — do NOT import CodeReviewResult from the monolith into
 * this sdlc package. Only the fields required by the phantom detection check are
 * included here (Story 51-2).
 */
export interface ReviewSignals {
  /** True when dispatch itself failed — covers crash, timeout, non-zero exit, AND schema validation failure */
  dispatchFailed?: boolean
  /** Error type string (e.g., 'schema_validation_failed', dispatch error message) */
  error?: string
  /** Raw agent output text — empty/undefined indicates no output was produced */
  rawOutput?: string
}

// ---------------------------------------------------------------------------
// DevStorySignals
// ---------------------------------------------------------------------------

/**
 * Slim projection of dev-story dispatch output needed by static verification.
 *
 * This intentionally mirrors the YAML output contract names while avoiding an
 * import from the monolith compiled-workflows package into @substrate-ai/sdlc.
 */
export interface DevStorySignals {
  /** Whether the implementation dispatch reported success or failure. */
  result?: 'success' | 'failed' | string
  /** Acceptance criteria the implementation agent claims were met. */
  ac_met?: string[]
  /** Acceptance criteria the implementation agent claims failed. */
  ac_failures?: string[]
  /** Files the implementation agent claims it created or modified. */
  files_modified?: string[]
  /** Test outcome reported by the implementation agent. */
  tests?: 'pass' | 'fail' | string
}

// ---------------------------------------------------------------------------
// VerificationContext
// ---------------------------------------------------------------------------

/**
 * Contextual data passed to each VerificationCheck when the pipeline runs.
 *
 * AC3: Contains storyKey, workingDir, commitSha, timeout, and optional priorStoryFiles.
 * Tier B fields (priorStoryFiles) are optional and may be undefined for Tier A runs.
 */
export interface VerificationContext {
  /** Story key being verified (e.g. "51-1"). */
  storyKey: string
  /** Absolute path to the project working directory. */
  workingDir: string
  /** Git commit SHA of the story's implementation commit. */
  commitSha: string
  /** Maximum milliseconds each individual check may consume. */
  timeout: number
  /** Optional list of file paths modified by prior stories (Tier B). */
  priorStoryFiles?: string[]
  /**
   * Optional code-review dispatch signals for PhantomReviewCheck (Story 51-2).
   *
   * Populated when the context is assembled from a completed code-review result.
   * Left as `undefined` when review data is not available (e.g., Tier B-only runs).
   * PhantomReviewCheck returns 'pass' with a skip note when this field is absent.
   */
  reviewResult?: ReviewSignals
  /**
   * Raw story markdown used by AcceptanceCriteriaEvidenceCheck.
   *
   * Left undefined when a caller cannot read the story file; the check reports
   * a warning rather than guessing from incomplete context.
   */
  storyContent?: string
  /**
   * Structured implementation output used by AcceptanceCriteriaEvidenceCheck.
   *
   * This is a narrow projection of the dev-story result so verification can
   * compare story ACs against the agent's explicit claims without importing
   * monolith workflow types.
   */
  devStoryResult?: DevStorySignals
  /**
   * Total output tokens produced by the story dispatch (Story 51-3).
   *
   * Used by TrivialOutputCheck to flag dispatches that produced fewer tokens
   * than the configured threshold. Left as `undefined` when token tracking
   * data is unavailable — TrivialOutputCheck returns 'warn' in that case.
   */
  outputTokenCount?: number
  /**
   * Optional explicit build command override for BuildCheck (Story 51-4).
   *
   * When provided, BuildCheck uses this exact command instead of auto-detecting
   * from the project files in `workingDir`. An empty string (`''`) means "skip"
   * (same behaviour as no build system detected — returns `warn`).
   * Left as `undefined` to trigger auto-detection.
   */
  buildCommand?: string
}

// ---------------------------------------------------------------------------
// VerificationResult and VerificationCheckResult
// ---------------------------------------------------------------------------

/**
 * Result returned by a single VerificationCheck.run() invocation.
 *
 * `details` is a human-readable rendering, preserved for any consumer that
 * already reads it. `findings` (story 55-1) is the structured per-issue
 * surface — downstream consumers (retry prompts, run manifest, post-run
 * analysis) should prefer it. Checks that emit findings should derive
 * `details` via `renderFindings(findings)` so the two stay in sync.
 */
export interface VerificationResult {
  status: 'pass' | 'warn' | 'fail'
  details: string
  duration_ms: number
  /** Structured per-issue payload. Optional for backward compatibility with
   * checks and consumers that pre-date story 55-1. */
  findings?: VerificationFinding[]
}

/**
 * Per-check result included in a VerificationSummary.
 * Extends VerificationResult with the check's name.
 */
export interface VerificationCheckResult extends VerificationResult {
  checkName: string
}

// ---------------------------------------------------------------------------
// VerificationSummary
// ---------------------------------------------------------------------------

/**
 * Aggregated summary for a single story's verification pipeline run.
 *
 * AC4: contains storyKey, array of per-check results, worst-case overall status,
 * and total duration.
 */
export interface VerificationSummary {
  storyKey: string
  checks: VerificationCheckResult[]
  /** Worst-case aggregate: fail > warn > pass. */
  status: 'pass' | 'warn' | 'fail'
  duration_ms: number
}

// ---------------------------------------------------------------------------
// VerificationCheck interface
// ---------------------------------------------------------------------------

/**
 * Interface that all verification check implementations must satisfy.
 *
 * AC1: name, tier ('A' | 'B'), and run(context) method.
 * Tier A checks are static analysis; Tier B checks may use cross-story context.
 */
export interface VerificationCheck {
  /** Human-readable identifier for this check (used in events and summaries). */
  name: string
  /** Tier determines execution order: all Tier A checks run before Tier B checks. */
  tier: 'A' | 'B'
  /**
   * Execute this check against the supplied verification context.
   * Must resolve (not reject) — exceptions are caught by the pipeline (AC6).
   */
  run(context: VerificationContext): Promise<VerificationResult>
}
