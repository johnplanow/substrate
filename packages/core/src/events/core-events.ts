/**
 * CoreEvents — typed event map for all core infrastructure events.
 *
 * Contains all events that are NOT SDLC-specific (no orchestrator:story-*, plan:*,
 * solutioning:*, story:*, pipeline:* events). Those belong in SdlcEvents.
 *
 * Payload shapes are copied verbatim from src/core/event-bus.types.ts (monolith source).
 */

import type { SubstrateConfig } from '../config/types.js'
import type { RoutingDecision } from '../routing/routing-decision.js'

// ---------------------------------------------------------------------------
// Shared payload subtypes
// ---------------------------------------------------------------------------

/** Unique task identifier */
export type TaskId = string

/** Unique worker identifier */
export type WorkerId = string

/** Result of a completed task */
export interface EventTaskResult {
  output?: string
  exitCode?: number
  tokensUsed?: number
  inputTokens?: number
  outputTokens?: number
  durationMs?: number
  costUsd?: number
  agent?: string
}

/** Error payload for a failed task */
export interface EventTaskError {
  message: string
  code?: string
  stack?: string
}

// ---------------------------------------------------------------------------
// CoreEvents
// ---------------------------------------------------------------------------

/**
 * Typed map of all core infrastructure events.
 * SDLC-specific events (orchestrator:story-*, plan:*, solutioning:*, story:*, pipeline:*)
 * are excluded and belong to SdlcEvents.
 */
export interface CoreEvents {
  // -------------------------------------------------------------------------
  // Task lifecycle events
  // -------------------------------------------------------------------------

  /** Task has all dependencies satisfied and is ready to be assigned */
  'task:ready': { taskId: TaskId; taskType?: string }

  /** A worker has begun execution of a task */
  'task:started': { taskId: TaskId; workerId: WorkerId; agent: string }

  /** Incremental progress report from a running task */
  'task:progress': { taskId: TaskId; message: string; tokensUsed?: number }

  /** Task has completed successfully */
  'task:complete': { taskId: TaskId; result: EventTaskResult; taskType?: string }

  /** Task has failed with an error */
  'task:failed': { taskId: TaskId; error: EventTaskError }

  /** Task was cancelled */
  'task:cancelled': { taskId: TaskId; reason: string }

  /** Task is being retried after a failure */
  'task:retrying': { taskId: TaskId; attempt: number; maxAttempts: number }

  /** A task has been routed to an agent with billing mode decision */
  'task:routed': { taskId: TaskId; decision: RoutingDecision }

  /** Budget cap has been set for a task */
  'task:budget-set': { taskId: TaskId; budgetUsd: number }

  // -------------------------------------------------------------------------
  // Worker lifecycle events
  // -------------------------------------------------------------------------

  /** A worker subprocess was spawned */
  'worker:spawned': { workerId: WorkerId; taskId: TaskId; agent: string }

  /** A worker subprocess was terminated */
  'worker:terminated': { workerId: WorkerId; reason: string }

  // -------------------------------------------------------------------------
  // Budget events
  // -------------------------------------------------------------------------

  /** Spending is approaching the configured budget limit */
  'budget:warning': { taskId: TaskId; currentSpend: number; limit: number }

  /** Spending has exceeded the configured budget limit */
  'budget:exceeded': { taskId: TaskId; spend: number; limit: number }

  /** Task is approaching its budget cap (80% threshold) */
  'budget:warning:task': { taskId: TaskId; currentCostUsd: number; budgetUsd: number; percentageUsed: number }

  /** Task has exceeded its budget cap — force-terminate worker */
  'budget:exceeded:task': { taskId: TaskId; currentCostUsd: number; budgetUsd: number }

  /** Session-wide budget is approaching the cap (80% threshold) */
  'budget:warning:session': { sessionId: string; currentCostUsd: number; budgetUsd: number; percentageUsed: number }

  /** Session-wide budget has been exceeded — terminate all workers */
  'session:budget:exceeded': { sessionId: string; currentCostUsd: number; budgetUsd: number }

  /** Budget cap has been set for a session */
  'session:budget-set': { sessionId: string; budgetUsd: number }

  // -------------------------------------------------------------------------
  // Graph lifecycle events (task-graph dispatcher)
  // -------------------------------------------------------------------------

  /** A task graph has been loaded and validated */
  'graph:loaded': { sessionId: string; taskCount: number; readyCount: number }

  /** All tasks in the graph have completed or failed */
  'graph:complete': {
    totalTasks: number
    completedTasks: number
    failedTasks: number
    totalCostUsd: number
  }

  /** Graph execution was cancelled */
  'graph:cancelled': { cancelledTasks: number }

  /** Graph execution was paused */
  'graph:paused': Record<string, never>

  /** Graph execution was resumed */
  'graph:resumed': Record<string, never>

  // -------------------------------------------------------------------------
  // Git worktree events
  // -------------------------------------------------------------------------

  /** A git worktree was created for a task */
  'worktree:created': {
    taskId: TaskId
    branchName: string
    worktreePath: string
    createdAt?: Date
  }

  /** A task's worktree branch was merged */
  'worktree:merged': { taskId: TaskId; branch: string; mergedFiles: string[] }

  /** A merge conflict was detected in a task's worktree */
  'worktree:conflict': { taskId: TaskId; branch: string; conflictingFiles: string[] }

  /** A task's worktree was removed */
  'worktree:removed': { taskId: TaskId; branchName: string }

  // -------------------------------------------------------------------------
  // Cost tracker events
  // -------------------------------------------------------------------------

  /** A task's cost has been recorded by the cost tracker */
  'cost:recorded': {
    taskId: string
    sessionId: string
    costUsd: number
    savingsUsd: number
    billingMode: 'subscription' | 'api'
  }

  // -------------------------------------------------------------------------
  // Monitor events
  // -------------------------------------------------------------------------

  /** A task's metrics have been recorded by the monitor */
  'monitor:metrics_recorded': { taskId: string; agent: string; taskType: string }

  /** A routing recommendation has been generated by the monitor */
  'monitor:recommendation_generated': { taskType: string; recommendedAgent: string; confidence: number }

  // -------------------------------------------------------------------------
  // Config events
  // -------------------------------------------------------------------------

  /** Configuration has been reloaded */
  'config:reloaded': {
    path: string
    previousConfig: SubstrateConfig
    newConfig: SubstrateConfig
    changedKeys: string[]
  }

  // -------------------------------------------------------------------------
  // Routing events
  // -------------------------------------------------------------------------

  /**
   * Emitted when a sub-agent dispatch is resolved to a specific model via RoutingResolver.
   */
  'routing:model-selected': {
    dispatchId: string
    taskType: string
    phase: string
    model: string
    source: 'phase' | 'override'
  }

  /**
   * Emitted by RoutingTuner when it successfully applies an auto-tune downgrade.
   */
  'routing:auto-tuned': {
    runId: string
    phase: string
    oldModel: string
    newModel: string
    estimatedSavingsPct: number
  }

  // -------------------------------------------------------------------------
  // Provider events
  // -------------------------------------------------------------------------

  /** A provider has become unavailable */
  'provider:unavailable': { provider: string; reason: 'rate_limit' | 'disabled'; resetAtMs?: number }

  /** A provider has become available */
  'provider:available': { provider: string }

  // -------------------------------------------------------------------------
  // Version events
  // -------------------------------------------------------------------------

  /** A newer version of the toolkit is available */
  'version:update_available': { currentVersion: string; latestVersion: string; breaking: boolean }

  // -------------------------------------------------------------------------
  // Agent dispatch events
  // -------------------------------------------------------------------------

  /** A sub-agent subprocess was spawned by the dispatch engine */
  'agent:spawned': { dispatchId: string; agent: string; taskType: string }

  /** Incremental stdout data received from a running sub-agent */
  'agent:output': { dispatchId: string; data: string }

  /** A sub-agent completed successfully */
  'agent:completed': {
    dispatchId: string
    exitCode: number
    output: string
    /** Estimated input tokens (char-length heuristic) */
    inputTokens?: number
    /** Estimated output tokens (char-length heuristic) */
    outputTokens?: number
  }

  /** A sub-agent exited with a non-zero code or encountered an error */
  'agent:failed': { dispatchId: string; error: string; exitCode: number }

  /** A sub-agent was killed because it exceeded its timeout */
  'agent:timeout': { dispatchId: string; timeoutMs: number }

  /**
   * A dispatch was killed by the timeout handler.
   * Emitted for both the initial attempt (attemptNumber: 1) and the retry
   * attempt (attemptNumber: 2, 1.5× the initial timeout).
   * Story 66-4: closes obs_2026-05-04_023 fix #3.
   * Story 66-5: adds stderrTail/stdoutTail forensic capture
   * (obs_2026-05-04_023 fix #4). Optional for backward-compat.
   */
  'dispatch:spawnsync-timeout': {
    type: 'dispatch:spawnsync-timeout'
    storyKey: string
    taskType: string
    attemptNumber: 1 | 2
    timeoutMs: number
    elapsedAtKill: number
    pid?: number
    occurredAt: string
    /** Tail of subprocess stderr captured at kill time (~64KB max, UTF-8) */
    stderrTail?: string
    /** Tail of subprocess stdout captured at kill time (~64KB max, UTF-8) */
    stdoutTail?: string
  }

  // -------------------------------------------------------------------------
  // Cross-story file collision events (Story 68-1)
  // -------------------------------------------------------------------------

  /**
   * Two or more concurrent stories have overlapping target file paths.
   * Motivating incidents: Epic 66 run a832487a + Epic 67 run a59e4c96
   * (concurrent-dispatch races that caused transient verification failures).
   * Mirror of OrchestratorEvents['dispatch:cross-story-file-collision'];
   * both must stay in sync.
   */
  'dispatch:cross-story-file-collision': {
    storyKeys: string[]
    collisionPaths: string[]
    recommendedAction: 'serialize' | 'warn'
  }

  // -------------------------------------------------------------------------
  // Cross-story race recovery events (Story 70-1)
  // Motivating incidents: Epic 66 (run a832487a), Epic 67 (run a59e4c96) —
  // concurrent-dispatch races where story B's commit landed after story A's
  // verification ran, producing a false verification failure on A.
  // -------------------------------------------------------------------------

  /**
   * Cross-story race recovery succeeded: fresh verification passed for a story
   * whose original verification result was recorded before a concurrent story's
   * commit landed on overlapping files.
   *
   * Story 70-1. Motivating incidents: Epic 66 (run a832487a), Epic 67 (run a59e4c96).
   * Mirror of OrchestratorEvents['pipeline:cross-story-race-recovered'];
   * both must stay in sync.
   */
  'pipeline:cross-story-race-recovered': {
    runId: string
    storyKey: string
    originalFindings: unknown[]
    freshFindings: unknown[]
    recoveryDurationMs: number
  }

  /**
   * Cross-story race recovery completed but fresh verification still failed:
   * the story genuinely has issues that are not attributable to the race condition.
   *
   * Story 70-1. Motivating incidents: Epic 66 (run a832487a), Epic 67 (run a59e4c96).
   * Mirror of OrchestratorEvents['pipeline:cross-story-race-still-failed'];
   * both must stay in sync.
   */
  'pipeline:cross-story-race-still-failed': {
    runId: string
    storyKey: string
    freshFindings: unknown[]
    recoveryDurationMs: number
  }

  // -------------------------------------------------------------------------
  // Merge-to-main events (Story 75-2)
  // -------------------------------------------------------------------------
  //
  // payload: { storyKey: string; branchName: string; conflictingFiles: string[] }
  //
  // PipelineMergeConflictDetectedEvent is defined as a PipelineEvent member in
  // src/modules/implementation-orchestrator/event-types.ts and as an
  // OrchestratorEvents member in src/core/event-bus.types.ts. The NDJSON
  // field schema is documented in PIPELINE_EVENT_METADATA (help-agent.ts).
  // CoreEvents re-declares all worktree merge events under 'worktree:*'
  // (see above) — the 'pipeline:merge-conflict-detected' variant is the
  // NDJSON-visible, operator-facing escalation event emitted by merge-to-main.

  // -------------------------------------------------------------------------
  // Non-interactive mode decision events (Story 72-2)
  // -------------------------------------------------------------------------

  /**
   * Story 72-2: A critical halt decision was skipped under --non-interactive mode.
   *
   * Emitted when the pipeline would have prompted the operator (interactive stdin
   * read) but --non-interactive suppressed stdin and auto-applied the default
   * action instead. Operators reviewing the run via `substrate report` can see
   * which halts were auto-skipped and what actions were applied.
   *
   * Mirror of OrchestratorEvents['decision:halt-skipped-non-interactive']; both
   * must stay in sync.
   */
  'decision:halt-skipped-non-interactive': {
    runId: string
    /** Halt decision type that was skipped (e.g., 'halt:escalation', 'halt:critical'). */
    decisionType: string
    /** Severity of the skipped halt (e.g., 'critical'). */
    severity: string
    /** Action that was applied in place of the operator prompt (e.g., 'continue'). */
    defaultAction: string
    /** Human-readable reason for skipping (e.g., 'non-interactive: stdin prompt suppressed'). */
    reason: string
  }

  // -------------------------------------------------------------------------
  // Decision routing events (Story 72-1)
  // Emitted by orchestrator-impl.ts when a halt-able decision is routed through
  // the autonomy policy. Mirror of OrchestratorEvents['decision:halt'] and
  // OrchestratorEvents['decision:autonomous']; both must stay in sync.
  // -------------------------------------------------------------------------

  /**
   * Story 72-1: A halt-able decision was routed and the policy requires halting.
   * Emitted when routeDecision() returns halt=true for a given policy.
   * Mirror of OrchestratorEvents['decision:halt']; both must stay in sync.
   */
  'decision:halt': {
    runId: string
    /** The decision type that triggered the halt (e.g., 'cost-ceiling-exhausted'). */
    decisionType: string
    /** Severity of the decision (e.g., 'critical', 'fatal'). */
    severity: string
    /** Human-readable reason for the halt. */
    reason: string
  }

  /**
   * Story 72-1: A halt-able decision was routed and the policy allows autonomous action.
   * Emitted when routeDecision() returns halt=false for a given policy.
   * Caller applies defaultAction without operator intervention.
   * Mirror of OrchestratorEvents['decision:autonomous']; both must stay in sync.
   */
  'decision:autonomous': {
    runId: string
    /** The decision type that was routed autonomously (e.g., 'build-verification-failure'). */
    decisionType: string
    /** Severity of the decision (e.g., 'info', 'warning', 'critical'). */
    severity: string
    /** The action applied autonomously (e.g., 'escalate-without-halt', 'continue-autonomous'). */
    defaultAction: string
    /** Human-readable reason for autonomous action. */
    reason: string
  }

  // -------------------------------------------------------------------------
  // Orchestrator system lifecycle events (not SDLC workflow events)
  // -------------------------------------------------------------------------

  /** Orchestrator has been fully initialized and is ready to process tasks */
  'orchestrator:ready': Record<string, never>

  /** Orchestrator shutdown has been initiated */
  'orchestrator:shutdown': { reason: string }

  // -------------------------------------------------------------------------
  // Recovery Engine events (Story 73-1)
  // Phase D Story 54-1 (original spec) + Epic 70 (cross-story-race recovery,
  // similar tier-A pattern) + Epic 72 (Decision Router that Recovery Engine
  // consumes). Story 73-2 implements the Tier C interactive prompt.
  // Mirror of OrchestratorEvents recovery events; both must stay in sync.
  // -------------------------------------------------------------------------

  /**
   * Story 73-1: Tier A auto-retry — recovery engine re-dispatched a story
   * with diagnosis + findings prepended to the retry prompt.
   *
   * Mirror of OrchestratorEvents['recovery:tier-a-retry']; both must stay in sync.
   */
  'recovery:tier-a-retry': {
    runId: string
    storyKey: string
    rootCause: string
    attempt: number
    retryBudgetRemaining: number
  }

  /**
   * Story 73-1: Tier B re-scope proposal — recovery engine appended a
   * re-scope proposal to RunManifest.pending_proposals.
   *
   * Mirror of OrchestratorEvents['recovery:tier-b-proposal']; both must stay in sync.
   */
  'recovery:tier-b-proposal': {
    runId: string
    storyKey: string
    rootCause: string
    attempts: number
    suggestedAction: string
    blastRadius: string[]
  }

  /**
   * Story 73-1: Tier C halt — recovery engine determined a halt is required.
   * The orchestrator yields to the Decision Router / Interactive Prompt (Story 73-2).
   *
   * Mirror of OrchestratorEvents['recovery:tier-c-halt']; both must stay in sync.
   */
  'recovery:tier-c-halt': {
    runId: string
    storyKey: string
    rootCause: string
  }

  /**
   * Story 73-1: Safety valve — pending_proposals count reached 5 or more.
   * The orchestrator exits the main loop with code 1.
   *
   * Mirror of OrchestratorEvents['pipeline:halted-pending-proposals']; both
   * must stay in sync.
   */
  'pipeline:halted-pending-proposals': {
    runId: string
    pendingProposalsCount: number
  }
}
