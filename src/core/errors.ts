/**
 * Error definitions for Substrate
 * Provides structured error hierarchy for all toolkit operations
 *
 * AdtError, ConfigError, and ConfigIncompatibleFormatError are defined in
 * @substrate-ai/core and re-exported here as the canonical source. All other
 * error classes extend the re-exported AdtError so that instanceof checks
 * work correctly across the monolith/core boundary.
 */

// AdtError, ConfigError, and ConfigIncompatibleFormatError are defined in core.
// Re-export them so monolith callers and tests use the same class instances.
import { AdtError } from '@substrate-ai/core'

export { AdtError, ConfigError, ConfigIncompatibleFormatError } from '@substrate-ai/core'

/** Error thrown when task configuration is invalid */
export class TaskConfigError extends AdtError {
  constructor(message: string, context: Record<string, unknown> = {}) {
    super(message, 'TASK_CONFIG_ERROR', context)
    this.name = 'TaskConfigError'
  }
}

/** Error thrown when a worker/agent operation fails */
export class WorkerError extends AdtError {
  constructor(message: string, context: Record<string, unknown> = {}) {
    super(message, 'WORKER_ERROR', context)
    this.name = 'WorkerError'
  }
}

/** Error thrown when a worker/agent cannot be found */
export class WorkerNotFoundError extends AdtError {
  constructor(agentId: string) {
    super(`Worker agent not found: ${agentId}`, 'WORKER_NOT_FOUND', {
      agentId,
    })
    this.name = 'WorkerNotFoundError'
  }
}

/** Error thrown when a task graph is invalid */
export class TaskGraphError extends AdtError {
  constructor(message: string, context: Record<string, unknown> = {}) {
    super(message, 'TASK_GRAPH_ERROR', context)
    this.name = 'TaskGraphError'
  }
}

/** Error thrown when a task graph has cycles (deadlock) */
export class TaskGraphCycleError extends TaskGraphError {
  constructor(cycle: string[]) {
    super(`Circular dependency detected in task graph: ${cycle.join(' -> ')}`, {
      cycle,
    })
    this.name = 'TaskGraphCycleError'
  }
}

/** Error thrown when a budget limit is exceeded */
export class BudgetExceededError extends AdtError {
  constructor(
    limit: number,
    current: number,
    context: Record<string, unknown> = {}
  ) {
    super(
      `Budget cap exceeded: current=${String(current)}, limit=${String(limit)}`,
      'BUDGET_EXCEEDED',
      { limit, current, ...context }
    )
    this.name = 'BudgetExceededError'
  }
}

/** Error thrown when git operations fail */
export class GitError extends AdtError {
  constructor(message: string, context: Record<string, unknown> = {}) {
    super(message, 'GIT_ERROR', context)
    this.name = 'GitError'
  }
}

/** Error thrown when state recovery fails */
export class RecoveryError extends AdtError {
  constructor(message: string, context: Record<string, unknown> = {}) {
    super(message, 'RECOVERY_ERROR', context)
    this.name = 'RecoveryError'
  }
}

/** Error thrown when a task graph file uses an incompatible format version */
export class TaskGraphIncompatibleFormatError extends AdtError {
  constructor(message: string, context: Record<string, unknown> = {}) {
    super(message, 'TASK_GRAPH_INCOMPATIBLE_FORMAT', context)
    this.name = 'TaskGraphIncompatibleFormatError'
  }
}
