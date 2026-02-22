/**
 * OrchestratorEvents interface — defines all typed events for the event bus.
 *
 * Event naming convention: {module}:{action} (e.g., "task:complete", "plan:generated")
 * Payloads are defined inline with JSDoc for each event.
 */

import type { TaskId, WorkerId } from './types.js'
import type { SubstrateConfig } from '../modules/config/config-schema.js'

// ---------------------------------------------------------------------------
// Routing decision (inline to avoid circular imports)
// ---------------------------------------------------------------------------

/**
 * Routing decision payload used in task:routed event.
 * Mirrors RoutingDecision from src/modules/routing/routing-decision.ts
 * but kept here as a plain interface to avoid circular module dependencies.
 */
export interface RoutingDecision {
  taskId: string
  agent: string
  billingMode: 'subscription' | 'api' | 'unavailable'
  model?: string
  rationale: string
  fallbackChain?: string[]
  estimatedCostUsd?: number
  rateLimit?: { tokensUsedInWindow: number; limit: number }
}

// ---------------------------------------------------------------------------
// Shared payload subtypes
// ---------------------------------------------------------------------------

/** Result of a completed task */
export interface TaskResult {
  output?: string
  exitCode?: number
  tokensUsed?: number
  costUsd?: number
}

/** Error payload for a failed task */
export interface TaskError {
  message: string
  code?: string
  stack?: string
}

// ---------------------------------------------------------------------------
// OrchestratorEvents
// ---------------------------------------------------------------------------

/**
 * Complete typed map of all events emitted on the orchestrator event bus.
 * Use `keyof OrchestratorEvents` to constrain event keys.
 */
export interface OrchestratorEvents {
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
  'task:complete': { taskId: TaskId; result: TaskResult }

  /** Task has failed with an error */
  'task:failed': { taskId: TaskId; error: TaskError }

  /** Task was cancelled */
  'task:cancelled': { taskId: TaskId; reason: string }

  /** Task is being retried after a failure */
  'task:retrying': { taskId: TaskId; attempt: number; maxAttempts: number }

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

  /** Budget cap has been set for a task */
  'task:budget-set': { taskId: TaskId; budgetUsd: number }

  /** Budget cap has been set for a session */
  'session:budget-set': { sessionId: string; budgetUsd: number }

  // -------------------------------------------------------------------------
  // Graph lifecycle events
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
  // Plan events
  // -------------------------------------------------------------------------

  /** Plan generation has started */
  'plan:generating': { agent: string; description: string }

  /** Plan generation has completed */
  'plan:generated': { taskCount: number; estimatedCost: number }

  /** Plan was approved by the user */
  'plan:approved': { taskCount: number }

  /** Plan was rejected by the user */
  'plan:rejected': { reason: string }

  /** Plan is being refined based on feedback */
  'plan:refining': { planId: string; feedback: string; currentVersion: number }

  /** Plan refinement completed successfully */
  'plan:refined': { planId: string; newVersion: number; taskCount: number }

  /** Plan was rolled back to a previous version */
  'plan:rolled-back': { planId: string; fromVersion: number; toVersion: number; newVersion: number }

  /** Plan refinement failed */
  'plan:refinement-failed': { planId: string; currentVersion: number; error: string }

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

  /** A task has been routed to an agent with billing mode decision */
  'task:routed': { taskId: TaskId; decision: RoutingDecision }

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
  // Agent dispatch events (sub-agent dispatch engine)
  // -------------------------------------------------------------------------

  /** A sub-agent subprocess was spawned by the dispatch engine */
  'agent:spawned': { dispatchId: string; agent: string; taskType: string }

  /** Incremental stdout data received from a running sub-agent */
  'agent:output': { dispatchId: string; data: string }

  /** A sub-agent completed successfully */
  'agent:completed': { dispatchId: string; exitCode: number; output: string }

  /** A sub-agent exited with a non-zero code or encountered an error */
  'agent:failed': { dispatchId: string; error: string; exitCode: number }

  /** A sub-agent was killed because it exceeded its timeout */
  'agent:timeout': { dispatchId: string; timeoutMs: number }

  // -------------------------------------------------------------------------
  // Orchestrator system events
  // -------------------------------------------------------------------------

  /** Orchestrator has been fully initialized and is ready to process tasks */
  'orchestrator:ready': Record<string, never>

  /** Orchestrator shutdown has been initiated */
  'orchestrator:shutdown': { reason: string }

  // -------------------------------------------------------------------------
  // Implementation orchestrator lifecycle events
  // -------------------------------------------------------------------------

  /** Implementation orchestrator has started processing story keys */
  'orchestrator:started': { storyKeys: string[]; pipelineRunId?: string }

  /** A story phase has completed within the implementation orchestrator */
  'orchestrator:story-phase-complete': {
    storyKey: string
    phase: string
    result: unknown
  }

  /** A story has completed the full pipeline with SHIP_IT verdict */
  'orchestrator:story-complete': { storyKey: string; reviewCycles: number }

  /** A story has been escalated after exceeding max review cycles */
  'orchestrator:story-escalated': {
    storyKey: string
    lastVerdict: string
    reviewCycles: number
    issues: unknown[]
  }

  /** Implementation orchestrator has finished all stories */
  'orchestrator:complete': {
    totalStories: number
    completed: number
    escalated: number
    failed: number
  }

  /** Implementation orchestrator has been paused */
  'orchestrator:paused': Record<string, never>

  /** Implementation orchestrator has been resumed */
  'orchestrator:resumed': Record<string, never>
}
