/**
 * BudgetEnforcerImpl — concrete implementation of the BudgetEnforcer interface.
 *
 * Responsibilities (Story 4.3):
 *  - Check task-level budget caps and emit events (AC1, AC2)
 *  - Check session-level budget caps and emit events (AC3)
 *  - Support optional planning cost isolation (AC4)
 *  - Apply default budget caps at task assignment time (AC5)
 *  - Use database transactions for atomic budget checks (AC6)
 *
 * Architecture constraints:
 *  - Reactive: checks happen after cost is recorded, not before
 *  - Event-driven: emits events via TypedEventBus, never calls WorkerPoolManager directly
 *  - Non-blocking: budget checks use synchronous better-sqlite3 API
 *  - Atomic: uses db.transaction() to prevent race conditions
 */

import type { Database as BetterSqlite3Database } from 'better-sqlite3'
import type { TypedEventBus } from '../../core/event-bus.js'
import type { Task } from '../../persistence/queries/tasks.js'
import type { BudgetEnforcer } from './budget-enforcer.js'
import type { BudgetCheckResult, BudgetStatus, SessionBudgetStatus } from './types.js'
import { getTask, getAllTasks } from '../../persistence/queries/tasks.js'
import { getSession } from '../../persistence/queries/sessions.js'
import { createLogger } from '../../utils/logger.js'

const logger = createLogger('budget-enforcer')

// ---------------------------------------------------------------------------
// Default budget configuration
// ---------------------------------------------------------------------------

export interface BudgetEnforcerConfig {
  /** Default per-task budget cap (0 = unlimited) */
  defaultTaskBudgetUsd: number
  /** Default session budget cap (0 = unlimited) */
  defaultSessionBudgetUsd: number
  /** When true, planning costs count toward session budget cap */
  planningCostsCountAgainstBudget: boolean
  /** Percentage threshold for budget:warning:task emission (default: 80) */
  warningThresholdPercent: number
}

const DEFAULT_BUDGET_CONFIG: BudgetEnforcerConfig = {
  defaultTaskBudgetUsd: 5.0,
  defaultSessionBudgetUsd: 50.0,
  planningCostsCountAgainstBudget: false,
  warningThresholdPercent: 80,
}

// ---------------------------------------------------------------------------
// BudgetEnforcerImpl
// ---------------------------------------------------------------------------

export class BudgetEnforcerImpl implements BudgetEnforcer {
  private readonly _db: BetterSqlite3Database
  private readonly _eventBus: TypedEventBus
  private _config: BudgetEnforcerConfig

  constructor(
    db: BetterSqlite3Database,
    eventBus: TypedEventBus,
    config: Partial<BudgetEnforcerConfig> = {},
  ) {
    this._db = db
    this._eventBus = eventBus
    this._config = { ...DEFAULT_BUDGET_CONFIG, ...config }
  }

  // ---------------------------------------------------------------------------
  // BaseService lifecycle
  // ---------------------------------------------------------------------------

  async initialize(): Promise<void> {
    logger.info('BudgetEnforcer initialized')
  }

  async shutdown(): Promise<void> {
    logger.info('BudgetEnforcer shut down')
  }

  // ---------------------------------------------------------------------------
  // Config hot-reload support
  // ---------------------------------------------------------------------------

  /**
   * Update the budget configuration at runtime (supports hot-reload via ConfigService).
   * Picks up new default values immediately — no restart required.
   */
  updateConfig(config: Partial<BudgetEnforcerConfig>): void {
    this._config = { ...this._config, ...config }
    logger.info({ config: this._config }, 'BudgetEnforcer config updated')
  }

  // ---------------------------------------------------------------------------
  // checkTaskBudget
  // ---------------------------------------------------------------------------

  /**
   * Check whether a task's cumulative cost has exceeded its budget cap.
   *
   * Uses a database transaction to atomically read the current task cost and
   * perform the budget check — prevents race conditions with concurrent updates.
   *
   * AC1: >= 100% → emit budget:exceeded:task, action=terminate
   * AC2: >= warningThreshold% → emit budget:warning:task, action=continue
   * AC2: < warningThreshold% → no event, action=continue
   */
  async checkTaskBudget(task: Task, currentCostUsd: number): Promise<BudgetCheckResult> {
    // Resolve the effective budget cap
    const budgetUsd = task.budget_usd ?? this._config.defaultTaskBudgetUsd

    // Budget of 0 means unlimited — always continue
    if (budgetUsd === 0) {
      return {
        exceeded: false,
        action: 'continue',
        currentCostUsd,
        budgetUsd: 0,
        percentageUsed: 0,
      }
    }

    // Perform atomic budget check inside a transaction (AC6)
    // IMPORTANT: Events are emitted AFTER the transaction completes to avoid
    // side effects inside database transactions.
    const warningThreshold = this._config.warningThresholdPercent
    const checkResult = this._db.transaction((): BudgetCheckResult => {
      // Re-read current cost from DB to ensure we have the latest value
      const latestTask = getTask(this._db, task.id)
      const effectiveCost = latestTask !== undefined ? latestTask.cost_usd : currentCostUsd
      const percentageUsed = (effectiveCost / budgetUsd) * 100

      if (percentageUsed >= 100) {
        return {
          exceeded: true,
          action: 'terminate',
          currentCostUsd: effectiveCost,
          budgetUsd,
          percentageUsed,
        }
      }

      if (percentageUsed >= warningThreshold) {
        return {
          exceeded: false,
          action: 'continue',
          currentCostUsd: effectiveCost,
          budgetUsd,
          percentageUsed,
        }
      }

      return {
        exceeded: false,
        action: 'continue',
        currentCostUsd: effectiveCost,
        budgetUsd,
        percentageUsed,
      }
    })()

    // Emit events AFTER the transaction completes
    if (checkResult.exceeded) {
      // AC1: Budget exceeded — emit event
      this._eventBus.emit('budget:exceeded:task', {
        taskId: task.id,
        currentCostUsd: checkResult.currentCostUsd,
        budgetUsd,
      })

      // Also emit the legacy budget:exceeded for backward compat
      this._eventBus.emit('budget:exceeded', {
        taskId: task.id,
        spend: checkResult.currentCostUsd,
        limit: budgetUsd,
      })

      logger.warn(
        { taskId: task.id, effectiveCost: checkResult.currentCostUsd, budgetUsd, percentageUsed: checkResult.percentageUsed },
        'Task budget exceeded — emitting budget:exceeded:task',
      )
    } else if (checkResult.percentageUsed >= warningThreshold) {
      // AC2: Warning threshold reached — emit warning event but continue
      this._eventBus.emit('budget:warning:task', {
        taskId: task.id,
        currentCostUsd: checkResult.currentCostUsd,
        budgetUsd,
        percentageUsed: checkResult.percentageUsed,
      })

      // Also emit the legacy budget:warning for backward compat
      this._eventBus.emit('budget:warning', {
        taskId: task.id,
        currentSpend: checkResult.currentCostUsd,
        limit: budgetUsd,
      })

      logger.info(
        { taskId: task.id, effectiveCost: checkResult.currentCostUsd, budgetUsd, percentageUsed: checkResult.percentageUsed },
        'Task budget warning threshold reached',
      )
    }

    return checkResult
  }

  // ---------------------------------------------------------------------------
  // checkSessionBudget
  // ---------------------------------------------------------------------------

  /**
   * Check whether a session's total cost has exceeded its budget cap.
   *
   * AC3: >= session.budget_usd → emit session:budget:exceeded, action=terminate-all
   * AC4: planning_costs_count_against_budget config controls whether planning
   *       costs are included in the session total.
   */
  async checkSessionBudget(sessionId: string, currentCostUsd: number): Promise<BudgetCheckResult> {
    // IMPORTANT: Events are emitted AFTER the transaction completes to avoid
    // side effects inside database transactions.
    const warningThreshold = this._config.warningThresholdPercent
    const checkResult = this._db.transaction((): BudgetCheckResult => {
      // Re-read session from DB inside the transaction for authoritative values (FIX 6)
      const session = getSession(this._db, sessionId)
      if (session === undefined) {
        logger.warn({ sessionId }, 'checkSessionBudget: session not found, skipping')
        return {
          exceeded: false,
          action: 'continue',
          currentCostUsd,
          budgetUsd: 0,
          percentageUsed: 0,
        }
      }

      const budgetUsd = session.budget_usd ?? this._config.defaultSessionBudgetUsd

      // Budget of 0 means unlimited — always continue
      if (budgetUsd === 0) {
        return {
          exceeded: false,
          action: 'continue',
          currentCostUsd,
          budgetUsd: 0,
          percentageUsed: 0,
        }
      }

      // Use the DB's authoritative total_cost_usd (not caller-supplied currentCostUsd)
      // to prevent race conditions where multiple concurrent cost updates could bypass the check
      const dbCostUsd = session.total_cost_usd ?? currentCostUsd

      // Calculate effective session cost
      // AC4: If planning_costs_count_against_budget is false, exclude planning costs
      let effectiveCost = dbCostUsd
      if (!this._config.planningCostsCountAgainstBudget) {
        // Subtract planning costs (these should not count toward budget)
        effectiveCost = Math.max(0, dbCostUsd - (session.planning_cost_usd ?? 0))
      }

      const percentageUsed = budgetUsd > 0 ? (effectiveCost / budgetUsd) * 100 : 0

      if (effectiveCost >= budgetUsd) {
        // AC3: Session budget exceeded
        return {
          exceeded: true,
          action: 'terminate-all',
          currentCostUsd: effectiveCost,
          budgetUsd,
          percentageUsed,
        }
      }

      return {
        exceeded: false,
        action: 'continue',
        currentCostUsd: effectiveCost,
        budgetUsd,
        percentageUsed,
      }
    })()

    // Emit events AFTER the transaction completes
    if (checkResult.exceeded) {
      // AC3: Session budget exceeded
      this._eventBus.emit('session:budget:exceeded', {
        sessionId,
        currentCostUsd: checkResult.currentCostUsd,
        budgetUsd: checkResult.budgetUsd,
      })

      logger.warn(
        { sessionId, effectiveCost: checkResult.currentCostUsd, budgetUsd: checkResult.budgetUsd, percentageUsed: checkResult.percentageUsed },
        'Session budget exceeded — emitting session:budget:exceeded',
      )
    } else if (checkResult.budgetUsd > 0 && checkResult.percentageUsed >= warningThreshold) {
      // FIX 4: Session-level warning at 80% threshold
      this._eventBus.emit('budget:warning:session', {
        sessionId,
        currentCostUsd: checkResult.currentCostUsd,
        budgetUsd: checkResult.budgetUsd,
        percentageUsed: checkResult.percentageUsed,
      })

      logger.info(
        { sessionId, effectiveCost: checkResult.currentCostUsd, budgetUsd: checkResult.budgetUsd, percentageUsed: checkResult.percentageUsed },
        'Session budget warning threshold reached',
      )
    }

    return checkResult
  }

  // ---------------------------------------------------------------------------
  // recordTaskBudgetCap
  // ---------------------------------------------------------------------------

  /**
   * Record a budget cap for a task (AC5: called at task assignment/routing time).
   *
   * Persists budget_usd to the tasks table and emits task:budget-set event.
   */
  async recordTaskBudgetCap(taskId: string, budgetUsd: number): Promise<void> {
    this._db
      .prepare(`UPDATE tasks SET budget_usd = @budgetUsd, updated_at = datetime('now') WHERE id = @taskId`)
      .run({ taskId, budgetUsd })

    this._eventBus.emit('task:budget-set', { taskId, budgetUsd })

    logger.debug({ taskId, budgetUsd }, 'Task budget cap recorded')
  }

  // ---------------------------------------------------------------------------
  // recordSessionBudgetCap
  // ---------------------------------------------------------------------------

  /**
   * Record a budget cap for a session (called at session start time).
   *
   * Persists budget_usd to the sessions table and emits session:budget-set event.
   */
  async recordSessionBudgetCap(sessionId: string, budgetUsd: number): Promise<void> {
    this._db
      .prepare(`UPDATE sessions SET budget_usd = @budgetUsd, updated_at = datetime('now') WHERE id = @sessionId`)
      .run({ sessionId, budgetUsd })

    this._eventBus.emit('session:budget-set', { sessionId, budgetUsd })

    logger.debug({ sessionId, budgetUsd }, 'Session budget cap recorded')
  }

  // ---------------------------------------------------------------------------
  // getBudgetStatus
  // ---------------------------------------------------------------------------

  /**
   * Get the current budget status for a task.
   *
   * Returns BudgetStatus with current cost, remaining budget, and status category.
   */
  async getBudgetStatus(taskId: string): Promise<BudgetStatus> {
    const task = getTask(this._db, taskId)
    if (task === undefined) {
      throw new Error(`Task "${taskId}" not found`)
    }

    const budgetUsd = task.budget_usd ?? this._config.defaultTaskBudgetUsd
    const currentCostUsd = task.cost_usd ?? 0
    const percentageUsed = budgetUsd > 0 ? (currentCostUsd / budgetUsd) * 100 : 0
    const remainingBudgetUsd = Math.max(0, budgetUsd - currentCostUsd)

    let status: 'ok' | 'warning' | 'exceeded'
    if (percentageUsed >= 100) {
      status = 'exceeded'
    } else if (percentageUsed >= this._config.warningThresholdPercent) {
      status = 'warning'
    } else {
      status = 'ok'
    }

    return {
      taskId,
      budgetUsd,
      currentCostUsd,
      remainingBudgetUsd,
      percentageUsed,
      status,
    }
  }

  // ---------------------------------------------------------------------------
  // getSessionBudgetStatus
  // ---------------------------------------------------------------------------

  /**
   * Get the current budget status for an entire session.
   *
   * Includes per-task breakdown. Respects planning_costs_count_against_budget
   * configuration when calculating the session total.
   */
  async getSessionBudgetStatus(sessionId: string): Promise<SessionBudgetStatus> {
    const session = getSession(this._db, sessionId)
    if (session === undefined) {
      throw new Error(`Session "${sessionId}" not found`)
    }

    const budgetUsd = session.budget_usd ?? this._config.defaultSessionBudgetUsd
    const allTasks = getAllTasks(this._db, sessionId)

    // Build per-task budget statuses
    const taskBudgets: BudgetStatus[] = await Promise.all(
      allTasks.map(async (t) => {
        const taskBudgetUsd = t.budget_usd ?? this._config.defaultTaskBudgetUsd
        const taskCostUsd = t.cost_usd ?? 0
        const taskPercentage = taskBudgetUsd > 0 ? (taskCostUsd / taskBudgetUsd) * 100 : 0
        const taskRemaining = Math.max(0, taskBudgetUsd - taskCostUsd)

        let taskStatus: 'ok' | 'warning' | 'exceeded'
        if (taskPercentage >= 100) {
          taskStatus = 'exceeded'
        } else if (taskPercentage >= this._config.warningThresholdPercent) {
          taskStatus = 'warning'
        } else {
          taskStatus = 'ok'
        }

        return {
          taskId: t.id,
          budgetUsd: taskBudgetUsd,
          currentCostUsd: taskCostUsd,
          remainingBudgetUsd: taskRemaining,
          percentageUsed: taskPercentage,
          status: taskStatus,
        }
      }),
    )

    // Calculate session total cost
    // AC4: Optionally exclude planning costs from session budget calculation
    const rawTotal = allTasks.reduce((sum, t) => sum + (t.cost_usd ?? 0), 0)
    let totalCostUsd = rawTotal
    if (!this._config.planningCostsCountAgainstBudget) {
      totalCostUsd = Math.max(0, rawTotal - (session.planning_cost_usd ?? 0))
    }

    const percentageUsed = budgetUsd > 0 ? (totalCostUsd / budgetUsd) * 100 : 0
    const remainingBudgetUsd = Math.max(0, budgetUsd - totalCostUsd)

    let status: 'ok' | 'warning' | 'exceeded'
    if (totalCostUsd >= budgetUsd && budgetUsd > 0) {
      status = 'exceeded'
    } else if (percentageUsed >= this._config.warningThresholdPercent) {
      status = 'warning'
    } else {
      status = 'ok'
    }

    return {
      sessionId,
      budgetUsd,
      totalCostUsd,
      remainingBudgetUsd,
      percentageUsed,
      status,
      taskCount: allTasks.length,
      taskBudgets,
    }
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export interface BudgetEnforcerOptions {
  db: BetterSqlite3Database
  eventBus: TypedEventBus
  config?: Partial<BudgetEnforcerConfig>
}

/**
 * Create a BudgetEnforcerImpl with the given database, event bus, and config.
 */
export function createBudgetEnforcer(options: BudgetEnforcerOptions): BudgetEnforcerImpl {
  return new BudgetEnforcerImpl(options.db, options.eventBus, options.config)
}
