/**
 * Types and enums for the Implementation Orchestrator module.
 *
 * Defines the orchestrator state machine, story lifecycle states,
 * configuration, and status reporting structures.
 */

// ---------------------------------------------------------------------------
// Orchestrator state
// ---------------------------------------------------------------------------

/**
 * Overall state of the orchestrator run.
 */
export type OrchestratorState = 'IDLE' | 'RUNNING' | 'PAUSED' | 'COMPLETE' | 'FAILED'

// ---------------------------------------------------------------------------
// Story phase
// ---------------------------------------------------------------------------

/**
 * Lifecycle phase of an individual story within the pipeline.
 */
export type StoryPhase =
  | 'PENDING'
  | 'IN_STORY_CREATION'
  | 'IN_TEST_PLANNING'
  | 'IN_DEV'
  | 'IN_REVIEW'
  | 'NEEDS_FIXES'
  | 'COMPLETE'
  | 'ESCALATED'

// ---------------------------------------------------------------------------
// StoryState
// ---------------------------------------------------------------------------

/**
 * Per-story tracking state within an orchestrator run.
 */
export interface StoryState {
  /** Current lifecycle phase of this story */
  phase: StoryPhase
  /** Number of code review cycles completed for this story */
  reviewCycles: number
  /** Last verdict from code review (if any) */
  lastVerdict?: string
  /** Error message if this story encountered a fatal error */
  error?: string
  /** ISO timestamp when this story's processing started */
  startedAt?: string
  /** ISO timestamp when this story's processing completed or was escalated */
  completedAt?: string
}

// ---------------------------------------------------------------------------
// OrchestratorConfig
// ---------------------------------------------------------------------------

/**
 * Configuration for an orchestrator run.
 */
export interface OrchestratorConfig {
  /** Maximum number of conflict groups running in parallel */
  maxConcurrency: number
  /** Maximum number of code review cycles per story before escalation */
  maxReviewCycles: number
  /** Optional pipeline run ID for state persistence */
  pipelineRunId?: string
  /**
   * Whether to enable the heartbeat/watchdog timer.
   * Should only be true when --events mode is active; otherwise the timer
   * fires and emits eventBus events with no listeners, wasting CPU.
   * Defaults to false.
   */
  enableHeartbeat?: boolean
  /**
   * Duration (ms) of the pause inserted after each story for GC hint.
   * Default: 2000 ms (Story 23-8, AC2).
   * Set to 0 in tests to avoid 2-second delays per story.
   */
  gcPauseMs?: number
  /**
   * When true, skip the pre-flight build check (Story 25-2).
   * Escape hatch for known-broken projects. Pass `--skip-preflight` from CLI.
   */
  skipPreflight?: boolean
  /**
   * When true, skip per-story post-dev build verification (Story 24-2).
   * Independent from skipPreflight — pre-flight checks "can this project build
   * at all?" while per-story checks "did this story break the build?".
   */
  skipBuildVerify?: boolean
}

// ---------------------------------------------------------------------------
// DecompositionMetrics
// ---------------------------------------------------------------------------

/**
 * Decomposition metrics emitted when a story is dispatched via batched dev-story.
 * Absent for non-decomposed (simple) stories — AC6: clean output for simple stories.
 */
export interface DecompositionMetrics {
  /** Total number of tasks identified in the story */
  totalTasks: number
  /** Number of batches the tasks were split into */
  batchCount: number
  /** Number of tasks per batch, in dispatch order */
  batchSizes: number[]
}

// ---------------------------------------------------------------------------
// PerBatchMetrics
// ---------------------------------------------------------------------------

/**
 * Per-batch telemetry logged during the batched dev-story dispatch loop.
 * Logged at INFO level for each batch dispatched (AC2).
 */
export interface PerBatchMetrics {
  /** Zero-based index of this batch */
  batchIndex: number
  /** Task IDs included in this batch */
  taskIds: number[]
  /** Token usage from this batch dispatch */
  tokensUsed: { input: number; output: number }
  /** Wall-clock duration of this batch dispatch in milliseconds */
  durationMs: number
  /** Files reported as modified by this batch */
  filesModified: string[]
  /** Whether this batch completed successfully or failed */
  result: 'success' | 'failed'
}

// ---------------------------------------------------------------------------
// OrchestratorStatus
// ---------------------------------------------------------------------------

/**
 * Full status snapshot of the orchestrator and all managed stories.
 */
export interface OrchestratorStatus {
  /** Current state of the orchestrator */
  state: OrchestratorState
  /** Per-story state keyed by story key */
  stories: Record<string, StoryState>
  /** ISO timestamp when run() was called */
  startedAt?: string
  /** ISO timestamp when orchestrator reached COMPLETE or FAILED */
  completedAt?: string
  /** Total elapsed milliseconds (only set when completedAt is set) */
  totalDurationMs?: number
  /**
   * Decomposition metrics for the most recent pipeline run.
   * Present only when at least one story was decomposed into batches (AC1).
   * Absent for simple (non-decomposed) stories (AC6).
   */
  decomposition?: DecompositionMetrics
  /**
   * Peak number of conflict groups running concurrently during this run.
   * Always <= maxConcurrency and <= total group count.
   */
  maxConcurrentActual?: number
  /**
   * Contract verification warnings from the post-sprint gate (Story 25-6).
   * Present when one or more declared export/import contracts failed verification.
   * Failures are non-blocking — stories already completed.
   */
  contractMismatches?: ContractMismatch[]
}

// ---------------------------------------------------------------------------
// ContractMismatch
// ---------------------------------------------------------------------------

/**
 * A single contract verification failure from the post-sprint gate (Story 25-6).
 */
export interface ContractMismatch {
  /** Story key that declared the export */
  exporter: string
  /** Story key that declared the import (null if no importer found) */
  importer: string | null
  /** Contract name (TypeScript interface or Zod schema name) */
  contractName: string
  /** Human-readable description of the mismatch */
  mismatchDescription: string
}
