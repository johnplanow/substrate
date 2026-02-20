/**
 * Tests for BudgetEnforcerSubscriber (Story 4.3, Task 4).
 *
 * Covers subscriber event wiring:
 *  - AC5 via subscriber: task:routed with no budget_usd → default applied via recordTaskBudgetCap
 *  - AC1 flow via subscriber: cost:recorded → checkTaskBudget → budget:exceeded:task → worker terminated
 *  - AC3 flow via subscriber: cost:recorded → checkSessionBudget → session:budget:exceeded → all workers terminated
 *  - config:reloaded → updateConfig called with correct values (not empty object)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import type { Database as BetterSqlite3Database } from 'better-sqlite3'
import { TypedEventBusImpl } from '../../../core/event-bus.js'
import type { TypedEventBus } from '../../../core/event-bus.js'
import { BudgetEnforcerImpl, createBudgetEnforcer } from '../budget-enforcer-impl.js'
import { BudgetEnforcerSubscriber } from '../budget-enforcer-subscriber.js'
import type { WorkerPoolManager, WorkerInfo } from '../../worker-pool/worker-pool-manager.js'
import type { ConfigSystem } from '../../config/config-system.js'
import type { SubstrateConfig } from '../../config/config-schema.js'
import { runMigrations } from '../../../persistence/migrations/index.js'
import { getTask } from '../../../persistence/queries/tasks.js'

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
  sessionId: string,
  budgetUsd: number | null = null,
  totalCostUsd: number = 0,
): void {
  db.prepare(
    `INSERT INTO sessions (id, name, graph_file, status, budget_usd, total_cost_usd, planning_cost_usd)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(sessionId, 'Test Session', 'test-graph.yaml', 'active', budgetUsd, totalCostUsd, 0)
}

function createTestTask(
  db: BetterSqlite3Database,
  taskId: string,
  sessionId: string,
  budgetUsd: number | null = null,
  costUsd: number = 0,
): void {
  db.prepare(
    `INSERT INTO tasks (id, session_id, name, prompt, status, budget_usd, cost_usd)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(taskId, sessionId, `Task ${taskId}`, 'Do something', 'running', budgetUsd, costUsd)
}

function createMockWorkerPoolManager(activeWorkers: WorkerInfo[] = []): WorkerPoolManager {
  return {
    initialize: vi.fn().mockResolvedValue(undefined),
    shutdown: vi.fn().mockResolvedValue(undefined),
    spawnWorker: vi.fn(),
    terminateWorker: vi.fn(),
    terminateAll: vi.fn().mockResolvedValue(undefined),
    getActiveWorkers: vi.fn().mockReturnValue(activeWorkers),
    getWorkerCount: vi.fn().mockReturnValue(activeWorkers.length),
  } as unknown as WorkerPoolManager
}

function createMockConfigSystem(budgetConfig?: Partial<{
  default_task_budget_usd: number
  default_session_budget_usd: number
  planning_costs_count_against_budget: boolean
  warning_threshold_percent: number
}>): ConfigSystem {
  const fullConfig = {
    config_format_version: '1' as const,
    global: {
      log_level: 'info' as const,
      max_concurrent_tasks: 4,
      budget_cap_tokens: 0,
      budget_cap_usd: 0,
    },
    providers: {},
    budget: budgetConfig !== undefined
      ? {
          default_task_budget_usd: budgetConfig.default_task_budget_usd ?? 5.0,
          default_session_budget_usd: budgetConfig.default_session_budget_usd ?? 50.0,
          planning_costs_count_against_budget: budgetConfig.planning_costs_count_against_budget ?? false,
          warning_threshold_percent: budgetConfig.warning_threshold_percent ?? 80,
        }
      : undefined,
  } as SubstrateConfig

  return {
    load: vi.fn().mockResolvedValue(undefined),
    getConfig: vi.fn().mockReturnValue(fullConfig),
    get: vi.fn(),
    set: vi.fn().mockResolvedValue(undefined),
    getMasked: vi.fn().mockReturnValue(fullConfig),
    isLoaded: true,
  } as unknown as ConfigSystem
}

// ---------------------------------------------------------------------------
// BudgetEnforcerSubscriber tests
// ---------------------------------------------------------------------------

describe('BudgetEnforcerSubscriber', () => {
  let db: BetterSqlite3Database
  let eventBus: TypedEventBus
  let enforcer: BudgetEnforcerImpl
  let workerPoolManager: WorkerPoolManager
  let subscriber: BudgetEnforcerSubscriber

  beforeEach(async () => {
    db = createTestDb()
    eventBus = new TypedEventBusImpl()
    enforcer = createBudgetEnforcer({
      db,
      eventBus,
      config: {
        defaultTaskBudgetUsd: 10.0,
        defaultSessionBudgetUsd: 50.0,
        planningCostsCountAgainstBudget: false,
        warningThresholdPercent: 80,
      },
    })
    workerPoolManager = createMockWorkerPoolManager()
    subscriber = new BudgetEnforcerSubscriber(eventBus, enforcer, workerPoolManager, db)
    await subscriber.initialize()
  })

  afterEach(async () => {
    await subscriber.shutdown()
    db.close()
  })

  // -------------------------------------------------------------------------
  // AC5 via subscriber: task:routed with no budget_usd → default applied
  // -------------------------------------------------------------------------

  describe('AC5 via subscriber: task:routed applies default budget cap', () => {
    it('calls recordTaskBudgetCap when task has no budget_usd', async () => {
      createTestSession(db, 'session-1', 50.0)
      createTestTask(db, 'task-no-budget', 'session-1', null, 0)

      const budgetSetHandler = vi.fn()
      eventBus.on('task:budget-set', budgetSetHandler)

      // Emit task:routed for a task with no budget
      eventBus.emit('task:routed', {
        taskId: 'task-no-budget',
        decision: {
          taskId: 'task-no-budget',
          agent: 'claude',
          billingMode: 'api',
          rationale: 'test',
        },
      })

      // Give async handler time to execute
      await new Promise((resolve) => setTimeout(resolve, 10))

      // Default budget cap should have been applied
      expect(budgetSetHandler).toHaveBeenCalledOnce()
      expect(budgetSetHandler).toHaveBeenCalledWith(
        expect.objectContaining({
          taskId: 'task-no-budget',
          budgetUsd: 10.0, // defaultTaskBudgetUsd
        }),
      )

      // Verify the task record was updated in DB
      const updatedTask = getTask(db, 'task-no-budget')
      expect(updatedTask?.budget_usd).toBe(10.0)
    })

    it('does NOT call recordTaskBudgetCap when task already has budget_usd', async () => {
      createTestSession(db, 'session-1', 50.0)
      createTestTask(db, 'task-with-budget', 'session-1', 7.5, 0)

      const budgetSetHandler = vi.fn()
      eventBus.on('task:budget-set', budgetSetHandler)

      eventBus.emit('task:routed', {
        taskId: 'task-with-budget',
        decision: {
          taskId: 'task-with-budget',
          agent: 'claude',
          billingMode: 'api',
          rationale: 'test',
        },
      })

      await new Promise((resolve) => setTimeout(resolve, 10))

      // task:budget-set should NOT have been emitted (budget already set)
      expect(budgetSetHandler).not.toHaveBeenCalled()
    })

    it('does nothing when task is not found', async () => {
      const budgetSetHandler = vi.fn()
      eventBus.on('task:budget-set', budgetSetHandler)

      eventBus.emit('task:routed', {
        taskId: 'nonexistent-task',
        decision: {
          taskId: 'nonexistent-task',
          agent: 'claude',
          billingMode: 'api',
          rationale: 'test',
        },
      })

      await new Promise((resolve) => setTimeout(resolve, 10))

      expect(budgetSetHandler).not.toHaveBeenCalled()
    })
  })

  // -------------------------------------------------------------------------
  // AC1 flow via subscriber: cost:recorded → checkTaskBudget → budget:exceeded:task → worker terminated
  // -------------------------------------------------------------------------

  describe('AC1 flow via subscriber: cost:recorded triggers task budget exceeded', () => {
    it('terminates worker when cost:recorded triggers task budget exceeded', async () => {
      const workerId = 'worker-1'
      const taskId = 'task-over-budget'

      createTestSession(db, 'session-1', 50.0)
      createTestTask(db, taskId, 'session-1', 10.0, 10.0) // cost = 100% of budget

      // Set up worker pool with active worker for the task
      const activeWorker: WorkerInfo = {
        workerId,
        taskId,
        adapter: 'claude',
        status: 'running',
        startedAt: new Date(),
        elapsedMs: 100,
      }
      const wpm = createMockWorkerPoolManager([activeWorker])
      const sub2 = new BudgetEnforcerSubscriber(eventBus, enforcer, wpm, db)
      await sub2.initialize()

      eventBus.emit('cost:recorded', {
        taskId,
        sessionId: 'session-1',
        costUsd: 10.0,
        savingsUsd: 0,
        billingMode: 'api',
      })

      // Give async handler time to execute
      await new Promise((resolve) => setTimeout(resolve, 50))

      // terminateWorker should have been called with 'budget_exceeded'
      expect(wpm.terminateWorker).toHaveBeenCalledWith(workerId, 'budget_exceeded')

      // Task should be marked as failed with budget_exceeded
      const task = getTask(db, taskId)
      expect(task?.status).toBe('failed')
      expect(task?.error).toBe('budget_exceeded')
      expect(task?.budget_exceeded).toBe(1)

      await sub2.shutdown()
    })

    it('does not terminate when cost is below budget', async () => {
      createTestSession(db, 'session-1', 50.0)
      createTestTask(db, 'task-1', 'session-1', 10.0, 5.0) // 50% of budget

      const activeWorker: WorkerInfo = {
        workerId: 'worker-1',
        taskId: 'task-1',
        adapter: 'claude',
        status: 'running',
        startedAt: new Date(),
        elapsedMs: 0,
      }
      const wpm = createMockWorkerPoolManager([activeWorker])
      const sub2 = new BudgetEnforcerSubscriber(eventBus, enforcer, wpm, db)
      await sub2.initialize()

      eventBus.emit('cost:recorded', {
        taskId: 'task-1',
        sessionId: 'session-1',
        costUsd: 5.0,
        savingsUsd: 0,
        billingMode: 'api',
      })

      await new Promise((resolve) => setTimeout(resolve, 50))

      expect(wpm.terminateWorker).not.toHaveBeenCalled()

      await sub2.shutdown()
    })

    it('does nothing when task is not found in DB', async () => {
      const wpm = createMockWorkerPoolManager()
      const sub2 = new BudgetEnforcerSubscriber(eventBus, enforcer, wpm, db)
      await sub2.initialize()

      // No task exists in DB
      eventBus.emit('cost:recorded', {
        taskId: 'nonexistent',
        sessionId: 'session-1',
        costUsd: 99.0,
        savingsUsd: 0,
        billingMode: 'api',
      })

      await new Promise((resolve) => setTimeout(resolve, 50))

      expect(wpm.terminateWorker).not.toHaveBeenCalled()
      expect(wpm.terminateAll).not.toHaveBeenCalled()

      await sub2.shutdown()
    })
  })

  // -------------------------------------------------------------------------
  // AC3 flow via subscriber: session budget exceeded → all workers terminated
  // -------------------------------------------------------------------------

  describe('AC3 flow via subscriber: session budget exceeded terminates all workers', () => {
    it('calls terminateAll when session budget exceeded via cost:recorded', async () => {
      createTestSession(db, 'session-1', 50.0, 50.0) // total_cost_usd = budget
      createTestTask(db, 'task-1', 'session-1', 100.0, 50.0) // task budget high so task check passes

      const wpm = createMockWorkerPoolManager()
      const sub2 = new BudgetEnforcerSubscriber(eventBus, enforcer, wpm, db)
      await sub2.initialize()

      eventBus.emit('cost:recorded', {
        taskId: 'task-1',
        sessionId: 'session-1',
        costUsd: 50.0,
        savingsUsd: 0,
        billingMode: 'api',
      })

      await new Promise((resolve) => setTimeout(resolve, 50))

      // terminateAll should have been called
      expect(wpm.terminateAll).toHaveBeenCalled()

      // Session should be set to 'paused'
      const session = db.prepare('SELECT * FROM sessions WHERE id = ?').get('session-1') as { status: string } | undefined
      expect(session?.status).toBe('paused')

      await sub2.shutdown()
    })

    it('session:budget:exceeded event directly triggers terminateAll', async () => {
      createTestSession(db, 'session-1', 50.0)

      const wpm = createMockWorkerPoolManager()
      const sub2 = new BudgetEnforcerSubscriber(eventBus, enforcer, wpm, db)
      await sub2.initialize()

      eventBus.emit('session:budget:exceeded', {
        sessionId: 'session-1',
        currentCostUsd: 60.0,
        budgetUsd: 50.0,
      })

      await new Promise((resolve) => setTimeout(resolve, 10))

      expect(wpm.terminateAll).toHaveBeenCalled()

      // Session should be paused
      const session = db.prepare('SELECT * FROM sessions WHERE id = ?').get('session-1') as { status: string } | undefined
      expect(session?.status).toBe('paused')

      await sub2.shutdown()
    })
  })

  // -------------------------------------------------------------------------
  // config:reloaded → updateConfig called with correct values (not empty object)
  // -------------------------------------------------------------------------

  describe('config:reloaded applies actual config values', () => {
    it('calls updateConfig with budget values from configSystem when budget keys change', async () => {
      await subscriber.shutdown() // isolate from beforeEach subscriber
      const mockConfigSystem = createMockConfigSystem({
        default_task_budget_usd: 25.0,
        default_session_budget_usd: 200.0,
        planning_costs_count_against_budget: true,
        warning_threshold_percent: 70,
      })

      const sub2 = new BudgetEnforcerSubscriber(
        eventBus,
        enforcer,
        workerPoolManager,
        db,
        mockConfigSystem,
      )
      await sub2.initialize()

      const updateConfigSpy = vi.spyOn(enforcer, 'updateConfig')

      eventBus.emit('config:reloaded', { changedKeys: ['budget.default_task_budget_usd'] })

      expect(updateConfigSpy).toHaveBeenCalledOnce()
      expect(updateConfigSpy).toHaveBeenCalledWith({
        defaultTaskBudgetUsd: 25.0,
        defaultSessionBudgetUsd: 200.0,
        planningCostsCountAgainstBudget: true,
        warningThresholdPercent: 70,
      })
      await sub2.shutdown()
    })

    it('does NOT call updateConfig when non-budget keys change', () => {
      const mockConfigSystem = createMockConfigSystem({
        default_task_budget_usd: 25.0,
      })

      const sub2 = new BudgetEnforcerSubscriber(
        eventBus,
        enforcer,
        workerPoolManager,
        db,
        mockConfigSystem,
      )

      const updateConfigSpy = vi.spyOn(enforcer, 'updateConfig')

      eventBus.emit('config:reloaded', { changedKeys: ['global.log_level'] })

      expect(updateConfigSpy).not.toHaveBeenCalled()
    })

    it('calls updateConfig with empty object when configSystem is null', () => {
      // When no configSystem provided, updateConfig is called with {}
      const sub2 = new BudgetEnforcerSubscriber(
        eventBus,
        enforcer,
        workerPoolManager,
        db,
        null, // no configSystem
      )

      const updateConfigSpy = vi.spyOn(enforcer, 'updateConfig')

      eventBus.emit('config:reloaded', { changedKeys: ['budget.default_task_budget_usd'] })

      expect(updateConfigSpy).toHaveBeenCalledOnce()
      expect(updateConfigSpy).toHaveBeenCalledWith({})
    })

    it('calls updateConfig with empty object when configSystem.getConfig().budget is undefined', () => {
      // Config has no budget section
      const mockConfigSystem = createMockConfigSystem(undefined)

      const sub2 = new BudgetEnforcerSubscriber(
        eventBus,
        enforcer,
        workerPoolManager,
        db,
        mockConfigSystem,
      )

      const updateConfigSpy = vi.spyOn(enforcer, 'updateConfig')

      eventBus.emit('config:reloaded', { changedKeys: ['budget.default_task_budget_usd'] })

      expect(updateConfigSpy).toHaveBeenCalledOnce()
      expect(updateConfigSpy).toHaveBeenCalledWith({})
    })

    it('actually updates the enforcer config so future checks use new values', async () => {
      await subscriber.shutdown() // isolate from beforeEach subscriber
      createTestSession(db, 'session-1', 50.0)
      createTestTask(db, 'task-reload', 'session-1', null, 8.0) // no explicit budget

      // Default is 10.0 so 8.0 cost is 80% → warning threshold
      const task = getTask(db, 'task-reload')!
      const result1 = await enforcer.checkTaskBudget(task, 8.0)
      expect(result1.exceeded).toBe(false)
      expect(result1.budgetUsd).toBe(10.0)

      // Now reload config with a lower default budget (5.0)
      const mockConfigSystem = createMockConfigSystem({
        default_task_budget_usd: 5.0,
        default_session_budget_usd: 50.0,
        planning_costs_count_against_budget: false,
        warning_threshold_percent: 80,
      })

      const sub2 = new BudgetEnforcerSubscriber(
        eventBus,
        enforcer,
        workerPoolManager,
        db,
        mockConfigSystem,
      )
      await sub2.initialize()

      eventBus.emit('config:reloaded', { changedKeys: ['budget.default_task_budget_usd'] })

      // Now 8.0 cost with 5.0 default = 160% → exceeded
      const result2 = await enforcer.checkTaskBudget(task, 8.0)
      expect(result2.exceeded).toBe(true)
      expect(result2.budgetUsd).toBe(5.0)
      await sub2.shutdown()
    })
  })

  // -------------------------------------------------------------------------
  // Lifecycle: initialize / shutdown
  // -------------------------------------------------------------------------

  describe('lifecycle', () => {
    it('subscribe/unsubscribe handlers correctly', async () => {
      await subscriber.shutdown() // isolate from beforeEach subscriber
      const sub = new BudgetEnforcerSubscriber(eventBus, enforcer, workerPoolManager, db)

      createTestSession(db, 'session-lifecycle')
      createTestTask(db, 'task-lifecycle', 'session-lifecycle', 10.0, 10.0)

      const budgetSetHandler = vi.fn()
      eventBus.on('task:budget-set', budgetSetHandler)

      // Before initialize, handler not registered
      eventBus.emit('task:routed', {
        taskId: 'task-lifecycle',
        decision: { taskId: 'task-lifecycle', agent: 'claude', billingMode: 'api', rationale: 'test' },
      })
      await new Promise((resolve) => setTimeout(resolve, 10))
      // No handler should fire before init
      expect(budgetSetHandler).not.toHaveBeenCalled()

      // After initialize, handler fires
      await sub.initialize()
      createTestTask(db, 'task-lifecycle2', 'session-lifecycle', null, 0)
      eventBus.emit('task:routed', {
        taskId: 'task-lifecycle2',
        decision: { taskId: 'task-lifecycle2', agent: 'claude', billingMode: 'api', rationale: 'test' },
      })
      await new Promise((resolve) => setTimeout(resolve, 10))
      expect(budgetSetHandler).toHaveBeenCalled()

      // After shutdown, handlers no longer fire
      await sub.shutdown()
      budgetSetHandler.mockClear()
      createTestTask(db, 'task-lifecycle3', 'session-lifecycle', null, 0)
      eventBus.emit('task:routed', {
        taskId: 'task-lifecycle3',
        decision: { taskId: 'task-lifecycle3', agent: 'claude', billingMode: 'api', rationale: 'test' },
      })
      await new Promise((resolve) => setTimeout(resolve, 10))
      expect(budgetSetHandler).not.toHaveBeenCalled()
    })
  })
})
