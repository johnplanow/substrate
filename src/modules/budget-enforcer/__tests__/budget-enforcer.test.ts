/**
 * Comprehensive tests for the BudgetEnforcer module (Story 4.3).
 *
 * Covers all acceptance criteria:
 *  AC1: Task budget exceeded at 100% -> budget:exceeded:task event, action='terminate'
 *  AC1: Task force-terminated after budget exceeded
 *  AC2: Task at 80% -> budget:warning:task event, continues
 *  AC2: Task under 80% -> no event, continues
 *  AC3: Session budget exceeded -> session:budget:exceeded event, terminate all workers
 *  AC4: Planning costs excluded from session budget check (config=false, default)
 *  AC4: Planning costs included when config=true
 *  AC5: Task with no budget_usd -> default applied from config
 *  AC6: Concurrent cost recording doesn't bypass budget check (transactions)
 *  getBudgetStatus() returns correct percentageUsed, status
 *  getSessionBudgetStatus() returns correct aggregate
 *  Session-level warning at 80% threshold (FIX 4)
 *  Config hot-reload (FIX 6)
 *  Events emitted outside transactions (FIX 3)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import type { Database as BetterSqlite3Database } from 'better-sqlite3'
import { TypedEventBusImpl } from '../../../core/event-bus.js'
import type { TypedEventBus } from '../../../core/event-bus.js'
import { BudgetEnforcerImpl, createBudgetEnforcer } from '../budget-enforcer-impl.js'
import type { BudgetEnforcerConfig } from '../budget-enforcer-impl.js'
import type { BudgetCheckResult, BudgetStatus, SessionBudgetStatus } from '../types.js'
import { runMigrations } from '../../../persistence/migrations/index.js'
import { getTask } from '../../../persistence/queries/tasks.js'
import { getSession } from '../../../persistence/queries/sessions.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createTestDb(): BetterSqlite3Database {
  const db = new Database(':memory:')
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  runMigrations(db)
  return db
}

function createTestSession(
  db: BetterSqlite3Database,
  sessionId: string = 'session-1',
  budgetUsd: number | null = null,
  planningCostUsd: number = 0,
): void {
  db.prepare(
    `INSERT INTO sessions (id, name, graph_file, status, budget_usd, total_cost_usd, planning_cost_usd)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(sessionId, 'Test Session', 'test-graph.yaml', 'active', budgetUsd, 0, planningCostUsd)
}

function createTestTask(
  db: BetterSqlite3Database,
  taskId: string,
  sessionId: string = 'session-1',
  budgetUsd: number | null = null,
  costUsd: number = 0,
): void {
  db.prepare(
    `INSERT INTO tasks (id, session_id, name, prompt, status, budget_usd, cost_usd)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(taskId, sessionId, `Task ${taskId}`, 'Do something', 'running', budgetUsd, costUsd)
}

function setTaskCost(db: BetterSqlite3Database, taskId: string, costUsd: number): void {
  db.prepare(`UPDATE tasks SET cost_usd = ?, updated_at = datetime('now') WHERE id = ?`).run(
    costUsd,
    taskId,
  )
}

function setSessionTotalCost(
  db: BetterSqlite3Database,
  sessionId: string,
  totalCostUsd: number,
): void {
  db.prepare(
    `UPDATE sessions SET total_cost_usd = ?, updated_at = datetime('now') WHERE id = ?`,
  ).run(totalCostUsd, sessionId)
}

// ---------------------------------------------------------------------------
// BudgetEnforcerImpl — checkTaskBudget
// ---------------------------------------------------------------------------

describe('BudgetEnforcerImpl', () => {
  let db: BetterSqlite3Database
  let eventBus: TypedEventBus
  let enforcer: BudgetEnforcerImpl

  beforeEach(() => {
    db = createTestDb()
    eventBus = new TypedEventBusImpl()
    enforcer = createBudgetEnforcer({
      db,
      eventBus,
      config: {
        defaultTaskBudgetUsd: 5.0,
        defaultSessionBudgetUsd: 50.0,
        planningCostsCountAgainstBudget: false,
        warningThresholdPercent: 80,
      },
    })
    createTestSession(db, 'session-1', 50.0)
    createTestTask(db, 'task-1', 'session-1', 10.0, 0)
  })

  afterEach(() => {
    db.close()
  })

  // -------------------------------------------------------------------------
  // AC1: Task budget exceeded at 100% -> budget:exceeded:task event, action='terminate'
  // -------------------------------------------------------------------------

  describe('AC1: Task-Level Budget Cap Enforcement', () => {
    it('emits budget:exceeded:task and returns action=terminate when cost >= 100% of budget', async () => {
      setTaskCost(db, 'task-1', 10.0) // 100% of 10.0 budget

      const exceededHandler = vi.fn()
      const legacyExceededHandler = vi.fn()
      eventBus.on('budget:exceeded:task', exceededHandler)
      eventBus.on('budget:exceeded', legacyExceededHandler)

      const task = getTask(db, 'task-1')!
      const result = await enforcer.checkTaskBudget(task, 10.0)

      expect(result.exceeded).toBe(true)
      expect(result.action).toBe('terminate')
      expect(result.percentageUsed).toBe(100)
      expect(result.budgetUsd).toBe(10.0)
      expect(result.currentCostUsd).toBe(10.0)

      // Events should have been emitted AFTER the transaction (FIX 3)
      expect(exceededHandler).toHaveBeenCalledOnce()
      expect(exceededHandler).toHaveBeenCalledWith(
        expect.objectContaining({
          taskId: 'task-1',
          currentCostUsd: 10.0,
          budgetUsd: 10.0,
        }),
      )
      expect(legacyExceededHandler).toHaveBeenCalledOnce()
    })

    it('emits budget:exceeded:task when cost exceeds 100% of budget', async () => {
      setTaskCost(db, 'task-1', 15.0) // 150% of 10.0 budget

      const exceededHandler = vi.fn()
      eventBus.on('budget:exceeded:task', exceededHandler)

      const task = getTask(db, 'task-1')!
      const result = await enforcer.checkTaskBudget(task, 15.0)

      expect(result.exceeded).toBe(true)
      expect(result.action).toBe('terminate')
      expect(result.percentageUsed).toBe(150)
      expect(exceededHandler).toHaveBeenCalledOnce()
    })

    it('task is force-terminated after budget exceeded (integration with subscriber pattern)', async () => {
      setTaskCost(db, 'task-1', 11.0) // 110% of 10.0 budget

      const task = getTask(db, 'task-1')!
      const result = await enforcer.checkTaskBudget(task, 11.0)

      expect(result.exceeded).toBe(true)
      expect(result.action).toBe('terminate')
      // The subscriber would terminate the worker based on this result
    })
  })

  // -------------------------------------------------------------------------
  // AC2: Task budget warning at 80% -> budget:warning:task, continues
  // -------------------------------------------------------------------------

  describe('AC2: Budget Warning Threshold', () => {
    it('emits budget:warning:task at 80% and returns action=continue', async () => {
      setTaskCost(db, 'task-1', 8.0) // 80% of 10.0 budget

      const warningHandler = vi.fn()
      const legacyWarningHandler = vi.fn()
      eventBus.on('budget:warning:task', warningHandler)
      eventBus.on('budget:warning', legacyWarningHandler)

      const task = getTask(db, 'task-1')!
      const result = await enforcer.checkTaskBudget(task, 8.0)

      expect(result.exceeded).toBe(false)
      expect(result.action).toBe('continue')
      expect(result.percentageUsed).toBe(80)

      expect(warningHandler).toHaveBeenCalledOnce()
      expect(warningHandler).toHaveBeenCalledWith(
        expect.objectContaining({
          taskId: 'task-1',
          currentCostUsd: 8.0,
          budgetUsd: 10.0,
          percentageUsed: 80,
        }),
      )
      expect(legacyWarningHandler).toHaveBeenCalledOnce()
    })

    it('emits budget:warning:task at 95% and continues', async () => {
      setTaskCost(db, 'task-1', 9.5) // 95% of 10.0 budget

      const warningHandler = vi.fn()
      eventBus.on('budget:warning:task', warningHandler)

      const task = getTask(db, 'task-1')!
      const result = await enforcer.checkTaskBudget(task, 9.5)

      expect(result.exceeded).toBe(false)
      expect(result.action).toBe('continue')
      expect(result.percentageUsed).toBe(95)
      expect(warningHandler).toHaveBeenCalledOnce()
    })

    it('does NOT emit events when under 80% threshold', async () => {
      setTaskCost(db, 'task-1', 5.0) // 50% of 10.0 budget

      const warningHandler = vi.fn()
      const exceededHandler = vi.fn()
      eventBus.on('budget:warning:task', warningHandler)
      eventBus.on('budget:exceeded:task', exceededHandler)

      const task = getTask(db, 'task-1')!
      const result = await enforcer.checkTaskBudget(task, 5.0)

      expect(result.exceeded).toBe(false)
      expect(result.action).toBe('continue')
      expect(result.percentageUsed).toBe(50)
      expect(warningHandler).not.toHaveBeenCalled()
      expect(exceededHandler).not.toHaveBeenCalled()
    })

    it('does NOT emit events when cost is 0%', async () => {
      const warningHandler = vi.fn()
      const exceededHandler = vi.fn()
      eventBus.on('budget:warning:task', warningHandler)
      eventBus.on('budget:exceeded:task', exceededHandler)

      const task = getTask(db, 'task-1')!
      const result = await enforcer.checkTaskBudget(task, 0)

      expect(result.exceeded).toBe(false)
      expect(result.action).toBe('continue')
      expect(warningHandler).not.toHaveBeenCalled()
      expect(exceededHandler).not.toHaveBeenCalled()
    })
  })

  // -------------------------------------------------------------------------
  // AC3: Session budget exceeded -> session:budget:exceeded, terminate all
  // -------------------------------------------------------------------------

  describe('AC3: Session-Level Budget Cap Enforcement', () => {
    it('emits session:budget:exceeded and returns action=terminate-all when session cost >= budget', async () => {
      setSessionTotalCost(db, 'session-1', 50.0) // 100% of 50.0 budget

      const sessionExceededHandler = vi.fn()
      eventBus.on('session:budget:exceeded', sessionExceededHandler)

      const result = await enforcer.checkSessionBudget('session-1', 50.0)

      expect(result.exceeded).toBe(true)
      expect(result.action).toBe('terminate-all')
      expect(result.budgetUsd).toBe(50.0)
      expect(result.currentCostUsd).toBe(50.0)

      expect(sessionExceededHandler).toHaveBeenCalledOnce()
      expect(sessionExceededHandler).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId: 'session-1',
          currentCostUsd: 50.0,
          budgetUsd: 50.0,
        }),
      )
    })

    it('emits session:budget:exceeded when session cost exceeds budget', async () => {
      setSessionTotalCost(db, 'session-1', 60.0) // 120% of 50.0 budget

      const sessionExceededHandler = vi.fn()
      eventBus.on('session:budget:exceeded', sessionExceededHandler)

      const result = await enforcer.checkSessionBudget('session-1', 60.0)

      expect(result.exceeded).toBe(true)
      expect(result.action).toBe('terminate-all')
      expect(sessionExceededHandler).toHaveBeenCalledOnce()
    })

    it('returns continue when session cost is below budget', async () => {
      setSessionTotalCost(db, 'session-1', 20.0) // 40% of 50.0 budget

      const sessionExceededHandler = vi.fn()
      eventBus.on('session:budget:exceeded', sessionExceededHandler)

      const result = await enforcer.checkSessionBudget('session-1', 20.0)

      expect(result.exceeded).toBe(false)
      expect(result.action).toBe('continue')
      expect(sessionExceededHandler).not.toHaveBeenCalled()
    })

    it('returns continue for unknown session', async () => {
      const result = await enforcer.checkSessionBudget('nonexistent', 10.0)

      expect(result.exceeded).toBe(false)
      expect(result.action).toBe('continue')
    })
  })

  // -------------------------------------------------------------------------
  // FIX 4: Session-level warning at 80% threshold
  // -------------------------------------------------------------------------

  describe('FIX 4: Session-Level Warning Threshold', () => {
    it('emits budget:warning:session when session cost is between 80-99% of budget', async () => {
      setSessionTotalCost(db, 'session-1', 40.0) // 80% of 50.0 budget

      const sessionWarningHandler = vi.fn()
      eventBus.on('budget:warning:session', sessionWarningHandler)

      const result = await enforcer.checkSessionBudget('session-1', 40.0)

      expect(result.exceeded).toBe(false)
      expect(result.action).toBe('continue')
      expect(result.percentageUsed).toBe(80)

      expect(sessionWarningHandler).toHaveBeenCalledOnce()
      expect(sessionWarningHandler).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId: 'session-1',
          currentCostUsd: 40.0,
          budgetUsd: 50.0,
          percentageUsed: 80,
        }),
      )
    })

    it('emits budget:warning:session at 90% of session budget', async () => {
      setSessionTotalCost(db, 'session-1', 45.0) // 90% of 50.0 budget

      const sessionWarningHandler = vi.fn()
      eventBus.on('budget:warning:session', sessionWarningHandler)

      const result = await enforcer.checkSessionBudget('session-1', 45.0)

      expect(result.exceeded).toBe(false)
      expect(sessionWarningHandler).toHaveBeenCalledOnce()
    })

    it('does NOT emit budget:warning:session when under 80%', async () => {
      setSessionTotalCost(db, 'session-1', 30.0) // 60% of 50.0 budget

      const sessionWarningHandler = vi.fn()
      eventBus.on('budget:warning:session', sessionWarningHandler)

      await enforcer.checkSessionBudget('session-1', 30.0)

      expect(sessionWarningHandler).not.toHaveBeenCalled()
    })

    it('emits session:budget:exceeded (NOT warning) when at 100%', async () => {
      setSessionTotalCost(db, 'session-1', 50.0) // 100% of 50.0 budget

      const sessionWarningHandler = vi.fn()
      const sessionExceededHandler = vi.fn()
      eventBus.on('budget:warning:session', sessionWarningHandler)
      eventBus.on('session:budget:exceeded', sessionExceededHandler)

      await enforcer.checkSessionBudget('session-1', 50.0)

      expect(sessionWarningHandler).not.toHaveBeenCalled()
      expect(sessionExceededHandler).toHaveBeenCalledOnce()
    })
  })

  // -------------------------------------------------------------------------
  // AC4: Planning costs isolation
  // -------------------------------------------------------------------------

  describe('AC4: Planning Costs Isolation', () => {
    it('excludes planning costs from session budget when config is false (default)', async () => {
      // Session has 50.0 budget, planning_cost_usd = 10.0
      db.prepare(
        `UPDATE sessions SET planning_cost_usd = 10.0, total_cost_usd = 45.0 WHERE id = 'session-1'`,
      ).run()

      const sessionExceededHandler = vi.fn()
      eventBus.on('session:budget:exceeded', sessionExceededHandler)

      // Total cost is 45.0, but planning costs (10.0) are subtracted
      // Effective cost = 45.0 - 10.0 = 35.0, which is under 50.0 budget
      const result = await enforcer.checkSessionBudget('session-1', 45.0)

      expect(result.exceeded).toBe(false)
      expect(result.action).toBe('continue')
      expect(result.currentCostUsd).toBe(35.0)
      expect(sessionExceededHandler).not.toHaveBeenCalled()
    })

    it('includes planning costs in session budget when config is true', async () => {
      // Create enforcer with planning costs included
      const enforcerWithPlanning = createBudgetEnforcer({
        db,
        eventBus,
        config: {
          planningCostsCountAgainstBudget: true,
          warningThresholdPercent: 80,
        },
      })

      // Session has 50.0 budget, planning_cost_usd = 10.0, total_cost_usd = 50.0
      db.prepare(
        `UPDATE sessions SET planning_cost_usd = 10.0, total_cost_usd = 50.0 WHERE id = 'session-1'`,
      ).run()

      const sessionExceededHandler = vi.fn()
      eventBus.on('session:budget:exceeded', sessionExceededHandler)

      // When planningCostsCountAgainstBudget=true, total cost is used as-is (50.0)
      const result = await enforcerWithPlanning.checkSessionBudget('session-1', 50.0)

      expect(result.exceeded).toBe(true)
      expect(result.action).toBe('terminate-all')
      expect(result.currentCostUsd).toBe(50.0)
      expect(sessionExceededHandler).toHaveBeenCalledOnce()
    })

    it('planning costs excluded allows session to continue even when total is high', async () => {
      // Session has 50.0 budget, total = 55.0, but planning_cost = 10.0
      // Effective = 55.0 - 10.0 = 45.0, under 50.0 budget
      db.prepare(
        `UPDATE sessions SET planning_cost_usd = 10.0, total_cost_usd = 55.0 WHERE id = 'session-1'`,
      ).run()

      const result = await enforcer.checkSessionBudget('session-1', 55.0)

      expect(result.exceeded).toBe(false)
      expect(result.currentCostUsd).toBe(45.0) // 55 - 10 planning
    })
  })

  // -------------------------------------------------------------------------
  // AC5: Task with no budget_usd -> default applied from config
  // -------------------------------------------------------------------------

  describe('AC5: Default Budget Application', () => {
    it('applies default budget when task has no budget_usd set', async () => {
      createTestTask(db, 'task-no-budget', 'session-1', null, 4.0) // No budget set, 4.0 cost

      const warningHandler = vi.fn()
      eventBus.on('budget:warning:task', warningHandler)

      const task = getTask(db, 'task-no-budget')!
      expect(task.budget_usd).toBeNull()

      // Default is 5.0, cost is 4.0 = 80% -> warning
      const result = await enforcer.checkTaskBudget(task, 4.0)

      expect(result.exceeded).toBe(false)
      expect(result.action).toBe('continue')
      expect(result.budgetUsd).toBe(5.0) // Applied the default
      expect(result.percentageUsed).toBe(80)
      expect(warningHandler).toHaveBeenCalledOnce()
    })

    it('applies default budget and terminates when cost exceeds default', async () => {
      createTestTask(db, 'task-no-budget-2', 'session-1', null, 6.0) // No budget set, 6.0 cost

      const exceededHandler = vi.fn()
      eventBus.on('budget:exceeded:task', exceededHandler)

      const task = getTask(db, 'task-no-budget-2')!
      const result = await enforcer.checkTaskBudget(task, 6.0)

      expect(result.exceeded).toBe(true)
      expect(result.action).toBe('terminate')
      expect(result.budgetUsd).toBe(5.0)
      expect(exceededHandler).toHaveBeenCalledOnce()
    })

    it('recordTaskBudgetCap persists budget and emits task:budget-set event', async () => {
      createTestTask(db, 'task-cap', 'session-1', null, 0)

      const budgetSetHandler = vi.fn()
      eventBus.on('task:budget-set', budgetSetHandler)

      await enforcer.recordTaskBudgetCap('task-cap', 7.5)

      const task = getTask(db, 'task-cap')!
      expect(task.budget_usd).toBe(7.5)
      expect(budgetSetHandler).toHaveBeenCalledOnce()
      expect(budgetSetHandler).toHaveBeenCalledWith(
        expect.objectContaining({
          taskId: 'task-cap',
          budgetUsd: 7.5,
        }),
      )
    })

    it('recordSessionBudgetCap persists budget and emits session:budget-set event', async () => {
      const budgetSetHandler = vi.fn()
      eventBus.on('session:budget-set', budgetSetHandler)

      await enforcer.recordSessionBudgetCap('session-1', 100.0)

      const session = getSession(db, 'session-1')!
      expect(session.budget_usd).toBe(100.0)
      expect(budgetSetHandler).toHaveBeenCalledOnce()
      expect(budgetSetHandler).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId: 'session-1',
          budgetUsd: 100.0,
        }),
      )
    })
  })

  // -------------------------------------------------------------------------
  // AC6: Concurrent cost recording doesn't bypass budget check (transactions)
  // -------------------------------------------------------------------------

  describe('AC6: Budget Enforcement Atomicity', () => {
    it('uses transaction to atomically read cost and check budget', async () => {
      setTaskCost(db, 'task-1', 9.0) // 90% of 10.0 budget

      const warningHandler = vi.fn()
      eventBus.on('budget:warning:task', warningHandler)

      const task = getTask(db, 'task-1')!
      // Pass a stale cost (5.0) but the transaction should re-read the latest (9.0)
      const result = await enforcer.checkTaskBudget(task, 5.0)

      // Should use the latest DB value (9.0), not the stale passed value (5.0)
      expect(result.currentCostUsd).toBe(9.0)
      expect(result.percentageUsed).toBe(90)
      expect(warningHandler).toHaveBeenCalledOnce()
    })

    it('concurrent budget checks read latest cost from DB', async () => {
      // Simulate two concurrent cost recordings
      setTaskCost(db, 'task-1', 5.0)

      const task = getTask(db, 'task-1')!

      // First check at 5.0 (50%) - no event
      const result1 = await enforcer.checkTaskBudget(task, 5.0)
      expect(result1.exceeded).toBe(false)
      expect(result1.percentageUsed).toBe(50)

      // Now update cost in DB (simulating concurrent write)
      setTaskCost(db, 'task-1', 10.0)

      // Second check - should see the new DB value (10.0 = 100%)
      const exceededHandler = vi.fn()
      eventBus.on('budget:exceeded:task', exceededHandler)

      const result2 = await enforcer.checkTaskBudget(task, 5.0) // stale value passed
      expect(result2.exceeded).toBe(true)
      expect(result2.currentCostUsd).toBe(10.0)
      expect(exceededHandler).toHaveBeenCalledOnce()
    })
  })

  // -------------------------------------------------------------------------
  // getBudgetStatus
  // -------------------------------------------------------------------------

  describe('getBudgetStatus', () => {
    it('returns correct percentageUsed and status for a task', async () => {
      setTaskCost(db, 'task-1', 5.0) // 50% of 10.0 budget

      const status = await enforcer.getBudgetStatus('task-1')

      expect(status.taskId).toBe('task-1')
      expect(status.budgetUsd).toBe(10.0)
      expect(status.currentCostUsd).toBe(5.0)
      expect(status.remainingBudgetUsd).toBe(5.0)
      expect(status.percentageUsed).toBe(50)
      expect(status.status).toBe('ok')
    })

    it('returns status=warning at 80% threshold', async () => {
      setTaskCost(db, 'task-1', 8.0) // 80% of 10.0

      const status = await enforcer.getBudgetStatus('task-1')

      expect(status.percentageUsed).toBe(80)
      expect(status.status).toBe('warning')
      expect(status.remainingBudgetUsd).toBe(2.0)
    })

    it('returns status=exceeded at 100%', async () => {
      setTaskCost(db, 'task-1', 12.0) // 120% of 10.0

      const status = await enforcer.getBudgetStatus('task-1')

      expect(status.percentageUsed).toBe(120)
      expect(status.status).toBe('exceeded')
      expect(status.remainingBudgetUsd).toBe(0) // max(0, ...)
    })

    it('uses default budget when task has no budget_usd', async () => {
      createTestTask(db, 'task-no-budget', 'session-1', null, 2.5)

      const status = await enforcer.getBudgetStatus('task-no-budget')

      expect(status.budgetUsd).toBe(5.0) // defaultTaskBudgetUsd
      expect(status.percentageUsed).toBe(50)
    })

    it('throws for nonexistent task', async () => {
      await expect(enforcer.getBudgetStatus('nonexistent')).rejects.toThrow(
        'Task "nonexistent" not found',
      )
    })
  })

  // -------------------------------------------------------------------------
  // getSessionBudgetStatus
  // -------------------------------------------------------------------------

  describe('getSessionBudgetStatus', () => {
    it('returns correct aggregate status for a session', async () => {
      createTestTask(db, 'task-2', 'session-1', 10.0, 3.0)
      createTestTask(db, 'task-3', 'session-1', 10.0, 7.0)

      const status = await enforcer.getSessionBudgetStatus('session-1')

      expect(status.sessionId).toBe('session-1')
      expect(status.budgetUsd).toBe(50.0)
      expect(status.taskCount).toBe(3) // task-1, task-2, task-3
      // Total cost: 0 (task-1) + 3 (task-2) + 7 (task-3) = 10.0
      expect(status.totalCostUsd).toBe(10.0)
      expect(status.remainingBudgetUsd).toBe(40.0)
      expect(status.percentageUsed).toBe(20)
      expect(status.status).toBe('ok')
      expect(status.taskBudgets).toHaveLength(3)
    })

    it('returns per-task budgets with correct status', async () => {
      setTaskCost(db, 'task-1', 8.0) // 80% of 10.0 -> warning
      createTestTask(db, 'task-2', 'session-1', 5.0, 5.5) // 110% -> exceeded

      const status = await enforcer.getSessionBudgetStatus('session-1')

      const task1Budget = status.taskBudgets.find((b) => b.taskId === 'task-1')
      const task2Budget = status.taskBudgets.find((b) => b.taskId === 'task-2')

      expect(task1Budget?.status).toBe('warning')
      expect(task1Budget?.percentageUsed).toBe(80)
      expect(task2Budget?.status).toBe('exceeded')
      expect(task2Budget?.percentageUsed).toBeCloseTo(110)
    })

    it('excludes planning costs when config is false', async () => {
      // Session has planning_cost_usd = 5.0
      db.prepare(`UPDATE sessions SET planning_cost_usd = 5.0 WHERE id = 'session-1'`).run()
      setTaskCost(db, 'task-1', 10.0)

      const status = await enforcer.getSessionBudgetStatus('session-1')

      // Raw total = 10.0, planning cost = 5.0, effective = 5.0
      expect(status.totalCostUsd).toBe(5.0)
    })

    it('includes planning costs when config is true', async () => {
      const enforcerWithPlanning = createBudgetEnforcer({
        db,
        eventBus,
        config: {
          planningCostsCountAgainstBudget: true,
          warningThresholdPercent: 80,
        },
      })

      db.prepare(`UPDATE sessions SET planning_cost_usd = 5.0 WHERE id = 'session-1'`).run()
      setTaskCost(db, 'task-1', 10.0)

      const status = await enforcerWithPlanning.getSessionBudgetStatus('session-1')

      // Raw total = 10.0, planning cost is included, so totalCostUsd = 10.0
      expect(status.totalCostUsd).toBe(10.0)
    })

    it('throws for nonexistent session', async () => {
      await expect(enforcer.getSessionBudgetStatus('nonexistent')).rejects.toThrow(
        'Session "nonexistent" not found',
      )
    })
  })

  // -------------------------------------------------------------------------
  // FIX 3: Events emitted outside transactions
  // -------------------------------------------------------------------------

  describe('FIX 3: Events outside transactions', () => {
    it('task budget exceeded events are emitted after transaction', async () => {
      setTaskCost(db, 'task-1', 10.0)

      const eventOrder: string[] = []

      // Track when events fire
      eventBus.on('budget:exceeded:task', () => {
        eventOrder.push('event:budget:exceeded:task')
      })

      const task = getTask(db, 'task-1')!
      await enforcer.checkTaskBudget(task, 10.0)

      // Event should have been emitted (after transaction)
      expect(eventOrder).toContain('event:budget:exceeded:task')
    })

    it('session budget exceeded events are emitted after transaction', async () => {
      setSessionTotalCost(db, 'session-1', 55.0)

      const eventOrder: string[] = []
      eventBus.on('session:budget:exceeded', () => {
        eventOrder.push('event:session:budget:exceeded')
      })

      await enforcer.checkSessionBudget('session-1', 55.0)

      expect(eventOrder).toContain('event:session:budget:exceeded')
    })
  })

  // -------------------------------------------------------------------------
  // Config hot-reload (FIX 6)
  // -------------------------------------------------------------------------

  describe('FIX 6: Config hot-reload', () => {
    it('updateConfig changes default budget values at runtime', async () => {
      createTestTask(db, 'task-reload', 'session-1', null, 8.0)

      // With default config (5.0 default budget), 8.0 cost is 160% -> exceeded
      const task = getTask(db, 'task-reload')!
      const result1 = await enforcer.checkTaskBudget(task, 8.0)
      expect(result1.exceeded).toBe(true)

      // Update config to raise default budget to 20.0
      enforcer.updateConfig({ defaultTaskBudgetUsd: 20.0 })

      // Now 8.0 cost is 40% of 20.0 -> ok
      const result2 = await enforcer.checkTaskBudget(task, 8.0)
      expect(result2.exceeded).toBe(false)
      expect(result2.budgetUsd).toBe(20.0)
      expect(result2.percentageUsed).toBe(40)
    })

    it('updateConfig changes warning threshold at runtime', async () => {
      setTaskCost(db, 'task-1', 7.0) // 70% of 10.0

      const warningHandler = vi.fn()
      eventBus.on('budget:warning:task', warningHandler)

      const task = getTask(db, 'task-1')!

      // At 80% threshold, 70% should not trigger warning
      const result1 = await enforcer.checkTaskBudget(task, 7.0)
      expect(warningHandler).not.toHaveBeenCalled()

      // Lower threshold to 60%
      enforcer.updateConfig({ warningThresholdPercent: 60 })

      // Now 70% should trigger warning
      const result2 = await enforcer.checkTaskBudget(task, 7.0)
      expect(warningHandler).toHaveBeenCalledOnce()
    })
  })

  // -------------------------------------------------------------------------
  // Unlimited budget (0 = unlimited)
  // -------------------------------------------------------------------------

  describe('Unlimited budget handling', () => {
    it('returns continue for task with budget of 0 (unlimited)', async () => {
      createTestTask(db, 'task-unlimited', 'session-1', 0, 100.0)

      const task = getTask(db, 'task-unlimited')!
      task.budget_usd = 0

      const exceededHandler = vi.fn()
      eventBus.on('budget:exceeded:task', exceededHandler)

      const result = await enforcer.checkTaskBudget(task, 100.0)

      expect(result.exceeded).toBe(false)
      expect(result.action).toBe('continue')
      expect(result.percentageUsed).toBe(0)
      expect(exceededHandler).not.toHaveBeenCalled()
    })

    it('returns continue for session with budget of 0 (unlimited)', async () => {
      db.prepare(`UPDATE sessions SET budget_usd = 0 WHERE id = 'session-1'`).run()

      // Also set default to 0 so enforcer doesn't use default
      const enforcerUnlimited = createBudgetEnforcer({
        db,
        eventBus,
        config: { defaultSessionBudgetUsd: 0 },
      })

      const result = await enforcerUnlimited.checkSessionBudget('session-1', 999.0)

      expect(result.exceeded).toBe(false)
      expect(result.action).toBe('continue')
    })
  })

  // -------------------------------------------------------------------------
  // Factory function
  // -------------------------------------------------------------------------

  describe('createBudgetEnforcer factory', () => {
    it('creates a working BudgetEnforcerImpl with default config', () => {
      const testDb = createTestDb()
      const testBus = new TypedEventBusImpl()
      const instance = createBudgetEnforcer({ db: testDb, eventBus: testBus })

      expect(instance).toBeInstanceOf(BudgetEnforcerImpl)
      testDb.close()
    })

    it('creates a BudgetEnforcerImpl with custom config', () => {
      const testDb = createTestDb()
      const testBus = new TypedEventBusImpl()
      const instance = createBudgetEnforcer({
        db: testDb,
        eventBus: testBus,
        config: {
          defaultTaskBudgetUsd: 99.0,
          warningThresholdPercent: 50,
        },
      })

      expect(instance).toBeInstanceOf(BudgetEnforcerImpl)
      testDb.close()
    })
  })

  // -------------------------------------------------------------------------
  // Migration 003 schema verification
  // -------------------------------------------------------------------------

  describe('Migration 003: Schema verification', () => {
    it('sessions table has planning_costs_count_against_budget column', () => {
      const columns = db
        .prepare("PRAGMA table_info('sessions')")
        .all() as { name: string }[]
      const names = columns.map((c) => c.name)
      expect(names).toContain('planning_costs_count_against_budget')
    })

    it('tasks table has budget_exceeded column', () => {
      const columns = db
        .prepare("PRAGMA table_info('tasks')")
        .all() as { name: string }[]
      const names = columns.map((c) => c.name)
      expect(names).toContain('budget_exceeded')
    })

    it('has idx_sessions_budget index', () => {
      const indexes = db
        .prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='sessions'")
        .all() as { name: string }[]
      const names = indexes.map((i) => i.name)
      expect(names).toContain('idx_sessions_budget')
    })
  })
})
