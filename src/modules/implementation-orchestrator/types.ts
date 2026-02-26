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
}
