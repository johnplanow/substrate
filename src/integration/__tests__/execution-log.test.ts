/**
 * Integration tests for the full execution log lifecycle.
 * AC: #1, #2, #3, #5
 *
 * Uses a real temp-file SQLite database to validate the full log flow.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseServiceImpl } from '../../persistence/database.js'
import { createEventBus } from '../../core/event-bus.js'
import { TaskGraphEngineImpl } from '../../modules/task-graph/task-graph-engine.js'
import {
  getSessionLog,
  getLogByEvent,
  getLogByTimeRange,
} from '../../persistence/queries/log.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * SQLite datetime('now') stores timestamps as 'YYYY-MM-DD HH:MM:SS' (UTC, space separator).
 * Use this format for range queries to make string comparisons work correctly.
 */
function sqliteNow(offsetMs = 0): string {
  const d = new Date(Date.now() + offsetMs)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ` +
    `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`
}

async function loadChainGraph(engine: TaskGraphEngineImpl): Promise<string> {
  const content = JSON.stringify({
    version: '1',
    session: { name: 'integration-test' },
    tasks: {
      taskA: { name: 'Task A', prompt: 'Do A', type: 'coding', agent: 'claude-code', depends_on: [] },
      taskB: { name: 'Task B', prompt: 'Do B', type: 'coding', depends_on: ['taskA'] },
      taskC: { name: 'Task C', prompt: 'Do C', type: 'coding', depends_on: ['taskB'] },
    },
  })
  return engine.loadGraphFromString(content, 'json')
}

// ---------------------------------------------------------------------------
// Integration tests
// ---------------------------------------------------------------------------

describe('Execution log — integration', () => {
  let tmpDir: string
  let dbService: DatabaseServiceImpl
  let engine: TaskGraphEngineImpl

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'substrate-log-test-'))
    const dbPath = join(tmpDir, 'state.db')
    dbService = new DatabaseServiceImpl(dbPath)
    const eventBus = createEventBus()
    engine = new TaskGraphEngineImpl(eventBus, dbService)
    await dbService.initialize()
    await engine.initialize()
  })

  afterEach(async () => {
    await dbService.shutdown()
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('records orchestrator and task status changes in execution_log after full run', async () => {
    const sessionId = await loadChainGraph(engine)

    engine.startExecution(sessionId, 3)

    // Simulate workers: A → B → C chain
    engine.markTaskRunning('taskA', 'worker-1')
    engine.markTaskComplete('taskA', 'output-A', 0.01)

    engine.markTaskRunning('taskB', 'worker-2')
    engine.markTaskComplete('taskB', 'output-B', 0.02)

    engine.markTaskRunning('taskC', 'worker-3')
    engine.markTaskComplete('taskC', 'output-C', 0.03)

    const db = dbService.db
    const allEntries = getSessionLog(db, sessionId)

    // Should have at minimum orchestrator entries + task status entries
    expect(allEntries.length).toBeGreaterThan(0)

    // At least one entry with orchestrator:state_change
    const orchEntries = allEntries.filter(e => e.event === 'orchestrator:state_change')
    expect(orchEntries.length).toBeGreaterThanOrEqual(1)

    // One entry per task per status change (running + completed for each of 3 tasks = 6)
    const taskStatusEntries = allEntries.filter(e => e.event === 'task:status_change')
    expect(taskStatusEntries.length).toBeGreaterThanOrEqual(3) // at least one per task

    // Entries are ordered chronologically
    for (let i = 1; i < allEntries.length; i++) {
      const prev = allEntries[i - 1]
      const curr = allEntries[i]
      // timestamp ASC, id ASC — so either timestamp is non-decreasing or id is
      const sameTs = prev.timestamp === curr.timestamp
      if (sameTs) {
        expect(prev.id! <= curr.id!).toBe(true)
      } else {
        expect(prev.timestamp! <= curr.timestamp!).toBe(true)
      }
    }

    // No entry has a raw API key in any field
    for (const entry of allEntries) {
      const fields = [entry.data, entry.agent, entry.old_status, entry.new_status]
      for (const field of fields) {
        if (field !== null && field !== undefined) {
          expect(field).not.toMatch(/sk-ant-[A-Za-z0-9_-]{20,}/)
        }
      }
    }
  })

  it('getLogByEvent returns at least 3 task:status_change entries (one per task)', async () => {
    const sessionId = await loadChainGraph(engine)
    engine.startExecution(sessionId, 3)

    engine.markTaskRunning('taskA', 'worker-1')
    engine.markTaskComplete('taskA', 'output-A', 0.01)
    engine.markTaskRunning('taskB', 'worker-2')
    engine.markTaskComplete('taskB', 'output-B', 0.02)
    engine.markTaskRunning('taskC', 'worker-3')
    engine.markTaskComplete('taskC', 'output-C', 0.03)

    const db = dbService.db
    const taskStatusEntries = getLogByEvent(db, sessionId, 'task:status_change')
    expect(taskStatusEntries.length).toBeGreaterThanOrEqual(3)
  })

  it('getLogByEvent returns at least 3 orchestrator:state_change entries (Idle→Loading, Loading→Executing, Executing→Completing)', async () => {
    const sessionId = await loadChainGraph(engine)
    engine.startExecution(sessionId, 3)

    engine.markTaskRunning('taskA', 'worker-1')
    engine.markTaskComplete('taskA', 'output-A', 0.01)
    engine.markTaskRunning('taskB', 'worker-2')
    engine.markTaskComplete('taskB', 'output-B', 0.02)
    engine.markTaskRunning('taskC', 'worker-3')
    engine.markTaskComplete('taskC', 'output-C', 0.03)

    const db = dbService.db
    const orchEntries = getLogByEvent(db, sessionId, 'orchestrator:state_change')
    expect(orchEntries.length).toBeGreaterThanOrEqual(3)

    const transitions = orchEntries.map(e => `${e.old_status}→${e.new_status}`)
    expect(transitions).toContain('Idle→Loading')
    expect(transitions).toContain('Loading→Executing')
    expect(transitions).toContain('Executing→Completing')
  })

  it('getLogByTimeRange returns the full log when startTime/endTime bracket the test run', async () => {
    const startTime = sqliteNow(-2000)
    const sessionId = await loadChainGraph(engine)
    engine.startExecution(sessionId, 3)

    engine.markTaskRunning('taskA', 'worker-1')
    engine.markTaskComplete('taskA', 'output-A', 0.01)

    const endTime = sqliteNow(2000)
    const db = dbService.db
    const inRange = getLogByTimeRange(db, sessionId, startTime, endTime)
    const allEntries = getSessionLog(db, sessionId)

    expect(inRange.length).toBe(allEntries.length)
  })

  it('getLogByTimeRange returns empty array for future date range', async () => {
    const sessionId = await loadChainGraph(engine)
    engine.startExecution(sessionId, 3)

    const db = dbService.db
    const futureFrom = sqliteNow(100000)
    const futureTo = sqliteNow(200000)
    const empty = getLogByTimeRange(db, sessionId, futureFrom, futureTo)
    expect(empty).toHaveLength(0)
  })
})
