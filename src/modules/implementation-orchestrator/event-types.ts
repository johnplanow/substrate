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
  /** Execution engine: 'linear' or 'graph' */
  engine?: string
  /** Persistence backend: 'dolt' or 'memory' — aids diagnosing data loss */
  adapter_backend?: string
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
// StoryAutoApprovedEvent
// ---------------------------------------------------------------------------

/**
 * Emitted when the orchestrator auto-approves a story after exhausting
 * review cycles with only minor issues remaining. Provides transparency
 * about why a NEEDS_MINOR_FIXES verdict resulted in COMPLETE status.
 */
export interface StoryAutoApprovedEvent {
  type: 'story:auto-approved'
  /** ISO-8601 timestamp generated at emit time */
  ts: string
  /** Story key (e.g., "10-1") */
  key: string
  /** Final review verdict (always NEEDS_MINOR_FIXES for auto-approve) */
  verdict: string
  /** Number of review cycles completed */
  review_cycles: number
  /** Maximum review cycles configured */
  max_review_cycles: number
  /** Number of remaining issues at auto-approve time */
  issue_count: number
  /** Human-readable reason for auto-approval */
  reason: string
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
// StoryZeroDiffEscalationEvent
// ---------------------------------------------------------------------------

/**
 * Emitted when a dev-story agent reported COMPLETE but git diff shows no
 * file changes in the working tree (phantom completion — Story 24-1).
 */
export interface StoryZeroDiffEscalationEvent {
  type: 'story:zero-diff-escalation'
  /** ISO-8601 timestamp generated at emit time */
  ts: string
  /** Story key (e.g., "10-1") */
  storyKey: string
  /** Always "zero-diff-on-complete" */
  reason: string
}

// ---------------------------------------------------------------------------
// PipelinePreFlightFailureEvent
// ---------------------------------------------------------------------------

/**
 * Emitted when the pre-flight build check fails before any story is dispatched (Story 25-2).
 * Pipeline aborts immediately — no stories are processed.
 */
export interface PipelinePreFlightFailureEvent {
  type: 'pipeline:pre-flight-failure'
  /** ISO-8601 timestamp generated at emit time */
  ts: string
  /** Exit code from the build command (-1 for timeout) */
  exitCode: number
  /** Combined stdout+stderr output, truncated to 2000 chars */
  output: string
}

// ---------------------------------------------------------------------------
// StoryBuildVerificationFailedEvent
// ---------------------------------------------------------------------------

/**
 * Emitted when the build verification command exits with a non-zero code
 * or times out, before code-review is dispatched (Story 24-2).
 */
export interface StoryBuildVerificationFailedEvent {
  type: 'story:build-verification-failed'
  /** ISO-8601 timestamp generated at emit time */
  ts: string
  /** Story key (e.g., "24-2") */
  storyKey: string
  /** Exit code from the build command (-1 for timeout) */
  exitCode: number
  /** Combined stdout+stderr output, truncated to 2000 chars */
  output: string
}

// ---------------------------------------------------------------------------
// StoryBuildVerificationPassedEvent
// ---------------------------------------------------------------------------

/**
 * Emitted when the build verification command exits with code 0 (Story 24-2).
 */
export interface StoryBuildVerificationPassedEvent {
  type: 'story:build-verification-passed'
  /** ISO-8601 timestamp generated at emit time */
  ts: string
  /** Story key (e.g., "24-2") */
  storyKey: string
}

// ---------------------------------------------------------------------------
// StoryInterfaceChangeWarningEvent
// ---------------------------------------------------------------------------

/**
 * Emitted (non-blocking) when a dev-story modifies .ts files that export
 * shared TypeScript interfaces or types, and those names are referenced by
 * test files outside the same module.
 *
 * Signals potential stale-mock risk. The story still proceeds to code-review.
 * (Story 24-3)
 */
export interface StoryInterfaceChangeWarningEvent {
  type: 'story:interface-change-warning'
  /** ISO-8601 timestamp generated at emit time */
  ts: string
  /** Story key (e.g., "24-3") */
  storyKey: string
  /** Exported interface/type names found in modified files */
  modifiedInterfaces: string[]
  /** Test file paths (relative to project root) that reference the modified interface names */
  potentiallyAffectedTests: string[]
}

// ---------------------------------------------------------------------------
// StoryMetricsEvent
// ---------------------------------------------------------------------------

/**
 * Emitted when a story reaches a terminal state (COMPLETE, ESCALATED, or
 * max retries), providing a metrics snapshot for observability (Story 24-4).
 */
export interface StoryMetricsEvent {
  type: 'story:metrics'
  /** ISO-8601 timestamp generated at emit time */
  ts: string
  /** Story key (e.g., "24-4") */
  storyKey: string
  /** Total wall-clock duration in milliseconds */
  wallClockMs: number
  /** Per-phase duration in milliseconds: phase name → ms */
  phaseBreakdown: Record<string, number>
  /** Token counts from the adapter (accumulated across all dispatches) */
  tokens: { input: number; output: number }
  /** Number of code-review cycles completed */
  reviewCycles: number
  /** Total number of agent dispatches for this story */
  dispatches: number
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
 * Snapshot entry for a single story within a heartbeat event.
 * Both fields are strings so the event schema stays language-agnostic.
 *
 * - `phase`  — raw orchestrator StoryPhase value (e.g. 'IN_DEV', 'COMPLETE').
 * - `status` — consumer-facing status derived from phase (e.g. 'dispatched', 'complete').
 *
 * Story 66-2: obs_2026-05-03_022 fix #2.
 */
export type HeartbeatStorySnapshot = { phase: string; status: string }

/**
 * Emitted periodically (every 30s) when no other progress events have fired.
 * Allows parent agents to distinguish "working silently" from "stuck".
 *
 * Story 66-2: gains optional `per_story_state` field for real-time drift detection
 * between in-memory orchestrator state and the persisted manifest (obs_2026-05-03_022 fix #2).
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
  /**
   * Snapshot of in-memory phase and derived status for each story.
   * Omitted (or empty object) when no stories are dispatched.
   * Additive and optional — existing heartbeat consumers require no changes.
   * Story 66-2: obs_2026-05-03_022 fix #2.
   */
  per_story_state?: Record<string, HeartbeatStorySnapshot>
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
  /** PIDs of child processes at time of stall detection */
  child_pids: number[]
  /** Whether any child process was actively running (not zombie) */
  child_active: boolean
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
// PipelineProfileStaleEvent
// ---------------------------------------------------------------------------

/**
 * Emitted after all stories complete when the `.substrate/project-profile.yaml`
 * may be outdated relative to the actual project structure (e.g., profile says
 * `type: single` but a `turbo.json` now exists, or new language markers appeared).
 *
 * Non-blocking warning — the pipeline has already finished. The user should
 * re-run `substrate init --force` to regenerate the profile.
 */
export interface PipelineProfileStaleEvent {
  type: 'pipeline:profile-stale'
  /** ISO-8601 timestamp generated at emit time */
  ts: string
  /** Human-readable message describing the staleness indicators found */
  message: string
  /** List of staleness indicators detected (e.g., "turbo.json exists but profile says type: single") */
  indicators: string[]
}

// ---------------------------------------------------------------------------
// PipelineContractMismatchEvent
// ---------------------------------------------------------------------------

/**
 * Emitted when post-sprint contract verification finds a mismatch between
 * declared export/import contracts (Story 25-6).
 *
 * Failures are warnings only — stories already completed. The user should
 * inspect the mismatch and fix manually.
 */
export interface PipelineContractMismatchEvent {
  type: 'pipeline:contract-mismatch'
  /** ISO-8601 timestamp generated at emit time */
  ts: string
  /** Story key that declared the export for this contract */
  exporter: string
  /** Story key that declared the import for this contract (null if no importer found) */
  importer: string | null
  /** TypeScript interface or Zod schema name (e.g., "JudgeResult") */
  contractName: string
  /** Human-readable description of the mismatch (e.g., missing file, type error) */
  mismatchDescription: string
}

// ---------------------------------------------------------------------------
// PipelineContractVerificationSummaryEvent
// ---------------------------------------------------------------------------

/**
 * Emitted once after post-sprint contract verification completes.
 * Consolidates results into a single event instead of per-mismatch noise.
 */
export interface PipelineContractVerificationSummaryEvent {
  type: 'pipeline:contract-verification-summary'
  /** ISO-8601 timestamp generated at emit time */
  ts: string
  /** Number of contract declarations verified (current sprint only) */
  verified: number
  /** Number of stale declarations pruned (from previous epics) */
  stalePruned: number
  /** Number of real mismatches found */
  mismatches: number
  /** 'pass' if zero mismatches, 'fail' otherwise */
  verdict: 'pass' | 'fail'
}

// ---------------------------------------------------------------------------
// RoutingModelSelectedEvent
// ---------------------------------------------------------------------------

/**
 * Emitted when the RoutingResolver selects a model for a dispatch.
 */
export interface RoutingModelSelectedEvent {
  type: 'routing:model-selected'
  /** ISO-8601 timestamp generated at emit time */
  ts: string
  /** Unique dispatch ID */
  dispatch_id: string
  /** Task type (e.g. 'dev-story', 'test-plan', 'code-review') */
  task_type: string
  /** Routing phase that matched (e.g. 'generate', 'explore', 'review') */
  phase: string
  /** Selected model ID */
  model: string
  /** How the model was selected: 'phase', 'baseline', 'override' */
  source: string
}

// ---------------------------------------------------------------------------
// PipelinePhaseStartEvent (Story 39-1)
// ---------------------------------------------------------------------------

/**
 * Emitted when a pipeline phase starts during full pipeline execution.
 */
export interface PipelinePhaseStartEvent {
  type: 'pipeline:phase-start'
  /** ISO-8601 timestamp generated at emit time */
  ts: string
  /** Phase name (e.g., 'analysis', 'implementation') */
  phase: string
}

// ---------------------------------------------------------------------------
// PipelinePhaseCompleteEvent (Story 39-1)
// ---------------------------------------------------------------------------

/**
 * Emitted when a pipeline phase completes during full pipeline execution.
 */
export interface PipelinePhaseCompleteEvent {
  type: 'pipeline:phase-complete'
  /** ISO-8601 timestamp generated at emit time */
  ts: string
  /** Phase name (e.g., 'analysis', 'implementation') */
  phase: string
}

// ---------------------------------------------------------------------------
// VerificationCheckCompleteEvent (Story 51-6)
// ---------------------------------------------------------------------------

/**
 * Emitted after each individual Tier A verification check completes (Story 51-6).
 * Payload mirrors the SdlcEvents 'verification:check-complete' payload plus ts timestamp.
 */
export interface VerificationCheckCompleteEvent {
  type: 'verification:check-complete'
  /** ISO-8601 timestamp generated at emit time */
  ts: string
  /** Story key (e.g., "51-5") */
  storyKey: string
  /** Check name (e.g., "phantom-review", "trivial-output", "build") */
  checkName: string
  /** Check result status */
  status: 'pass' | 'warn' | 'fail'
  /** Human-readable details from the check */
  details: string
  /** Check execution time in milliseconds */
  duration_ms: number
}

// ---------------------------------------------------------------------------
// VerificationStoryCompleteEvent (Story 51-6)
// ---------------------------------------------------------------------------

/**
 * Emitted once per story after all Tier A verification checks complete (Story 51-6).
 * Payload is the full VerificationSummary shape plus ts timestamp.
 */
export interface VerificationStoryCompleteEvent {
  type: 'verification:story-complete'
  /** ISO-8601 timestamp generated at emit time */
  ts: string
  /** Story key (e.g., "51-5") */
  storyKey: string
  /** Per-check results */
  checks: Array<{
    checkName: string
    status: 'pass' | 'warn' | 'fail'
    details: string
    duration_ms: number
  }>
  /** Aggregated worst-case status across all checks */
  status: 'pass' | 'warn' | 'fail'
  /** Total duration of all checks in milliseconds */
  duration_ms: number
}

// ---------------------------------------------------------------------------
// CostWarningEvent (Story 53-3: cost governance events)
// ---------------------------------------------------------------------------

/**
 * Emitted at most once per run when cumulative pipeline cost crosses 80% of
 * the --cost-ceiling threshold.
 */
export interface CostWarningEvent {
  type: 'cost:warning'
  /** ISO-8601 timestamp generated at emit time */
  ts: string
  /** Cumulative pipeline cost in USD at the time of the check */
  cumulative_cost: number
  /** Configured cost ceiling in USD */
  ceiling: number
  /** (cumulative / ceiling) * 100, rounded to two decimal places */
  percent_used: number
}

// ---------------------------------------------------------------------------
// CostCeilingReachedEvent (Story 53-3: cost governance events)
// ---------------------------------------------------------------------------

/**
 * Emitted between story dispatches when cumulative cost ≥ 100% of the
 * --cost-ceiling. Remaining undispatched stories are skipped.
 */
export interface CostCeilingReachedEvent {
  type: 'cost:ceiling-reached'
  /** ISO-8601 timestamp generated at emit time */
  ts: string
  /** Cumulative pipeline cost in USD at the time of the check */
  cumulative_cost: number
  /** Configured cost ceiling in USD */
  ceiling: number
  /** --halt-on value in effect ('none', 'all', or 'critical') */
  halt_on: string
  /** 'stopped' for all halt-on modes in this story; interactive prompt is Epic 54 scope */
  action: string
  /** Story keys skipped because budget was exhausted */
  skipped_stories: string[]
  /** 'critical' when halt_on is 'all' or 'critical'; absent when 'none' */
  severity?: string
}

// ---------------------------------------------------------------------------
// DecisionHaltSkippedNonInteractiveEvent (Story 72-2)
// ---------------------------------------------------------------------------

/**
 * Emitted when --non-interactive mode suppresses a halt decision and applies
 * the default action autonomously instead of prompting the operator.
 *
 * Story 72-2: closes the NDJSON protocol gap — operators can see which halts
 * were auto-skipped and what actions were applied via `substrate report`.
 */
export interface DecisionHaltSkippedNonInteractiveEvent {
  type: 'decision:halt-skipped-non-interactive'
  /** ISO-8601 timestamp generated at emit time */
  ts: string
  /** Pipeline run ID */
  run_id: string
  /** Halt decision type that was skipped (e.g., 'halt:escalation', 'cost-ceiling-exhausted') */
  decision_type: string
  /** Severity of the skipped halt (e.g., 'critical') */
  severity: string
  /** Action that was applied in place of the operator prompt (e.g., 'continue-autonomous') */
  default_action: string
  /** Human-readable reason for skipping */
  reason: string
}

// ---------------------------------------------------------------------------
// PipelineMergeConflictDetectedEvent (Story 75-2)
// ---------------------------------------------------------------------------

/**
 * Emitted when a 3-way merge fails due to conflicts between the story branch
 * and the base branch (typically main). The worktree and branch are preserved
 * for operator inspection. Story 75-2 (merge-to-main phase).
 */
export interface PipelineMergeConflictDetectedEvent {
  type: 'pipeline:merge-conflict-detected'
  /** ISO-8601 timestamp generated at emit time */
  ts: string
  /** Story key whose branch could not be merged (e.g., "75-2") */
  storyKey: string
  /** Branch name that was being merged (e.g., "substrate/story-75-2") */
  branchName: string
  /** Files with unresolved merge conflicts */
  conflictingFiles: string[]
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
  | PipelinePreFlightFailureEvent
  | PipelineProfileStaleEvent
  | PipelineContractMismatchEvent
  | PipelineContractVerificationSummaryEvent
  | StoryPhaseEvent
  | StoryDoneEvent
  | StoryEscalationEvent
  | StoryWarnEvent
  | StoryLogEvent
  | PipelineHeartbeatEvent
  | StoryStallEvent
  | StoryZeroDiffEscalationEvent
  | StoryBuildVerificationFailedEvent
  | StoryBuildVerificationPassedEvent
  | StoryInterfaceChangeWarningEvent
  | StoryMetricsEvent
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
  | RoutingModelSelectedEvent
  | PipelinePhaseStartEvent
  | PipelinePhaseCompleteEvent
  | StoryAutoApprovedEvent
  | VerificationCheckCompleteEvent
  | VerificationStoryCompleteEvent
  | CostWarningEvent
  | CostCeilingReachedEvent
  | DecisionHaltSkippedNonInteractiveEvent
  | PipelineMergeConflictDetectedEvent

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
  // Story 25-2: pre-flight build gate failure (pipeline-level abort)
  'pipeline:pre-flight-failure',
  // Post-run profile staleness warning (non-blocking)
  'pipeline:profile-stale',
  // Story 25-6: post-sprint contract verification mismatch (non-blocking warning)
  'pipeline:contract-mismatch',
  // Post-sprint contract verification summary (consolidated result)
  'pipeline:contract-verification-summary',
  'story:phase',
  'story:done',
  'story:escalation',
  'story:warn',
  'story:log',
  'pipeline:heartbeat',
  'story:stall',
  'story:zero-diff-escalation',
  // Story 24-2: build verification gate events
  'story:build-verification-failed',
  'story:build-verification-passed',
  // Story 24-3: interface change warning (non-blocking)
  'story:interface-change-warning',
  // Story 24-4: per-story metrics snapshot on terminal state
  'story:metrics',
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
  // Auto-approve transparency event
  'story:auto-approved',
  // Epic 28: model routing observability
  'routing:model-selected',
  // Story 39-1: full pipeline phase lifecycle events
  'pipeline:phase-start',
  'pipeline:phase-complete',
  // Story 51-6: verification pipeline events
  'verification:check-complete',
  'verification:story-complete',
  // Story 53-3: cost governance events
  'cost:warning',
  'cost:ceiling-reached',
  // Story 72-2: non-interactive halt-skipped decision event
  'decision:halt-skipped-non-interactive',
  // Story 75-2: merge-to-main conflict detection
  'pipeline:merge-conflict-detected',
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
