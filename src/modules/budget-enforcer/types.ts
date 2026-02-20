/**
 * BudgetEnforcer types — shared interfaces and type definitions for budget
 * enforcement (Story 4.3).
 *
 * Defines types for:
 *  - BudgetCheckResult: result of a budget check operation
 *  - BudgetStatus: budget status for a single task
 *  - SessionBudgetStatus: aggregate budget status for a session
 */

import type { TaskId } from '../../core/types.js'

// ---------------------------------------------------------------------------
// BudgetCheckResult
// ---------------------------------------------------------------------------

/**
 * Result returned by budget check operations.
 *
 * The `action` field indicates what should happen after the check:
 *  - 'continue': execution can proceed normally
 *  - 'terminate': the task's worker should be force-killed
 *  - 'terminate-all': all workers in the session should be terminated
 */
export interface BudgetCheckResult {
  exceeded: boolean
  action: 'continue' | 'terminate' | 'terminate-all'
  currentCostUsd: number
  budgetUsd: number
  percentageUsed: number
}

// ---------------------------------------------------------------------------
// BudgetStatus (per-task)
// ---------------------------------------------------------------------------

/**
 * Budget status snapshot for a single task.
 */
export interface BudgetStatus {
  taskId: TaskId
  budgetUsd: number
  currentCostUsd: number
  remainingBudgetUsd: number
  percentageUsed: number
  status: 'ok' | 'warning' | 'exceeded'
}

// ---------------------------------------------------------------------------
// SessionBudgetStatus
// ---------------------------------------------------------------------------

/**
 * Aggregate budget status for an entire session.
 *
 * Includes per-task breakdown and session-level totals.
 * Planning costs may or may not be included depending on config.
 */
export interface SessionBudgetStatus {
  sessionId: string
  budgetUsd: number
  /** Sum of all task costs (excludes or includes planning per config) */
  totalCostUsd: number
  remainingBudgetUsd: number
  percentageUsed: number
  status: 'ok' | 'warning' | 'exceeded'
  taskCount: number
  taskBudgets: BudgetStatus[]
}
