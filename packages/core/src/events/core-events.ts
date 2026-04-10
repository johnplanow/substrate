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
  'budget:warning:task': {
    taskId: TaskId
    currentCostUsd: number
    budgetUsd: number
    percentageUsed: number
  }

  /** Task has exceeded its budget cap — force-terminate worker */
  'budget:exceeded:task': { taskId: TaskId; currentCostUsd: number; budgetUsd: number }

  /** Session-wide budget is approaching the cap (80% threshold) */
  'budget:warning:session': {
    sessionId: string
    currentCostUsd: number
    budgetUsd: number
    percentageUsed: number
  }

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
  'monitor:recommendation_generated': {
    taskType: string
    recommendedAgent: string
    confidence: number
  }

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
  'provider:unavailable': {
    provider: string
    reason: 'rate_limit' | 'disabled'
    resetAtMs?: number
  }

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

  // -------------------------------------------------------------------------
  // Orchestrator system lifecycle events (not SDLC workflow events)
  // -------------------------------------------------------------------------

  /** Orchestrator has been fully initialized and is ready to process tasks */
  'orchestrator:ready': Record<string, never>

  /** Orchestrator shutdown has been initiated */
  'orchestrator:shutdown': { reason: string }
}
