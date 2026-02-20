/**
 * Epic 4 — Intelligent Routing & Cost Governance
 * End-to-End / Integration Tests
 *
 * This test file covers cross-story integration gaps that are NOT covered by
 * individual story unit tests:
 *
 * GAP 1: Full pipeline — routing → cost recording → budget enforcement
 *   task:ready → RoutingEngine routes → task:routed → CostTrackerSubscriber caches
 *   → task:complete → CostTrackerSubscriber records → cost:recorded
 *   → BudgetEnforcerSubscriber checks → budget events emitted
 *
 * GAP 2: Budget enforcement triggered by real cost tracker output
 *   (not mocked CostTracker — actual DB writes from CostTrackerImpl)
 *
 * GAP 3: CLI cost command reads real DB data written by CostTrackerImpl
 *   (not mocked queries — actual SQLite in-memory DB via DatabaseWrapper)
 *
 * GAP 4: Multi-task session — costs accumulate across tasks until session budget exceeded
 *
 * GAP 5: Subscription routing saves costs visible in CLI report
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import type { Database as BetterSqlite3Database } from 'better-sqlite3'
import * as os from 'os'
import * as path from 'path'
import * as fs from 'fs'

import { TypedEventBusImpl } from '../core/event-bus.js'
import type { TypedEventBus } from '../core/event-bus.js'
import { runMigrations } from '../persistence/migrations/index.js'
import { CostTrackerImpl, createCostTracker } from '../modules/cost-tracker/cost-tracker-impl.js'
import { CostTrackerSubscriber, createCostTrackerSubscriber } from '../modules/cost-tracker/cost-tracker-subscriber.js'
import { BudgetEnforcerImpl, createBudgetEnforcer } from '../modules/budget-enforcer/budget-enforcer-impl.js'
import { BudgetEnforcerSubscriber } from '../modules/budget-enforcer/budget-enforcer-subscriber.js'
import { getAllCostEntries, getSessionCostSummary } from '../persistence/queries/cost.js'
import { getSession } from '../persistence/queries/sessions.js'
import { getTask } from '../persistence/queries/tasks.js'
import { runCostAction } from '../cli/commands/cost.js'

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
  sessionId: string = 'session-e2e',
  budgetUsd: number | null = null,
): void {
  db.prepare(
    `INSERT INTO sessions (id, name, graph_file, status, budget_usd, total_cost_usd, planning_cost_usd)
     VALUES (?, ?, ?, ?, ?, 0, 0)`,
  ).run(sessionId, 'E2E Test Session', 'test-graph.yaml', 'active', budgetUsd)
}

function createTestTask(
  db: BetterSqlite3Database,
  taskId: string,
  sessionId: string = 'session-e2e',
  budgetUsd: number | null = null,
): void {
  db.prepare(
    `INSERT INTO tasks (id, session_id, name, prompt, status, budget_usd, cost_usd)
     VALUES (?, ?, ?, ?, ?, ?, 0)`,
  ).run(taskId, sessionId, `Task ${taskId}`, 'Do something', 'running', budgetUsd)
}

/** Create a mock WorkerPoolManager that records terminated workers */
function createMockWorkerPoolManager(activeWorkers: Array<{ workerId: string; taskId: string }> = []) {
  const terminatedWorkers: string[] = []
  const terminateAllCalled: boolean[] = []

  return {
    getActiveWorkers: vi.fn(() => activeWorkers),
    terminateWorker: vi.fn((workerId: string, _reason: string) => {
      terminatedWorkers.push(workerId)
    }),
    terminateAll: vi.fn(async () => {
      terminateAllCalled.push(true)
    }),
    _terminatedWorkers: terminatedWorkers,
    _terminateAllCalled: terminateAllCalled,
  }
}

// ---------------------------------------------------------------------------
// GAP 1: Full routing → cost recording → budget enforcement pipeline
// ---------------------------------------------------------------------------

describe('GAP 1: Full Pipeline — Routing → Cost Recording → Budget Enforcement', () => {
  let db: BetterSqlite3Database
  let eventBus: TypedEventBus
  let costTracker: CostTrackerImpl
  let costSubscriber: CostTrackerSubscriber
  let budgetEnforcer: BudgetEnforcerImpl
  let budgetSubscriber: BudgetEnforcerSubscriber
  let mockWorkerPool: ReturnType<typeof createMockWorkerPoolManager>

  beforeEach(async () => {
    db = createTestDb()
    eventBus = new TypedEventBusImpl()

    // Set up all components wired together via the real EventBus
    costTracker = createCostTracker({ db, eventBus }) as CostTrackerImpl
    costSubscriber = createCostTrackerSubscriber({ eventBus, costTracker, sessionId: 'session-e2e' })

    budgetEnforcer = createBudgetEnforcer({
      db,
      eventBus,
      config: {
        defaultTaskBudgetUsd: 1.0,    // $1 per task
        defaultSessionBudgetUsd: 5.0,  // $5 session cap
        warningThresholdPercent: 80,
        planningCostsCountAgainstBudget: false,
      },
    })

    mockWorkerPool = createMockWorkerPoolManager([
      { workerId: 'worker-task-1', taskId: 'task-1' },
      { workerId: 'worker-task-2', taskId: 'task-2' },
    ])

    budgetSubscriber = new BudgetEnforcerSubscriber(
      eventBus,
      budgetEnforcer,
      mockWorkerPool as never,
      db,
      null,
    )

    createTestSession(db, 'session-e2e', 5.0)
    createTestTask(db, 'task-1', 'session-e2e', 1.0)
    createTestTask(db, 'task-2', 'session-e2e', 1.0)

    await costSubscriber.initialize()
    await budgetSubscriber.initialize()
  })

  afterEach(async () => {
    await costSubscriber.shutdown()
    await budgetSubscriber.shutdown()
    db.close()
  })

  it('records cost when task:routed then task:complete fire via real event bus', async () => {
    // Simulate the routing engine emitting task:routed
    eventBus.emit('task:routed', {
      taskId: 'task-1',
      decision: {
        taskId: 'task-1',
        agent: 'claude',
        billingMode: 'api',
        model: 'claude-3-sonnet',
        rationale: 'API billing selected',
      },
    })

    // Simulate task completing
    eventBus.emit('task:complete', {
      taskId: 'task-1',
      result: { tokensUsed: 4000, exitCode: 0 },
    })

    // Allow async budget checks to complete
    await new Promise<void>((resolve) => setTimeout(resolve, 10))

    // Verify cost was recorded in the real DB
    const entries = getAllCostEntries(db, 'session-e2e')
    expect(entries).toHaveLength(1)
    expect(entries[0]!.task_id).toBe('task-1')
    expect(entries[0]!.agent).toBe('claude')
    expect(entries[0]!.billing_mode).toBe('api')
    expect(entries[0]!.cost_usd).toBeGreaterThan(0)

    // Verify task cost was updated in tasks table
    const task = getTask(db, 'task-1')
    expect(task?.cost_usd).toBeGreaterThan(0)
  })

  it('subscription routing records zero cost with positive savings', async () => {
    eventBus.emit('task:routed', {
      taskId: 'task-1',
      decision: {
        taskId: 'task-1',
        agent: 'claude',
        billingMode: 'subscription',
        model: 'claude-3-sonnet',
        rationale: 'Subscription-first routing selected',
      },
    })

    eventBus.emit('task:complete', {
      taskId: 'task-1',
      result: { tokensUsed: 4000, exitCode: 0 },
    })

    await new Promise<void>((resolve) => setTimeout(resolve, 10))

    const entries = getAllCostEntries(db, 'session-e2e')
    expect(entries).toHaveLength(1)
    expect(entries[0]!.billing_mode).toBe('subscription')
    expect(entries[0]!.cost_usd).toBe(0)         // zero marginal cost
    expect(entries[0]!.savings_usd).toBeGreaterThan(0) // but savings recorded
  })

  it('budget:exceeded:task is emitted when task cost exceeds cap after cost:recorded', async () => {
    const budgetExceededHandler = vi.fn()
    eventBus.on('budget:exceeded:task', budgetExceededHandler)

    // Route a task
    eventBus.emit('task:routed', {
      taskId: 'task-1',
      decision: {
        taskId: 'task-1',
        agent: 'claude',
        billingMode: 'api',
        model: 'claude-3-opus',  // expensive model to exceed $1 budget
        rationale: 'API billing selected',
      },
    })

    // Manually push the task cost over the $1 budget
    db.prepare(`UPDATE tasks SET cost_usd = 1.5 WHERE id = 'task-1'`).run()

    // Emit cost:recorded directly (simulating what CostTrackerImpl does after recording)
    eventBus.emit('cost:recorded', {
      taskId: 'task-1',
      sessionId: 'session-e2e',
      costUsd: 1.5,
      savingsUsd: 0,
      billingMode: 'api',
    })

    // Allow async budget check to complete
    await new Promise<void>((resolve) => setTimeout(resolve, 20))

    expect(budgetExceededHandler).toHaveBeenCalledOnce()
    expect(budgetExceededHandler).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId: 'task-1',
        budgetUsd: 1.0,
      }),
    )
  })

  it('budget:warning:task is emitted at 80% of task budget after cost:recorded', async () => {
    const warningHandler = vi.fn()
    eventBus.on('budget:warning:task', warningHandler)

    // Push task cost to 85% of $1 budget
    db.prepare(`UPDATE tasks SET cost_usd = 0.85 WHERE id = 'task-1'`).run()

    eventBus.emit('cost:recorded', {
      taskId: 'task-1',
      sessionId: 'session-e2e',
      costUsd: 0.85,
      savingsUsd: 0,
      billingMode: 'api',
    })

    await new Promise<void>((resolve) => setTimeout(resolve, 20))

    expect(warningHandler).toHaveBeenCalledOnce()
    expect(warningHandler).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId: 'task-1',
        percentageUsed: 85,
      }),
    )
  })

  it('session:budget:exceeded is emitted when session total exceeds cap after cost:recorded', async () => {
    const sessionExceededHandler = vi.fn()
    eventBus.on('session:budget:exceeded', sessionExceededHandler)

    // Push session total cost over $5 budget
    db.prepare(`UPDATE sessions SET total_cost_usd = 5.5 WHERE id = 'session-e2e'`).run()

    // Emit cost:recorded for task-1 which triggers session budget check
    eventBus.emit('cost:recorded', {
      taskId: 'task-1',
      sessionId: 'session-e2e',
      costUsd: 0.5,
      savingsUsd: 0,
      billingMode: 'api',
    })

    await new Promise<void>((resolve) => setTimeout(resolve, 20))

    expect(sessionExceededHandler).toHaveBeenCalledOnce()
    expect(sessionExceededHandler).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'session-e2e',
        budgetUsd: 5.0,
      }),
    )
  })

  it('zero-cost entry recorded for failed task and budget check runs', async () => {
    const costRecordedHandler = vi.fn()
    eventBus.on('cost:recorded', costRecordedHandler)

    eventBus.emit('task:routed', {
      taskId: 'task-1',
      decision: {
        taskId: 'task-1',
        agent: 'claude',
        billingMode: 'api',
        model: 'claude-3-sonnet',
        rationale: 'test',
      },
    })

    eventBus.emit('task:failed', {
      taskId: 'task-1',
      error: { message: 'Worker crashed' },
    })

    await new Promise<void>((resolve) => setTimeout(resolve, 10))

    const entries = getAllCostEntries(db, 'session-e2e')
    expect(entries).toHaveLength(1)
    expect(entries[0]!.tokens_input).toBe(0)
    expect(entries[0]!.tokens_output).toBe(0)
    expect(entries[0]!.cost_usd).toBe(0)

    // cost:recorded should have been emitted and triggered budget check
    expect(costRecordedHandler).toHaveBeenCalledOnce()
  })
})

// ---------------------------------------------------------------------------
// GAP 2: Budget enforcement triggered by REAL cost tracker output
// ---------------------------------------------------------------------------

describe('GAP 2: Budget Enforcement with Real CostTracker Output', () => {
  let db: BetterSqlite3Database
  let eventBus: TypedEventBus
  let costTracker: CostTrackerImpl
  let costSubscriber: CostTrackerSubscriber
  let budgetEnforcer: BudgetEnforcerImpl
  let budgetSubscriber: BudgetEnforcerSubscriber
  let mockWorkerPool: ReturnType<typeof createMockWorkerPoolManager>

  beforeEach(async () => {
    db = createTestDb()
    eventBus = new TypedEventBusImpl()

    costTracker = createCostTracker({ db, eventBus }) as CostTrackerImpl
    costSubscriber = createCostTrackerSubscriber({ eventBus, costTracker, sessionId: 'session-e2e' })

    budgetEnforcer = createBudgetEnforcer({
      db,
      eventBus,
      config: {
        defaultTaskBudgetUsd: 0.001,  // Very tight budget: $0.001
        defaultSessionBudgetUsd: 0.005,
        warningThresholdPercent: 80,
        planningCostsCountAgainstBudget: false,
      },
    })

    mockWorkerPool = createMockWorkerPoolManager([
      { workerId: 'worker-1', taskId: 'task-1' },
    ])

    budgetSubscriber = new BudgetEnforcerSubscriber(
      eventBus,
      budgetEnforcer,
      mockWorkerPool as never,
      db,
      null,
    )

    createTestSession(db, 'session-e2e', 0.005)
    createTestTask(db, 'task-1', 'session-e2e', 0.001)

    await costSubscriber.initialize()
    await budgetSubscriber.initialize()
  })

  afterEach(async () => {
    await costSubscriber.shutdown()
    await budgetSubscriber.shutdown()
    db.close()
  })

  it('real cost recording triggers budget exceeded event when cost exceeds task cap', async () => {
    const budgetExceededHandler = vi.fn()
    eventBus.on('budget:exceeded:task', budgetExceededHandler)

    // Route task and complete it with enough tokens to exceed the $0.001 budget
    // claude-3-sonnet: input $3/1M, output $15/1M
    // 1000 tokens (250 input, 750 output) = (250*3 + 750*15)/1_000_000 = $0.01185
    // This far exceeds $0.001 task budget
    eventBus.emit('task:routed', {
      taskId: 'task-1',
      decision: {
        taskId: 'task-1',
        agent: 'claude',
        billingMode: 'api',
        model: 'claude-3-sonnet',
        rationale: 'API billing',
      },
    })

    eventBus.emit('task:complete', {
      taskId: 'task-1',
      result: { tokensUsed: 1000, exitCode: 0 },
    })

    // Allow async budget checks
    await new Promise<void>((resolve) => setTimeout(resolve, 30))

    // Budget should have been exceeded since $0.01185 > $0.001
    expect(budgetExceededHandler).toHaveBeenCalled()

    // Verify cost entry was actually written to DB
    const entries = getAllCostEntries(db, 'session-e2e')
    expect(entries).toHaveLength(1)
    expect(entries[0]!.cost_usd).toBeGreaterThan(0.001)
  })

  it('real subscription cost records savings but not API cost', async () => {
    const costRecordedHandler = vi.fn()
    eventBus.on('cost:recorded', costRecordedHandler)

    eventBus.emit('task:routed', {
      taskId: 'task-1',
      decision: {
        taskId: 'task-1',
        agent: 'claude',
        billingMode: 'subscription',
        model: 'claude-3-sonnet',
        rationale: 'Subscription routing',
      },
    })

    eventBus.emit('task:complete', {
      taskId: 'task-1',
      result: { tokensUsed: 2000, exitCode: 0 },
    })

    await new Promise<void>((resolve) => setTimeout(resolve, 10))

    expect(costRecordedHandler).toHaveBeenCalledOnce()
    const payload = costRecordedHandler.mock.calls[0]![0] as {
      costUsd: number
      savingsUsd: number
      billingMode: string
    }
    expect(payload.costUsd).toBe(0)
    expect(payload.savingsUsd).toBeGreaterThan(0)
    expect(payload.billingMode).toBe('subscription')
  })
})

// ---------------------------------------------------------------------------
// GAP 3: CLI cost command reads from real DB data written by CostTrackerImpl
// ---------------------------------------------------------------------------

describe('GAP 3: CLI Cost Command reads from real DB written by CostTracker', () => {
  let db: BetterSqlite3Database
  let eventBus: TypedEventBus
  let tmpDir: string
  let dbPath: string
  let stdoutOutput: string
  let stderrOutput: string

  beforeEach(async () => {
    // Create a real temp DB file (not :memory:) because runCostAction opens DB by path
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'substrate-e2e-'))
    const substratDir = path.join(tmpDir, '.substrate')
    fs.mkdirSync(substratDir, { recursive: true })
    dbPath = path.join(substratDir, 'state.db')

    // Write real data to the file-based DB
    const fileDb = new Database(dbPath)
    fileDb.pragma('journal_mode = WAL')
    fileDb.pragma('foreign_keys = ON')
    runMigrations(fileDb)

    // Create session
    fileDb.prepare(
      `INSERT INTO sessions (id, name, graph_file, status, budget_usd, total_cost_usd, planning_cost_usd)
       VALUES ('sess-cli', 'CLI Test Session', 'test.yaml', 'active', 10.0, 0, 0)`,
    ).run()

    // Create tasks
    fileDb.prepare(
      `INSERT INTO tasks (id, session_id, name, prompt, status, cost_usd)
       VALUES ('task-a', 'sess-cli', 'Task A', 'work', 'completed', 0)`,
    ).run()
    fileDb.prepare(
      `INSERT INTO tasks (id, session_id, name, prompt, status, cost_usd)
       VALUES ('task-b', 'sess-cli', 'Task B', 'work', 'completed', 0)`,
    ).run()

    // Write cost data directly via CostTrackerImpl against the file DB
    eventBus = new TypedEventBusImpl()
    const tracker = createCostTracker({ db: fileDb, eventBus })

    // API billing task
    tracker.recordTaskCost(
      'sess-cli',
      'task-a',
      'claude',
      'anthropic',
      'claude-3-sonnet',
      1000, // input tokens
      500,  // output tokens
      'api',
    )

    // Subscription billing task (zero cost, savings)
    tracker.recordTaskCost(
      'sess-cli',
      'task-b',
      'claude',
      'anthropic',
      'claude-3-sonnet',
      2000, // input tokens
      1000, // output tokens
      'subscription',
    )

    fileDb.close()

    // Capture stdout/stderr
    stdoutOutput = ''
    stderrOutput = ''
    vi.spyOn(process.stdout, 'write').mockImplementation((data: string | Uint8Array) => {
      stdoutOutput += typeof data === 'string' ? data : data.toString()
      return true
    })
    vi.spyOn(process.stderr, 'write').mockImplementation((data: string | Uint8Array) => {
      stderrOutput += typeof data === 'string' ? data : data.toString()
      return true
    })
  })

  afterEach(() => {
    vi.restoreAllMocks()
    // Clean up temp dir
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    } catch {
      // ignore cleanup errors
    }
  })

  it('CLI reads real session cost summary from DB written by CostTrackerImpl', async () => {
    const exitCode = await runCostAction({
      sessionId: 'sess-cli',
      outputFormat: 'table',
      byTask: false,
      byAgent: false,
      byBilling: false,
      includePlanning: false,
      projectRoot: tmpDir,
      version: '1.0.0',
    })

    expect(exitCode).toBe(0)
    expect(stdoutOutput).toContain('Session: sess-cli')
    expect(stdoutOutput).toContain('Total Cost:')
    // API billed task should have a real cost
    expect(stdoutOutput).not.toContain('No cost data found')
    // Subscription task recorded savings
    expect(stdoutOutput).toContain('Savings:')
  })

  it('CLI JSON output contains real cost data from DB', async () => {
    const exitCode = await runCostAction({
      sessionId: 'sess-cli',
      outputFormat: 'json',
      byTask: false,
      byAgent: false,
      byBilling: false,
      includePlanning: false,
      projectRoot: tmpDir,
      version: '1.0.0',
    })

    expect(exitCode).toBe(0)
    const parsed = JSON.parse(stdoutOutput) as {
      data: {
        session_id: string
        summary: {
          total_cost_usd: number
          subscription_task_count: number
          api_task_count: number
          savings_usd: number
          task_count: number
        }
      }
    }
    expect(parsed.data.session_id).toBe('sess-cli')
    expect(parsed.data.summary.task_count).toBe(2)
    expect(parsed.data.summary.api_task_count).toBe(1)
    expect(parsed.data.summary.subscription_task_count).toBe(1)
    // API billing cost > 0
    expect(parsed.data.summary.total_cost_usd).toBeGreaterThan(0)
    // Subscription billing savings > 0
    expect(parsed.data.summary.savings_usd).toBeGreaterThan(0)
  })

  it('CLI --by-task shows individual task cost rows from real DB', async () => {
    const exitCode = await runCostAction({
      sessionId: 'sess-cli',
      outputFormat: 'table',
      byTask: true,
      byAgent: false,
      byBilling: false,
      includePlanning: false,
      projectRoot: tmpDir,
      version: '1.0.0',
    })

    expect(exitCode).toBe(0)
    expect(stdoutOutput).toContain('Task ID')
    expect(stdoutOutput).toContain('task-a')
    expect(stdoutOutput).toContain('task-b')
    expect(stdoutOutput).toContain('api')
    expect(stdoutOutput).toContain('subscription')
  })

  it('CLI --by-agent shows per-agent breakdown from real DB', async () => {
    const exitCode = await runCostAction({
      sessionId: 'sess-cli',
      outputFormat: 'table',
      byTask: false,
      byAgent: true,
      byBilling: false,
      includePlanning: false,
      projectRoot: tmpDir,
      version: '1.0.0',
    })

    expect(exitCode).toBe(0)
    expect(stdoutOutput).toContain('claude')
    expect(stdoutOutput).toContain('Agent')
  })

  it('CLI auto-discovers latest session from real DB', async () => {
    // No explicit sessionId — should find sess-cli as latest
    const exitCode = await runCostAction({
      outputFormat: 'table',
      byTask: false,
      byAgent: false,
      byBilling: false,
      includePlanning: false,
      projectRoot: tmpDir,
      version: '1.0.0',
    })

    expect(exitCode).toBe(0)
    expect(stdoutOutput).toContain('Session: sess-cli')
  })

  it('CLI CSV output contains real cost data', async () => {
    const exitCode = await runCostAction({
      sessionId: 'sess-cli',
      outputFormat: 'csv',
      byTask: false,
      byAgent: false,
      byBilling: false,
      includePlanning: false,
      projectRoot: tmpDir,
      version: '1.0.0',
    })

    expect(exitCode).toBe(0)
    expect(stdoutOutput).toContain('session_id,total_cost_usd')
    expect(stdoutOutput).toContain('sess-cli')
  })
})

// ---------------------------------------------------------------------------
// GAP 4: Multi-task session — costs accumulate until session budget exceeded
// ---------------------------------------------------------------------------

describe('GAP 4: Multi-task Session Budget Accumulation', () => {
  let db: BetterSqlite3Database
  let eventBus: TypedEventBus
  let costTracker: CostTrackerImpl
  let costSubscriber: CostTrackerSubscriber
  let budgetEnforcer: BudgetEnforcerImpl

  beforeEach(async () => {
    db = createTestDb()
    eventBus = new TypedEventBusImpl()

    costTracker = createCostTracker({ db, eventBus }) as CostTrackerImpl
    costSubscriber = createCostTrackerSubscriber({
      eventBus,
      costTracker,
      sessionId: 'session-multi',
    })

    budgetEnforcer = createBudgetEnforcer({
      db,
      eventBus,
      config: {
        defaultTaskBudgetUsd: 10.0,    // generous per-task budget
        defaultSessionBudgetUsd: 50.0,
        warningThresholdPercent: 80,
        planningCostsCountAgainstBudget: false,
      },
    })

    createTestSession(db, 'session-multi', 50.0)
    // Create 3 tasks
    for (let i = 1; i <= 3; i++) {
      createTestTask(db, `task-${i}`, 'session-multi', 10.0)
    }

    await costSubscriber.initialize()
  })

  afterEach(async () => {
    await costSubscriber.shutdown()
    db.close()
  })

  it('session cost summary aggregates across multiple tasks correctly', () => {
    // Record costs directly for multiple tasks
    costTracker.recordTaskCost(
      'session-multi', 'task-1', 'claude', 'anthropic', 'claude-3-sonnet',
      1000, 500, 'api',
    )
    costTracker.recordTaskCost(
      'session-multi', 'task-2', 'claude', 'anthropic', 'claude-3-sonnet',
      2000, 1000, 'subscription',
    )
    costTracker.recordTaskCost(
      'session-multi', 'task-3', 'codex', 'openai', 'gpt-4o',
      500, 250, 'api',
    )

    const summary = getSessionCostSummary(db, 'session-multi')

    expect(summary.session_id).toBe('session-multi')
    expect(summary.task_count).toBe(3)
    expect(summary.api_task_count).toBe(2)
    expect(summary.subscription_task_count).toBe(1)
    expect(summary.total_cost_usd).toBeGreaterThan(0)
    expect(summary.savings_usd).toBeGreaterThan(0) // from subscription task
    expect(summary.per_agent_breakdown.length).toBeGreaterThanOrEqual(1)
  })

  it('checkSessionBudget detects exceeded after multiple task costs accumulate', async () => {
    const sessionExceededHandler = vi.fn()
    eventBus.on('session:budget:exceeded', sessionExceededHandler)

    // Record costs that bring session total over $50
    // Push total directly to simulate accumulated costs
    db.prepare(`UPDATE sessions SET total_cost_usd = 51.0 WHERE id = 'session-multi'`).run()

    const result = await budgetEnforcer.checkSessionBudget('session-multi', 51.0)

    expect(result.exceeded).toBe(true)
    expect(result.action).toBe('terminate-all')
    expect(sessionExceededHandler).toHaveBeenCalledOnce()
  })

  it('individual task costs accumulate in the tasks table via incrementTaskCost', () => {
    // Record multiple cost entries for task-1 (e.g., multiple LLM calls)
    costTracker.recordTaskCost(
      'session-multi', 'task-1', 'claude', 'anthropic', 'claude-3-sonnet',
      500, 250, 'api',
    )
    costTracker.recordTaskCost(
      'session-multi', 'task-1', 'claude', 'anthropic', 'claude-3-sonnet',
      1000, 500, 'api',
    )

    const task = getTask(db, 'task-1')
    expect(task?.cost_usd).toBeGreaterThan(0)

    // Verify cumulative: two entries should sum properly
    const entries = getAllCostEntries(db, 'session-multi')
    const task1Entries = entries.filter((e) => e.task_id === 'task-1')
    expect(task1Entries).toHaveLength(2)

    const totalFromEntries = task1Entries.reduce((sum, e) => sum + e.cost_usd, 0)
    expect(task?.cost_usd).toBeCloseTo(totalFromEntries, 5)
  })
})

// ---------------------------------------------------------------------------
// GAP 5: Subscription routing savings visible in session cost summary + CLI
// ---------------------------------------------------------------------------

describe('GAP 5: Subscription Routing Savings Pipeline to CLI', () => {
  let db: BetterSqlite3Database
  let eventBus: TypedEventBus
  let costTracker: CostTrackerImpl
  let costSubscriber: CostTrackerSubscriber

  beforeEach(async () => {
    db = createTestDb()
    eventBus = new TypedEventBusImpl()
    costTracker = createCostTracker({ db, eventBus }) as CostTrackerImpl
    costSubscriber = createCostTrackerSubscriber({
      eventBus,
      costTracker,
      sessionId: 'session-savings',
    })

    createTestSession(db, 'session-savings')
    createTestTask(db, 'task-sub', 'session-savings')
    createTestTask(db, 'task-api', 'session-savings')

    await costSubscriber.initialize()
  })

  afterEach(async () => {
    await costSubscriber.shutdown()
    db.close()
  })

  it('subscription savings correctly computed and visible in session summary', async () => {
    // Simulate routing events: one subscription, one API
    eventBus.emit('task:routed', {
      taskId: 'task-sub',
      decision: {
        taskId: 'task-sub',
        agent: 'claude',
        billingMode: 'subscription',
        model: 'claude-3-sonnet',
        rationale: 'Subscription available',
      },
    })

    eventBus.emit('task:complete', {
      taskId: 'task-sub',
      result: { tokensUsed: 10000, exitCode: 0 },
    })

    eventBus.emit('task:routed', {
      taskId: 'task-api',
      decision: {
        taskId: 'task-api',
        agent: 'claude',
        billingMode: 'api',
        model: 'claude-3-sonnet',
        rationale: 'API fallback',
      },
    })

    eventBus.emit('task:complete', {
      taskId: 'task-api',
      result: { tokensUsed: 5000, exitCode: 0 },
    })

    await new Promise<void>((resolve) => setTimeout(resolve, 10))

    const summary = getSessionCostSummary(db, 'session-savings')

    expect(summary.task_count).toBe(2)
    expect(summary.subscription_task_count).toBe(1)
    expect(summary.api_task_count).toBe(1)

    // Subscription task: cost=0, savings>0
    expect(summary.subscription_cost_usd).toBe(0)
    expect(summary.savings_usd).toBeGreaterThan(0)

    // API task: cost>0
    expect(summary.api_cost_usd).toBeGreaterThan(0)

    // Total cost only from API tasks
    expect(summary.total_cost_usd).toBeCloseTo(summary.api_cost_usd, 5)

    // Savings summary message should mention subscriptions
    expect(summary.savingsSummary).toMatch(/Saved ~\$[\d.]+ by routing 1 task through subscriptions/)
  })

  it('unavailable billing mode does NOT generate a cost entry', async () => {
    // When routing fails (billingMode=unavailable), no cost should be recorded
    eventBus.emit('task:routed', {
      taskId: 'task-sub',
      decision: {
        taskId: 'task-sub',
        agent: 'none',
        billingMode: 'unavailable',
        rationale: 'All providers unavailable',
      },
    })

    eventBus.emit('task:complete', {
      taskId: 'task-sub',
      result: { tokensUsed: 0, exitCode: 1 },
    })

    await new Promise<void>((resolve) => setTimeout(resolve, 10))

    const entries = getAllCostEntries(db, 'session-savings')
    expect(entries).toHaveLength(0)
  })

  it('cost:recorded event carries correct billing metadata from subscription routing', async () => {
    const costRecordedPayloads: Array<{
      taskId: string
      billingMode: string
      costUsd: number
      savingsUsd: number
    }> = []

    eventBus.on('cost:recorded', (payload) => {
      costRecordedPayloads.push(payload)
    })

    // Route two tasks with different billing modes
    for (const [taskId, billingMode] of [['task-sub', 'subscription'], ['task-api', 'api']] as const) {
      eventBus.emit('task:routed', {
        taskId,
        decision: {
          taskId,
          agent: 'claude',
          billingMode,
          model: 'claude-3-sonnet',
          rationale: 'test',
        },
      })

      eventBus.emit('task:complete', {
        taskId,
        result: { tokensUsed: 2000, exitCode: 0 },
      })
    }

    await new Promise<void>((resolve) => setTimeout(resolve, 10))

    expect(costRecordedPayloads).toHaveLength(2)

    const subPayload = costRecordedPayloads.find((p) => p.billingMode === 'subscription')
    expect(subPayload).toBeDefined()
    expect(subPayload!.costUsd).toBe(0)
    expect(subPayload!.savingsUsd).toBeGreaterThan(0)

    const apiPayload = costRecordedPayloads.find((p) => p.billingMode === 'api')
    expect(apiPayload).toBeDefined()
    expect(apiPayload!.costUsd).toBeGreaterThan(0)
    expect(apiPayload!.savingsUsd).toBe(0)
  })
})
