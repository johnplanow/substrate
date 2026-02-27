/**
 * Error definitions for Substrate
 * Provides structured error hierarchy for all toolkit operations
 */

/** Base error class for all Substrate errors */
export class AdtError extends Error {
  public readonly code: string
  public readonly context: Record<string, unknown>

  constructor(
    message: string,
    code: string,
    context: Record<string, unknown> = {}
  ) {
    super(message)
    this.name = 'AdtError'
    this.code = code
    this.context = context
    // Maintains proper stack trace for V8 (not available in all environments)
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, AdtError)
    }
  }

  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      message: this.message,
      code: this.code,
      context: this.context,
      stack: this.stack,
    }
  }
}

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

/** Error thrown when configuration is invalid or missing */
export class ConfigError extends AdtError {
  constructor(message: string, context: Record<string, unknown> = {}) {
    super(message, 'CONFIG_ERROR', context)
    this.name = 'ConfigError'
  }
}

/** Error thrown when state recovery fails */
export class RecoveryError extends AdtError {
  constructor(message: string, context: Record<string, unknown> = {}) {
    super(message, 'RECOVERY_ERROR', context)
    this.name = 'RecoveryError'
  }
}

/** Error thrown when a config file uses an incompatible format version */
export class ConfigIncompatibleFormatError extends AdtError {
  constructor(message: string, context: Record<string, unknown> = {}) {
    super(message, 'CONFIG_INCOMPATIBLE_FORMAT', context)
    this.name = 'ConfigIncompatibleFormatError'
  }
}

/** Error thrown when a task graph file uses an incompatible format version */
export class TaskGraphIncompatibleFormatError extends AdtError {
  constructor(message: string, context: Record<string, unknown> = {}) {
    super(message, 'TASK_GRAPH_INCOMPATIBLE_FORMAT', context)
    this.name = 'TaskGraphIncompatibleFormatError'
  }
}
