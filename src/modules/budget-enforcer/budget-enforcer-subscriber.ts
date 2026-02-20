/**
 * BudgetEnforcerSubscriber — bridges the EventBus with the BudgetEnforcer.
 *
 * Responsibilities (Story 4.3, Task 4):
 *  - Subscribe to cost:recorded events from CostTracker
 *  - On cost recorded: call checkTaskBudget() and checkSessionBudget()
 *  - If task budget exceeded: WorkerPoolManager receives budget:exceeded:task event and kills worker
 *  - If session budget exceeded: emit session:budget:exceeded, terminate ALL workers
 *  - Subscribe to task:routed event: verify task has budget_usd, apply default if missing
 *  - Record budget caps via recordTaskBudgetCap() on task routing
 *  - Subscribe to config:reloaded for hot-reload of budget config (FIX 6)
 *
 * Design decisions:
 *  - BudgetEnforcer never calls WorkerPoolManager directly (event-driven design)
 *  - Session termination is handled by listening to session:budget:exceeded in WorkerPoolManager
 *  - Errors during budget checks are logged but do not propagate (non-fatal to cost recording)
 *  - Budget checks are async but triggered synchronously from event handlers
 */

import type { BaseService } from '../../core/di.js'
import type { TypedEventBus } from '../../core/event-bus.js'
import type { WorkerPoolManager } from '../worker-pool/worker-pool-manager.js'
import type { BudgetEnforcer } from './budget-enforcer.js'
import type { BudgetEnforcerImpl } from './budget-enforcer-impl.js'
import type { ConfigSystem } from '../config/config-system.js'
import type { Task } from '../../persistence/queries/tasks.js'
import { createLogger } from '../../utils/logger.js'
import { getTask } from '../../persistence/queries/tasks.js'
import { getSession } from '../../persistence/queries/sessions.js'
import type { Database as BetterSqlite3Database } from 'better-sqlite3'

const logger = createLogger('budget-enforcer:subscriber')

// ---------------------------------------------------------------------------
// BudgetEnforcerSubscriber
// ---------------------------------------------------------------------------

export class BudgetEnforcerSubscriber implements BaseService {
  private readonly _eventBus: TypedEventBus
  private readonly _budgetEnforcer: BudgetEnforcer
  private readonly _workerPoolManager: WorkerPoolManager
  private readonly _db: BetterSqlite3Database
  private readonly _configSystem: ConfigSystem | null

  // Bound handlers for clean unsubscription
  private readonly _onCostRecorded: (payload: {
    taskId: string
    sessionId: string
    costUsd: number
    savingsUsd: number
    billingMode: 'subscription' | 'api'
  }) => void

  private readonly _onTaskRouted: (payload: {
    taskId: string
    decision: {
      taskId: string
      agent: string
      billingMode: string
      model?: string
      rationale: string
      estimatedCostUsd?: number
    }
  }) => void

  private readonly _onBudgetExceededTask: (payload: {
    taskId: string
    currentCostUsd: number
    budgetUsd: number
  }) => void

  private readonly _onSessionBudgetExceeded: (payload: {
    sessionId: string
    currentCostUsd: number
    budgetUsd: number
  }) => void

  private readonly _onConfigReloaded: (payload: {
    changedKeys: string[]
  }) => void

  constructor(
    eventBus: TypedEventBus,
    budgetEnforcer: BudgetEnforcer,
    workerPoolManager: WorkerPoolManager,
    db: BetterSqlite3Database,
    configSystem: ConfigSystem | null = null,
  ) {
    this._eventBus = eventBus
    this._budgetEnforcer = budgetEnforcer
    this._workerPoolManager = workerPoolManager
    this._db = db
    this._configSystem = configSystem

    // Handler: cost:recorded — check both task and session budgets
    this._onCostRecorded = (payload) => {
      const { taskId, sessionId } = payload

      // Retrieve the full task record for budget check (FIX 8: cached for reuse)
      const task = getTask(this._db, taskId)
      if (task === undefined) {
        logger.debug({ taskId }, 'cost:recorded — task not found, skipping budget check')
        return
      }

      // Async budget checks — errors are non-fatal
      void this._handleCostRecorded(task, sessionId)
    }

    // Handler: task:routed — apply default budget cap if missing (AC5)
    this._onTaskRouted = (payload) => {
      const { taskId } = payload

      const task = getTask(this._db, taskId)
      if (task === undefined) {
        logger.debug({ taskId }, 'task:routed — task not found, skipping budget cap check')
        return
      }

      void this._handleTaskRouted(task)
    }

    // Handler: budget:exceeded:task — terminate the worker for this task
    this._onBudgetExceededTask = (payload) => {
      const { taskId } = payload

      // Find the worker for this task and terminate it
      const activeWorkers = this._workerPoolManager.getActiveWorkers()
      const workerEntry = activeWorkers.find((w) => w.taskId === taskId)

      if (workerEntry !== undefined) {
        logger.warn(
          { taskId, workerId: workerEntry.workerId },
          'Budget exceeded — terminating worker',
        )
        this._workerPoolManager.terminateWorker(workerEntry.workerId, 'budget_exceeded')

        // Mark the task as failed with budget_exceeded reason
        try {
          this._db
            .prepare(
              `UPDATE tasks SET status = 'failed', error = 'budget_exceeded',
               budget_exceeded = 1, updated_at = datetime('now') WHERE id = ?`,
            )
            .run(taskId)
        } catch (err) {
          logger.warn({ err, taskId }, 'Failed to update task status after budget exceeded')
        }
      } else {
        logger.debug(
          { taskId },
          'budget:exceeded:task — no active worker found for task (may already be terminated)',
        )
      }
    }

    // Handler: session:budget:exceeded — terminate ALL workers in the session
    this._onSessionBudgetExceeded = (payload) => {
      const { sessionId } = payload

      logger.warn({ sessionId }, 'Session budget exceeded — terminating all workers')

      // Terminate all workers
      void this._workerPoolManager.terminateAll().catch((err) => {
        logger.warn({ err, sessionId }, 'Error during terminateAll after session budget exceeded')
      })

      // Mark session as paused (FIX 5: removed unused getSession() call — UPDATE is a no-op if session doesn't exist)
      try {
        this._db
          .prepare(`UPDATE sessions SET status = 'paused', updated_at = datetime('now') WHERE id = ?`)
          .run(sessionId)
        logger.info({ sessionId }, 'Session paused due to budget exceeded')
      } catch (err) {
        logger.warn({ err, sessionId }, 'Failed to update session status after budget exceeded')
      }
    }

    // Handler: config:reloaded — hot-reload budget config (FIX 2: pass actual config values)
    this._onConfigReloaded = (payload) => {
      const { changedKeys } = payload
      // Only update if budget-related keys changed
      if (changedKeys.some((k) => k.startsWith('budget'))) {
        logger.info({ changedKeys }, 'Config reloaded — updating budget enforcer config')
        // BudgetEnforcerImpl exposes updateConfig; cast to access it
        if ('updateConfig' in this._budgetEnforcer) {
          // Read the actual budget config from the config system if available
          const budgetConfig = this._configSystem?.getConfig()?.budget
          const newConfig = budgetConfig !== undefined
            ? {
                defaultTaskBudgetUsd: budgetConfig.default_task_budget_usd,
                defaultSessionBudgetUsd: budgetConfig.default_session_budget_usd,
                planningCostsCountAgainstBudget: budgetConfig.planning_costs_count_against_budget,
                warningThresholdPercent: budgetConfig.warning_threshold_percent,
              }
            : {}
          ;(this._budgetEnforcer as BudgetEnforcerImpl).updateConfig(newConfig)
        }
      }
    }
  }

  // ---------------------------------------------------------------------------
  // BaseService lifecycle
  // ---------------------------------------------------------------------------

  async initialize(): Promise<void> {
    this._eventBus.on('cost:recorded', this._onCostRecorded)
    this._eventBus.on('task:routed', this._onTaskRouted)
    this._eventBus.on('budget:exceeded:task', this._onBudgetExceededTask)
    this._eventBus.on('session:budget:exceeded', this._onSessionBudgetExceeded)
    this._eventBus.on('config:reloaded', this._onConfigReloaded)
    logger.info('BudgetEnforcerSubscriber initialized — subscribed to events')
  }

  async shutdown(): Promise<void> {
    this._eventBus.off('cost:recorded', this._onCostRecorded)
    this._eventBus.off('task:routed', this._onTaskRouted)
    this._eventBus.off('budget:exceeded:task', this._onBudgetExceededTask)
    this._eventBus.off('session:budget:exceeded', this._onSessionBudgetExceeded)
    this._eventBus.off('config:reloaded', this._onConfigReloaded)
    logger.info('BudgetEnforcerSubscriber shut down')
  }

  // ---------------------------------------------------------------------------
  // Private async handlers
  // ---------------------------------------------------------------------------

  private async _handleCostRecorded(
    task: Task,
    sessionId: string,
  ): Promise<void> {
    try {
      // FIX 1: Use the task parameter directly — no redundant getTask() call needed
      // (task is already the full task record fetched in _onCostRecorded)

      // Check task-level budget
      const taskResult = await this._budgetEnforcer.checkTaskBudget(task, task.cost_usd)
      logger.debug(
        { taskId: task.id, action: taskResult.action, percentageUsed: taskResult.percentageUsed },
        'Task budget check completed',
      )

      // If task budget is OK, also check session-level budget
      if (!taskResult.exceeded) {
        // Get current session total cost
        const session = getSession(this._db, sessionId)
        if (session !== undefined) {
          const sessionResult = await this._budgetEnforcer.checkSessionBudget(
            sessionId,
            session.total_cost_usd,
          )
          logger.debug(
            { sessionId, action: sessionResult.action, percentageUsed: sessionResult.percentageUsed },
            'Session budget check completed',
          )
        }
      }
    } catch (err) {
      logger.warn({ err, taskId: task.id }, 'Error during budget check (non-fatal)')
    }
  }

  private async _handleTaskRouted(task: Task): Promise<void> {
    try {
      // AC5: Check if task has a budget cap
      if (task.budget_usd === null || task.budget_usd === undefined) {
        const budgetStatus = await this._budgetEnforcer.getBudgetStatus(task.id)

        logger.warn(
          { taskId: task.id, appliedDefault: budgetStatus.budgetUsd },
          'Task has no explicit budget cap — applying default budget cap',
        )

        // Record the default budget cap
        await this._budgetEnforcer.recordTaskBudgetCap(task.id, budgetStatus.budgetUsd)
      }
    } catch (err) {
      logger.warn({ err, taskId: task.id }, 'Error handling task:routed budget check (non-fatal)')
    }
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export interface BudgetEnforcerSubscriberOptions {
  eventBus: TypedEventBus
  budgetEnforcer: BudgetEnforcer
  workerPoolManager: WorkerPoolManager
  db: BetterSqlite3Database
  configSystem?: ConfigSystem | null
}

export function createBudgetEnforcerSubscriber(
  options: BudgetEnforcerSubscriberOptions,
): BudgetEnforcerSubscriber {
  return new BudgetEnforcerSubscriber(
    options.eventBus,
    options.budgetEnforcer,
    options.workerPoolManager,
    options.db,
    options.configSystem ?? null,
  )
}
