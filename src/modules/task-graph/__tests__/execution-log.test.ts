/**
 * Unit tests for intent logging in TaskGraphEngineImpl.
 * AC: #1, #2, #7
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { DatabaseServiceImpl } from '../../../persistence/database.js'
import { createEventBus } from '../../../core/event-bus.js'
import { TaskGraphEngineImpl } from '../task-graph-engine.js'
import { getSessionLog, getLogByEvent } from '../../../persistence/queries/log.js'
import type { Database as BetterSqlite3Database } from 'better-sqlite3'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createTestEngine() {
  const dbService = new DatabaseServiceImpl(':memory:')
  const eventBus = createEventBus()
  const engine = new TaskGraphEngineImpl(eventBus, dbService)
  return { dbService, eventBus, engine }
}

/**
 * Load a graph with task A (agent = 'claude-code') and task B (agent = null),
 * both independent tasks (no dependencies).
 */
async function loadGraphWithAgents(engine: TaskGraphEngineImpl): Promise<string> {
  const content = JSON.stringify({
    version: '1',
    session: { name: 'test-agent-log' },
    tasks: {
      taskA: { name: 'Task A', prompt: 'Do A', type: 'coding', agent: 'claude-code', depends_on: [] },
      taskB: { name: 'Task B', prompt: 'Do B', type: 'coding', depends_on: [] },
    },
  })
  return engine.loadGraphFromString(content, 'json')
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('TaskGraphEngineImpl — intent logging in execution_log', () => {
  let dbService: DatabaseServiceImpl
  let engine: TaskGraphEngineImpl
  let db: BetterSqlite3Database

  beforeEach(async () => {
    const setup = createTestEngine()
    dbService = setup.dbService
    engine = setup.engine
    await dbService.initialize()
    await engine.initialize()
    db = dbService.db
  })

  afterEach(async () => {
    await dbService.shutdown()
  })

  // -------------------------------------------------------------------------
  // startExecution — orchestrator state changes logged
  // -------------------------------------------------------------------------

  describe('startExecution — orchestrator:state_change entries', () => {
    it('logs Idle → Loading and Loading → Executing transitions', async () => {
      const sessionId = await loadGraphWithAgents(engine)
      engine.startExecution(sessionId, 2)

      const orchEntries = getLogByEvent(db, sessionId, 'orchestrator:state_change')
      const transitionPairs = orchEntries.map(e => `${e.old_status}→${e.new_status}`)
      expect(transitionPairs).toContain('Idle→Loading')
      expect(transitionPairs).toContain('Loading→Executing')
    })
  })

  // -------------------------------------------------------------------------
  // markTaskRunning — task:status_change logged with agent
  // -------------------------------------------------------------------------

  describe('markTaskRunning', () => {
    it('writes log entry with event=task:status_change, old=pending, new=running, agent=claude-code', async () => {
      const sessionId = await loadGraphWithAgents(engine)
      engine.startExecution(sessionId, 5)
      engine.markTaskRunning('taskA', 'worker-1')

      const taskEntries = db
        .prepare(`SELECT * FROM execution_log WHERE task_id = 'taskA' AND new_status = 'running'`)
        .all() as Array<{ event: string; old_status: string; new_status: string; agent: string | null }>

      expect(taskEntries).toHaveLength(1)
      expect(taskEntries[0].event).toBe('task:status_change')
      expect(taskEntries[0].old_status).toBe('pending')
      expect(taskEntries[0].new_status).toBe('running')
      expect(taskEntries[0].agent).toBe('claude-code')
    })

    it('writes log entry with agent=null when task has no agent', async () => {
      const sessionId = await loadGraphWithAgents(engine)
      engine.startExecution(sessionId, 5)
      engine.markTaskRunning('taskB', 'worker-2')

      const taskEntries = db
        .prepare(`SELECT * FROM execution_log WHERE task_id = 'taskB' AND new_status = 'running'`)
        .all() as Array<{ agent: string | null }>

      expect(taskEntries).toHaveLength(1)
      expect(taskEntries[0].agent).toBeNull()
    })
  })

  // -------------------------------------------------------------------------
  // markTaskComplete — task:status_change logged with cost + agent
  // -------------------------------------------------------------------------

  describe('markTaskComplete', () => {
    it('writes log entry with new_status=completed, cost_usd set, agent=claude-code', async () => {
      const sessionId = await loadGraphWithAgents(engine)
      engine.startExecution(sessionId, 5)
      engine.markTaskRunning('taskA', 'worker-1')
      engine.markTaskComplete('taskA', 'output text', 0.05)

      const completedEntries = db
        .prepare(`SELECT * FROM execution_log WHERE task_id = 'taskA' AND new_status = 'completed'`)
        .all() as Array<{ event: string; new_status: string; cost_usd: number | null; agent: string | null; data: string | null }>

      expect(completedEntries).toHaveLength(1)
      expect(completedEntries[0].new_status).toBe('completed')
      expect(completedEntries[0].cost_usd).toBe(0.05)
      expect(completedEntries[0].agent).toBe('claude-code')
      // data field should include result
      expect(completedEntries[0].data).not.toBeNull()
      const data = JSON.parse(completedEntries[0].data as string) as { result: string }
      expect(data.result).toBe('output text')
    })
  })

  // -------------------------------------------------------------------------
  // markTaskFailed — task:status_change logged (retry path → pending, exhausted → failed)
  // -------------------------------------------------------------------------

  describe('markTaskFailed', () => {
    it('writes log entry with new_status=pending (retry path), agent=null', async () => {
      const sessionId = await loadGraphWithAgents(engine)
      engine.startExecution(sessionId, 5)
      engine.markTaskRunning('taskB', 'worker-2')
      engine.markTaskFailed('taskB', 'exit code 1', 1)

      // taskB has max_retries=2, retry_count starts at 0, so first fail → pending
      const failedEntries = db
        .prepare(`SELECT * FROM execution_log WHERE task_id = 'taskB' AND new_status = 'pending' AND old_status = 'running'`)
        .all() as Array<{ new_status: string; agent: string | null; data: string | null }>

      expect(failedEntries).toHaveLength(1)
      expect(failedEntries[0].new_status).toBe('pending')
      expect(failedEntries[0].agent).toBeNull()
      // data field should include error
      expect(failedEntries[0].data).not.toBeNull()
      const data = JSON.parse(failedEntries[0].data as string) as { error: string }
      expect(data.error).toBe('exit code 1')
    })

    it('writes log entry with new_status=failed when max_retries exhausted', async () => {
      const sessionId = await loadGraphWithAgents(engine)
      // Set max_retries = 0 on taskB
      db.prepare(`UPDATE tasks SET max_retries = 0 WHERE id = 'taskB'`).run()

      engine.startExecution(sessionId, 5)
      engine.markTaskRunning('taskB', 'worker-2')
      engine.markTaskFailed('taskB', 'fatal error', 1)

      const failedEntries = db
        .prepare(`SELECT * FROM execution_log WHERE task_id = 'taskB' AND new_status = 'failed'`)
        .all() as Array<{ new_status: string }>

      expect(failedEntries).toHaveLength(1)
      expect(failedEntries[0].new_status).toBe('failed')
    })
  })

  // -------------------------------------------------------------------------
  // markTaskCancelled — task:status_change logged
  // -------------------------------------------------------------------------

  describe('markTaskCancelled', () => {
    it('writes log entry with new_status=cancelled', async () => {
      const sessionId = await loadGraphWithAgents(engine)
      engine.startExecution(sessionId, 5)
      engine.markTaskCancelled('taskA')

      const cancelledEntries = db
        .prepare(`SELECT * FROM execution_log WHERE task_id = 'taskA' AND new_status = 'cancelled'`)
        .all() as Array<{ new_status: string; agent: string | null }>

      expect(cancelledEntries).toHaveLength(1)
      expect(cancelledEntries[0].new_status).toBe('cancelled')
      expect(cancelledEntries[0].agent).toBe('claude-code')
    })
  })

  // -------------------------------------------------------------------------
  // Intent ordering: log entry timestamp <= task updated_at
  // -------------------------------------------------------------------------

  describe('intent ordering', () => {
    it('log entry timestamp is <= task updated_at for running transition', async () => {
      const sessionId = await loadGraphWithAgents(engine)
      engine.startExecution(sessionId, 5)
      engine.markTaskRunning('taskA', 'worker-1')

      const logEntry = db
        .prepare(`SELECT timestamp FROM execution_log WHERE task_id = 'taskA' AND new_status = 'running'`)
        .get() as { timestamp: string } | undefined

      const task = db
        .prepare(`SELECT updated_at FROM tasks WHERE id = 'taskA'`)
        .get() as { updated_at: string } | undefined

      expect(logEntry).toBeDefined()
      expect(task).toBeDefined()
      // Both written in the same transaction with the same datetime('now'), so equal is fine
      expect(logEntry!.timestamp <= task!.updated_at).toBe(true)
    })
  })

  // -------------------------------------------------------------------------
  // pause / resume — orchestrator:state_change logged
  // -------------------------------------------------------------------------

  describe('pause and resume orchestrator state changes', () => {
    it('logs Executing → Paused on pause()', async () => {
      const sessionId = await loadGraphWithAgents(engine)
      engine.startExecution(sessionId, 2)
      engine.pause()

      const orchEntries = getLogByEvent(db, sessionId, 'orchestrator:state_change')
      const paused = orchEntries.find(e => e.old_status === 'Executing' && e.new_status === 'Paused')
      expect(paused).toBeDefined()
    })

    it('logs Paused → Executing on resume()', async () => {
      const sessionId = await loadGraphWithAgents(engine)
      engine.startExecution(sessionId, 2)
      engine.pause()
      engine.resume()

      const orchEntries = getLogByEvent(db, sessionId, 'orchestrator:state_change')
      const resumed = orchEntries.find(e => e.old_status === 'Paused' && e.new_status === 'Executing')
      expect(resumed).toBeDefined()
    })
  })

  // -------------------------------------------------------------------------
  // No session — _transition silently skips log write
  // -------------------------------------------------------------------------

  describe('no active session — state_change is silently skipped', () => {
    it('does not throw when transitioning before a session exists', async () => {
      // engine is in Idle state with _sessionId = null
      // Attempting to call startExecution with a fake sessionId sets the session,
      // but before that, _transition('Loading') fires with null session — should be silent
      const sessionId = await loadGraphWithAgents(engine)
      // startExecution calls _transition('Loading') before setting _sessionId
      // The story says: "if no active session exists at transition time, log write is silently skipped"
      // This is already implemented in _transition via the null check + try/catch
      expect(() => engine.startExecution(sessionId, 2)).not.toThrow()
    })
  })
})
