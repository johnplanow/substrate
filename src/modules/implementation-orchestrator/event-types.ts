/**
 * Pipeline event type definitions for the NDJSON event protocol.
 *
 * These types form a discriminated union `PipelineEvent` that is emitted
 * on stdout when `substrate run --events` is active.
 *
 * All events carry a `ts` ISO-8601 timestamp generated at emit time.
 */

// ---------------------------------------------------------------------------
// PipelineStartEvent
// ---------------------------------------------------------------------------

/**
 * Emitted as the first event when the pipeline begins.
 */
export interface PipelineStartEvent {
  type: 'pipeline:start'
  /** ISO-8601 timestamp generated at emit time */
  ts: string
  /** Unique identifier for this pipeline run */
  run_id: string
  /** Story keys being processed */
  stories: string[]
  /** Maximum parallel conflict groups */
  concurrency: number
}

// ---------------------------------------------------------------------------
// PipelineCompleteEvent
// ---------------------------------------------------------------------------

/**
 * Emitted as the last event when the pipeline finishes.
 */
export interface PipelineCompleteEvent {
  type: 'pipeline:complete'
  /** ISO-8601 timestamp generated at emit time */
  ts: string
  /** Story keys that completed successfully */
  succeeded: string[]
  /** Story keys that failed with an error */
  failed: string[]
  /** Story keys that were escalated (exhausted review cycles) */
  escalated: string[]
}

// ---------------------------------------------------------------------------
// StoryPhaseEvent
// ---------------------------------------------------------------------------

/**
 * Phase name for a story lifecycle transition.
 */
export type PipelinePhase = 'create-story' | 'dev-story' | 'code-review' | 'fix'

/**
 * Emitted when a story transitions into or out of a phase.
 */
export interface StoryPhaseEvent {
  type: 'story:phase'
  /** ISO-8601 timestamp generated at emit time */
  ts: string
  /** Story key (e.g., "10-1") */
  key: string
  /** The phase being transitioned */
  phase: PipelinePhase
  /** Whether the phase is starting, completing, or failed */
  status: 'in_progress' | 'complete' | 'failed'
  /** Code-review verdict (only present on code-review phase complete events) */
  verdict?: string
  /** Path to the generated story file (only present on create-story phase complete events) */
  file?: string
}

// ---------------------------------------------------------------------------
// StoryDoneEvent
// ---------------------------------------------------------------------------

/**
 * Emitted when a story reaches a terminal success state.
 */
export interface StoryDoneEvent {
  type: 'story:done'
  /** ISO-8601 timestamp generated at emit time */
  ts: string
  /** Story key (e.g., "10-1") */
  key: string
  /** Terminal result — always 'success' since failures go through story:escalation */
  result: 'success'
  /** Number of review cycles completed */
  review_cycles: number
}

// ---------------------------------------------------------------------------
// StoryEscalationEvent
// ---------------------------------------------------------------------------

/**
 * An individual issue from a code review, included in escalation events.
 */
export interface EscalationIssue {
  /** Issue severity */
  severity: 'blocker' | 'major' | 'minor' | 'unknown'
  /** File path where the issue was found */
  file: string
  /** Issue description */
  desc: string
}

/**
 * Emitted when a story is escalated after exhausting the maximum review cycles.
 */
export interface StoryEscalationEvent {
  type: 'story:escalation'
  /** ISO-8601 timestamp generated at emit time */
  ts: string
  /** Story key (e.g., "10-1") */
  key: string
  /** Human-readable escalation reason */
  reason: string
  /** Number of review cycles that occurred */
  cycles: number
  /** Issues list from the final review (may be empty) */
  issues: EscalationIssue[]
}

// ---------------------------------------------------------------------------
// StoryWarnEvent
// ---------------------------------------------------------------------------

/**
 * Emitted for non-fatal warnings during pipeline execution
 * (e.g., token ceiling truncation, partial batch failures).
 */
export interface StoryWarnEvent {
  type: 'story:warn'
  /** ISO-8601 timestamp generated at emit time */
  ts: string
  /** Story key (e.g., "10-1") */
  key: string
  /** Warning message */
  msg: string
}

// ---------------------------------------------------------------------------
// StoryLogEvent
// ---------------------------------------------------------------------------

/**
 * Emitted for informational messages during pipeline execution.
 */
export interface StoryLogEvent {
  type: 'story:log'
  /** ISO-8601 timestamp generated at emit time */
  ts: string
  /** Story key (e.g., "10-1") */
  key: string
  /** Log message */
  msg: string
}

// ---------------------------------------------------------------------------
// PipelineHeartbeatEvent
// ---------------------------------------------------------------------------

/**
 * Emitted periodically (every 30s) when no other progress events have fired.
 * Allows parent agents to distinguish "working silently" from "stuck".
 */
export interface PipelineHeartbeatEvent {
  type: 'pipeline:heartbeat'
  /** ISO-8601 timestamp generated at emit time */
  ts: string
  /** Unique identifier for the current pipeline run */
  run_id: string
  /** Number of sub-agent dispatches currently running */
  active_dispatches: number
  /** Number of dispatches that have completed */
  completed_dispatches: number
  /** Number of dispatches waiting to start */
  queued_dispatches: number
}

// ---------------------------------------------------------------------------
// StoryStallEvent
// ---------------------------------------------------------------------------

/**
 * Emitted when the watchdog timer detects no progress for an extended period.
 * Indicates a likely stall that may require operator intervention.
 */
export interface StoryStallEvent {
  type: 'story:stall'
  /** ISO-8601 timestamp generated at emit time */
  ts: string
  /** Unique identifier for the current pipeline run */
  run_id: string
  /** Story key that appears stalled */
  story_key: string
  /** Phase the story was in when the stall was detected */
  phase: string
  /** Milliseconds since the last progress event */
  elapsed_ms: number
}

// ---------------------------------------------------------------------------
// Supervisor events (emitted by `substrate supervisor`)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// SupervisorPollEvent
// ---------------------------------------------------------------------------

/**
 * Emitted after each `getHealth()` call in the supervisor poll loop.
 * Allows agents to observe health state, story progress, and token costs
 * on every cycle without needing a separate health query.
 */
export interface SupervisorPollEvent {
  type: 'supervisor:poll'
  /** ISO-8601 timestamp generated at emit time */
  ts: string
  /** Current pipeline run ID, or null if no run is active */
  run_id: string | null
  /** Health verdict from the most recent getHealth() call */
  verdict: 'HEALTHY' | 'STALLED' | 'NO_PIPELINE_RUNNING'
  /** Seconds since the last pipeline activity */
  staleness_seconds: number
  /** Story counts from the health snapshot */
  stories: { active: number; completed: number; escalated: number }
  /** Per-story phase and review cycle details */
  story_details: Record<string, { phase: string; review_cycles: number }>
  /** Cumulative token/cost snapshot for the current run */
  tokens: { input: number; output: number; cost_usd: number }
  /** Process health from the health snapshot */
  process: { orchestrator_pid: number | null; child_count: number; zombie_count: number }
}

/**
 * Emitted when the supervisor kills a stalled pipeline process tree.
 */
export interface SupervisorKillEvent {
  type: 'supervisor:kill'
  /** ISO-8601 timestamp generated at emit time */
  ts: string
  /** Pipeline run ID that was killed */
  run_id: string | null
  /** Reason for the kill — always 'stall' for threshold-triggered kills */
  reason: 'stall'
  /** Seconds the pipeline had been stalled */
  staleness_seconds: number
  /** PIDs that were killed (orchestrator + child processes) */
  pids: number[]
}

/**
 * Emitted when the supervisor restarts a killed pipeline.
 */
export interface SupervisorRestartEvent {
  type: 'supervisor:restart'
  /** ISO-8601 timestamp generated at emit time */
  ts: string
  /** Pipeline run ID being resumed */
  run_id: string | null
  /** Restart attempt number (1-based) */
  attempt: number
}

/**
 * Emitted when the supervisor exceeds the maximum restart limit and aborts.
 */
export interface SupervisorAbortEvent {
  type: 'supervisor:abort'
  /** ISO-8601 timestamp generated at emit time */
  ts: string
  /** Pipeline run ID that was abandoned */
  run_id: string | null
  /** Reason for aborting */
  reason: 'max_restarts_exceeded'
  /** Number of restart attempts that were made */
  attempts: number
}

/**
 * Emitted when the supervisor detects a terminal pipeline state and exits.
 */
export interface SupervisorSummaryEvent {
  type: 'supervisor:summary'
  /** ISO-8601 timestamp generated at emit time */
  ts: string
  /** Pipeline run ID */
  run_id: string | null
  /** Total elapsed seconds from supervisor start to terminal state */
  elapsed_seconds: number
  /** Story keys that completed successfully */
  succeeded: string[]
  /** Story keys that failed (non-COMPLETE, non-PENDING phases) */
  failed: string[]
  /** Story keys that were escalated */
  escalated: string[]
  /** Number of restart cycles performed by the supervisor */
  restarts: number
}

// ---------------------------------------------------------------------------
// SupervisorAnalysisCompleteEvent
// ---------------------------------------------------------------------------

/**
 * Emitted when the supervisor's post-run analysis finishes successfully.
 */
export interface SupervisorAnalysisCompleteEvent {
  type: 'supervisor:analysis:complete'
  /** ISO-8601 timestamp generated at emit time */
  ts: string
  /** Pipeline run ID that was analyzed */
  run_id: string | null
}

// ---------------------------------------------------------------------------
// SupervisorAnalysisErrorEvent
// ---------------------------------------------------------------------------

/**
 * Emitted when the supervisor's post-run analysis fails.
 */
export interface SupervisorAnalysisErrorEvent {
  type: 'supervisor:analysis:error'
  /** ISO-8601 timestamp generated at emit time */
  ts: string
  /** Pipeline run ID for which analysis was attempted */
  run_id: string | null
  /** Error message describing why analysis failed */
  error: string
}

// ---------------------------------------------------------------------------
// SupervisorExperimentStartEvent
// ---------------------------------------------------------------------------

/**
 * Emitted when the supervisor begins an experiment cycle.
 */
export interface SupervisorExperimentStartEvent {
  type: 'supervisor:experiment:start'
  /** ISO-8601 timestamp generated at emit time */
  ts: string
  /** Pipeline run ID being experimented on */
  run_id: string | null
}

// ---------------------------------------------------------------------------
// SupervisorExperimentSkipEvent
// ---------------------------------------------------------------------------

/**
 * Emitted when the supervisor skips an experiment cycle (no recommendations or no analysis report).
 */
export interface SupervisorExperimentSkipEvent {
  type: 'supervisor:experiment:skip'
  /** ISO-8601 timestamp generated at emit time */
  ts: string
  /** Pipeline run ID */
  run_id: string | null
  /** Why the experiment was skipped */
  reason: string
}

// ---------------------------------------------------------------------------
// SupervisorExperimentRecommendationsEvent
// ---------------------------------------------------------------------------

/**
 * Emitted when the supervisor discovers recommendations to experiment with.
 */
export interface SupervisorExperimentRecommendationsEvent {
  type: 'supervisor:experiment:recommendations'
  /** ISO-8601 timestamp generated at emit time */
  ts: string
  /** Pipeline run ID */
  run_id: string | null
  /** Number of recommendations found */
  count: number
}

// ---------------------------------------------------------------------------
// SupervisorExperimentCompleteEvent
// ---------------------------------------------------------------------------

/**
 * Emitted when the supervisor's experiment cycle completes.
 */
export interface SupervisorExperimentCompleteEvent {
  type: 'supervisor:experiment:complete'
  /** ISO-8601 timestamp generated at emit time */
  ts: string
  /** Pipeline run ID */
  run_id: string | null
  /** Number of experiments that resulted in improvement */
  improved: number
  /** Number of experiments with mixed results */
  mixed: number
  /** Number of experiments that caused regression */
  regressed: number
}

// ---------------------------------------------------------------------------
// SupervisorExperimentErrorEvent
// ---------------------------------------------------------------------------

/**
 * Emitted when the supervisor's experiment cycle fails.
 */
export interface SupervisorExperimentErrorEvent {
  type: 'supervisor:experiment:error'
  /** ISO-8601 timestamp generated at emit time */
  ts: string
  /** Pipeline run ID */
  run_id: string | null
  /** Error message describing why the experiment failed */
  error: string
}

// ---------------------------------------------------------------------------
// PipelineEvent discriminated union
// ---------------------------------------------------------------------------

/**
 * Discriminated union of all pipeline event types.
 *
 * Consumers can narrow the type with `event.type`:
 *
 * ```ts
 * const event: PipelineEvent = JSON.parse(line)
 * if (event.type === 'pipeline:start') {
 *   console.log(event.stories) // string[]
 * }
 * ```
 */
export type PipelineEvent =
  | PipelineStartEvent
  | PipelineCompleteEvent
  | StoryPhaseEvent
  | StoryDoneEvent
  | StoryEscalationEvent
  | StoryWarnEvent
  | StoryLogEvent
  | PipelineHeartbeatEvent
  | StoryStallEvent
  | SupervisorPollEvent
  | SupervisorKillEvent
  | SupervisorRestartEvent
  | SupervisorAbortEvent
  | SupervisorSummaryEvent
  | SupervisorAnalysisCompleteEvent
  | SupervisorAnalysisErrorEvent
  | SupervisorExperimentStartEvent
  | SupervisorExperimentSkipEvent
  | SupervisorExperimentRecommendationsEvent
  | SupervisorExperimentCompleteEvent
  | SupervisorExperimentErrorEvent

// ---------------------------------------------------------------------------
// Compile-time source of truth for all event type discriminants
//
// IMPORTANT: When adding a new member to the PipelineEvent union above,
// you MUST also add its `type` string here AND update PIPELINE_EVENT_METADATA
// in src/cli/commands/help-agent.ts. Tests import this array and verify that
// PIPELINE_EVENT_METADATA covers every entry, so omitting a value here (or
// from the metadata) will cause the test suite to fail immediately.
// ---------------------------------------------------------------------------

/**
 * Exhaustive list of all PipelineEvent `type` discriminant strings.
 *
 * Derived directly from the members of the PipelineEvent union. Used by
 * tests to ensure PIPELINE_EVENT_METADATA in help-agent.ts never falls
 * out of sync with the actual event type definitions.
 */
export const EVENT_TYPE_NAMES = [
  'pipeline:start',
  'pipeline:complete',
  'story:phase',
  'story:done',
  'story:escalation',
  'story:warn',
  'story:log',
  'pipeline:heartbeat',
  'story:stall',
  'supervisor:poll',
  'supervisor:kill',
  'supervisor:restart',
  'supervisor:abort',
  'supervisor:summary',
  'supervisor:analysis:complete',
  'supervisor:analysis:error',
  'supervisor:experiment:start',
  'supervisor:experiment:skip',
  'supervisor:experiment:recommendations',
  'supervisor:experiment:complete',
  'supervisor:experiment:error',
] as const

/**
 * TypeScript type derived from EVENT_TYPE_NAMES.
 */
export type PipelineEventType = (typeof EVENT_TYPE_NAMES)[number]

// Compile-time exhaustiveness check: the `type` discriminant of every
// PipelineEvent member must be assignable to PipelineEventType and vice-versa.
// If either side has a value the other lacks, this type becomes `never` and
// the line below produces a compile error.
type _AssertExhaustive = PipelineEvent['type'] extends PipelineEventType
  ? PipelineEventType extends PipelineEvent['type']
    ? true
    : never
  : never
