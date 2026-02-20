/**
 * OrchestratorEvents interface — defines all typed events for the event bus.
 *
 * Event naming convention: {module}:{action} (e.g., "task:complete", "plan:generated")
 * Payloads are defined inline with JSDoc for each event.
 */

import type { TaskId, WorkerId } from './types.js'

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
  'task:ready': { taskId: TaskId }

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
  'plan:refining': { feedback: string }

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
  'config:reloaded': { changedKeys: string[] }

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
  // Orchestrator system events
  // -------------------------------------------------------------------------

  /** Orchestrator has been fully initialized and is ready to process tasks */
  'orchestrator:ready': Record<string, never>

  /** Orchestrator shutdown has been initiated */
  'orchestrator:shutdown': { reason: string }
}
