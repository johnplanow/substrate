/**
 * BudgetEnforcer — interface contract for the budget enforcement module.
 *
 * BudgetEnforcer is responsible for:
 *  - Checking task-level budget caps (AC1, AC2)
 *  - Checking session-level budget caps (AC3)
 *  - Recording budget caps when set at task assignment (AC5)
 *  - Providing budget status for dashboards and reporting (Task 9)
 *
 * Architecture constraints (Story 4.3 Dev Notes):
 *  - Budget enforcement is REACTIVE — checks happen after costs are recorded,
 *    not before. This is simpler and safer than predicting costs beforehand.
 *  - Budget checks emit events via TypedEventBus; never call WorkerPoolManager
 *    directly (keeps modules decoupled).
 *  - Non-blocking: budget checks must not block cost tracking or worker execution.
 *  - Atomic: uses database transactions to prevent race conditions (AC6).
 */

import type { BaseService } from '../../core/di.js'
import type { Task } from '../../persistence/queries/tasks.js'
import type { BudgetCheckResult, BudgetStatus, SessionBudgetStatus } from './types.js'

// ---------------------------------------------------------------------------
// BudgetEnforcer interface
// ---------------------------------------------------------------------------

/**
 * Contract for the budget enforcement module.
 *
 * All check methods return a BudgetCheckResult indicating whether the budget
 * has been exceeded and what action should be taken.
 */
export interface BudgetEnforcer extends BaseService {
  /**
   * Check whether a task's cumulative cost has exceeded its budget cap.
   *
   * Business rules:
   *  - If percentageUsed >= 100%: emit budget:exceeded:task, return action='terminate'
   *  - If percentageUsed >= warningThreshold%: emit budget:warning:task, return action='continue'
   *  - Otherwise: return action='continue'
   *
   * @param task           - Task record (must include budget_usd and cost_usd)
   * @param currentCostUsd - Current cumulative cost for the task
   * @returns BudgetCheckResult describing whether to continue or terminate
   */
  checkTaskBudget(task: Task, currentCostUsd: number): Promise<BudgetCheckResult>

  /**
   * Check whether the session's total cost has exceeded its budget cap.
   *
   * Business rules:
   *  - If currentCostUsd >= session.budget_usd: emit session:budget:exceeded, return action='terminate-all'
   *  - Otherwise: return action='continue'
   *
   * @param sessionId      - ID of the session to check
   * @param currentCostUsd - Current cumulative cost for the session
   * @returns BudgetCheckResult describing whether to continue or terminate all workers
   */
  checkSessionBudget(sessionId: string, currentCostUsd: number): Promise<BudgetCheckResult>

  /**
   * Record a budget cap for a task (called at task assignment time, AC5).
   *
   * Persists budget_usd to the tasks table and emits task:budget-set event.
   *
   * @param taskId    - ID of the task
   * @param budgetUsd - Budget cap in USD
   */
  recordTaskBudgetCap(taskId: string, budgetUsd: number): Promise<void>

  /**
   * Record a budget cap for a session (called at session start time).
   *
   * Persists budget_usd to the sessions table and emits session:budget-set event.
   *
   * @param sessionId - ID of the session
   * @param budgetUsd - Budget cap in USD
   */
  recordSessionBudgetCap(sessionId: string, budgetUsd: number): Promise<void>

  /**
   * Get the current budget status for a task.
   *
   * @param taskId - ID of the task
   * @returns BudgetStatus with current cost, remaining budget, and status
   */
  getBudgetStatus(taskId: string): Promise<BudgetStatus>

  /**
   * Get the current budget status for an entire session.
   *
   * Includes per-task breakdown. Respects planning_costs_count_against_budget
   * configuration when summing total costs.
   *
   * @param sessionId - ID of the session
   * @returns SessionBudgetStatus with per-task breakdown and session totals
   */
  getSessionBudgetStatus(sessionId: string): Promise<SessionBudgetStatus>
}
