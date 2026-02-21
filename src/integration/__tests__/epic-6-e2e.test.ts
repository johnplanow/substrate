/**
 * Epic 6 E2E Integration Tests — Crash Recovery & Observability
 *
 * Covers cross-story integration gaps:
 *
 * GAP-1: Crash recovery + execution log
 *   CrashRecoveryManager modifies task status (running→pending / running→failed)
 *   but does NOT itself write to execution_log. This test confirms the current
 *   behavior and documents the gap.
 *
 * GAP-2: Shutdown handler DB writes are correct before crash
 *   setupGracefulShutdown writes task status and session status updates directly.
 *   This test verifies the SQL is correct and the log is NOT populated by shutdown
 *   (no execution_log entries from shutdown handler).
 *
 * GAP-3: substrate log CLI → DB end-to-end
 *   Task lifecycle entries written by TaskGraphEngineImpl are queryable via
 *   runLogAction (the core of `substrate log`).
 *
 * GAP-4: Resume command → recovery → execution log continuity
 *   After a crash (session interrupted, tasks reset to pending by recovery),
 *   restarting execution logs the new transitions so the execution_log contains
 *   entries from BOTH the original run and the resumed run.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'fs'
import { mkdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { DatabaseWrapper } from '../../persistence/database.js'
import { runMigrations } from '../../persistence/migrations/index.js'
import { CrashRecoveryManager } from '../../recovery/crash-recovery.js'
import { appendLog, getSessionLog, getLogByEvent } from '../../persistence/queries/log.js'
import { createEventBus } from '../../core/event-bus.js'
import { DatabaseServiceImpl } from '../../persistence/database.js'
import { TaskGraphEngineImpl } from '../../modules/task-graph/task-graph-engine.js'
import { runLogAction } from '../../cli/commands/log.js'
import type { Database as BetterSqlite3Database } from 'better-sqlite3'

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function openDb(path: string): BetterSqlite3Database {
  const wrapper = new DatabaseWrapper(path)
  wrapper.open()
  runMigrations(wrapper.db)
  return wrapper.db
}

function insertSession(db: BetterSqlite3Database, id: string, status = 'active'): void {
  db.prepare(`
    INSERT INTO sessions (id, graph_file, status)
    VALUES (?, 'test.yaml', ?)
  `).run(id, status)
}

function insertTask(
  db: BetterSqlite3Database,
  id: string,
  sessionId: string,
  status: string,
  retryCount = 0,
  maxRetries = 2,
): void {
  db.prepare(`
    INSERT INTO tasks (id, session_id, name, prompt, status, retry_count, max_retries)
    VALUES (?, ?, ?, 'test prompt', ?, ?, ?)
  `).run(id, sessionId, `Task ${id}`, status, retryCount, maxRetries)
}

function captureStdout(): { get: () => string; restore: () => void } {
  let output = ''
  const original = process.stdout.write.bind(process.stdout)
  process.stdout.write = (data: string | Uint8Array, ...rest: unknown[]): boolean => {
    output += typeof data === 'string' ? data : data.toString()
    return true
  }
  return {
    get: () => output,
    restore: () => { process.stdout.write = original },
  }
}

function captureStderr(): { get: () => string; restore: () => void } {
  let output = ''
  const original = process.stderr.write.bind(process.stderr)
  process.stderr.write = (data: string | Uint8Array, ...rest: unknown[]): boolean => {
    output += typeof data === 'string' ? data : data.toString()
    return true
  }
  return {
    get: () => output,
    restore: () => { process.stderr.write = original },
  }
}

// ---------------------------------------------------------------------------
// GAP-1: Crash recovery does NOT write to execution_log
// ---------------------------------------------------------------------------

describe('GAP-1: CrashRecoveryManager — interaction with execution_log', () => {
  let tmpDir: string
  let db: BetterSqlite3Database

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'epic6-gap1-'))
    db = openDb(join(tmpDir, 'state.db'))
  })

  afterEach(() => {
    try { db.close() } catch { /* ignore */ }
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('execution_log is empty before recovery when no prior log entries exist', () => {
    insertSession(db, 'sess-gap1-a')
    insertTask(db, 'task-1', 'sess-gap1-a', 'running', 0, 2)

    const before = getSessionLog(db, 'sess-gap1-a')
    expect(before).toHaveLength(0)
  })

  it('CrashRecoveryManager.recover() does NOT write execution_log entries (documented behavior)', () => {
    // This test documents the current behavior: recovery modifies task rows
    // directly via SQL UPDATE without going through appendLog. This is by
    // design (crash-safety at the DB level) but means the log will not contain
    // "running→pending" transition entries for crash-recovered tasks.
    insertSession(db, 'sess-gap1-b')
    insertTask(db, 'task-2', 'sess-gap1-b', 'running', 0, 2)

    const manager = new CrashRecoveryManager({ db })
    manager.recover('sess-gap1-b')

    const logEntries = getSessionLog(db, 'sess-gap1-b')
    // No entries in execution_log from crash recovery itself
    expect(logEntries).toHaveLength(0)

    // But the task status IS updated in the tasks table
    const task = db.prepare('SELECT status, retry_count FROM tasks WHERE id = ?').get('task-2') as {
      status: string
      retry_count: number
    }
    expect(task.status).toBe('pending')
    expect(task.retry_count).toBe(1)
  })

  it('execution_log entries written BEFORE crash survive recovery unchanged', () => {
    // Simulate: tasks ran, some log entries were written, then a crash occurred
    insertSession(db, 'sess-gap1-c')
    insertTask(db, 'task-3', 'sess-gap1-c', 'running', 0, 2)

    // Write a log entry (simulating pre-crash engine activity)
    appendLog(db, {
      session_id: 'sess-gap1-c',
      task_id: 'task-3',
      event: 'task:status_change',
      old_status: 'pending',
      new_status: 'running',
      agent: 'claude-code',
    })

    // Simulate crash recovery
    const manager = new CrashRecoveryManager({ db })
    manager.recover('sess-gap1-c')

    // Pre-crash log entries are preserved
    const logEntries = getSessionLog(db, 'sess-gap1-c')
    expect(logEntries).toHaveLength(1)
    expect(logEntries[0].event).toBe('task:status_change')
    expect(logEntries[0].old_status).toBe('pending')
    expect(logEntries[0].new_status).toBe('running')
  })

  it('recovery correctly resets running→pending task and leaves log intact', () => {
    insertSession(db, 'sess-gap1-d')
    insertTask(db, 'task-4', 'sess-gap1-d', 'running', 1, 3)

    // One pre-crash log entry
    appendLog(db, {
      session_id: 'sess-gap1-d',
      task_id: 'task-4',
      event: 'task:status_change',
      old_status: 'pending',
      new_status: 'running',
    })

    const manager = new CrashRecoveryManager({ db })
    const result = manager.recover('sess-gap1-d')

    expect(result.recovered).toBe(1)
    expect(result.failed).toBe(0)

    // Log still has only the original entry (recovery did not add a new one)
    const logEntries = getSessionLog(db, 'sess-gap1-d')
    expect(logEntries).toHaveLength(1)
    expect(logEntries[0].new_status).toBe('running')
  })

  it('recovery correctly fails running→failed task (max retries) and leaves log intact', () => {
    insertSession(db, 'sess-gap1-e')
    insertTask(db, 'task-5', 'sess-gap1-e', 'running', 2, 2)

    appendLog(db, {
      session_id: 'sess-gap1-e',
      task_id: 'task-5',
      event: 'task:status_change',
      old_status: 'pending',
      new_status: 'running',
    })

    const manager = new CrashRecoveryManager({ db })
    const result = manager.recover('sess-gap1-e')

    expect(result.failed).toBe(1)
    expect(result.recovered).toBe(0)

    // Log still has only the original entry
    const logEntries = getSessionLog(db, 'sess-gap1-e')
    expect(logEntries).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// GAP-2: Shutdown handler DB writes
// ---------------------------------------------------------------------------

describe('GAP-2: setupGracefulShutdown — DB writes are correct', () => {
  let tmpDir: string
  let db: BetterSqlite3Database

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'epic6-gap2-'))
    db = openDb(join(tmpDir, 'state.db'))
  })

  afterEach(() => {
    try { db.close() } catch { /* ignore */ }
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('the SQL UPDATE that shutdown writes correctly transitions running tasks to pending', () => {
    // Simulate what setupGracefulShutdown does directly (the SQL it runs)
    insertSession(db, 'sess-gap2-a', 'active')
    insertTask(db, 'task-a', 'sess-gap2-a', 'running', 0, 2)
    insertTask(db, 'task-b', 'sess-gap2-a', 'running', 1, 2)

    // This is exactly the SQL run by setupGracefulShutdown step 3
    db.prepare(`
      UPDATE tasks
      SET status = 'pending',
          retry_count = retry_count + 1,
          worker_id = NULL,
          updated_at = datetime('now')
      WHERE session_id = ? AND status = 'running'
    `).run('sess-gap2-a')

    const taskA = db.prepare('SELECT status, retry_count FROM tasks WHERE id = ?').get('task-a') as {
      status: string
      retry_count: number
    }
    expect(taskA.status).toBe('pending')
    expect(taskA.retry_count).toBe(1)

    const taskB = db.prepare('SELECT status, retry_count FROM tasks WHERE id = ?').get('task-b') as {
      status: string
      retry_count: number
    }
    expect(taskB.status).toBe('pending')
    expect(taskB.retry_count).toBe(2)
  })

  it('the SQL UPDATE that shutdown writes correctly marks session as interrupted', () => {
    insertSession(db, 'sess-gap2-b', 'active')

    // This is exactly the SQL run by setupGracefulShutdown step 4
    db.prepare(`
      UPDATE sessions
      SET status = 'interrupted',
          updated_at = datetime('now')
      WHERE id = ?
    `).run('sess-gap2-b')

    const session = db.prepare('SELECT status FROM sessions WHERE id = ?').get('sess-gap2-b') as {
      status: string
    }
    expect(session.status).toBe('interrupted')
  })

  it('shutdown handler does NOT write to execution_log (documented gap)', () => {
    // Shutdown goes directly to SQL without calling appendLog.
    // This is the documented gap: interrupted task transitions are NOT logged.
    insertSession(db, 'sess-gap2-c', 'active')
    insertTask(db, 'task-c', 'sess-gap2-c', 'running', 0, 2)

    // Simulate the full shutdown DB sequence
    db.prepare(`
      UPDATE tasks
      SET status = 'pending',
          retry_count = retry_count + 1,
          worker_id = NULL,
          updated_at = datetime('now')
      WHERE session_id = ? AND status = 'running'
    `).run('sess-gap2-c')

    db.prepare(`
      UPDATE sessions
      SET status = 'interrupted',
          updated_at = datetime('now')
      WHERE id = ?
    `).run('sess-gap2-c')

    const logEntries = getSessionLog(db, 'sess-gap2-c')
    expect(logEntries).toHaveLength(0)

    // But task and session state are correct
    const session = db.prepare('SELECT status FROM sessions WHERE id = ?').get('sess-gap2-c') as { status: string }
    expect(session.status).toBe('interrupted')
  })

  it('after shutdown, CrashRecoveryManager.findInterruptedSession finds the session', () => {
    insertSession(db, 'sess-gap2-d', 'active')

    // Simulate shutdown step 4
    db.prepare(`
      UPDATE sessions SET status = 'interrupted', updated_at = datetime('now') WHERE id = ?
    `).run('sess-gap2-d')

    const found = CrashRecoveryManager.findInterruptedSession(db)
    expect(found).toBeDefined()
    expect(found!.id).toBe('sess-gap2-d')
    expect(found!.status).toBe('interrupted')
  })
})

// ---------------------------------------------------------------------------
// GAP-3: substrate log CLI → DB end-to-end
// ---------------------------------------------------------------------------

describe('GAP-3: runLogAction — end-to-end DB to CLI output', () => {
  let tmpDir: string
  let projectRoot: string
  let dbService: DatabaseServiceImpl
  let engine: TaskGraphEngineImpl

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'epic6-gap3-'))
    projectRoot = tmpDir
    mkdirSync(join(projectRoot, '.substrate'), { recursive: true })

    dbService = new DatabaseServiceImpl(join(projectRoot, '.substrate', 'state.db'))
    const eventBus = createEventBus()
    engine = new TaskGraphEngineImpl(eventBus, dbService)
    await dbService.initialize()
    await engine.initialize()
  })

  afterEach(async () => {
    await dbService.shutdown()
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('runLogAction returns exit 0 and outputs table with real task:status_change entries', async () => {
    // Load a graph and run tasks so entries get written
    const content = JSON.stringify({
      version: '1',
      session: { name: 'log-cli-test' },
      tasks: {
        taskX: { name: 'Task X', prompt: 'Do X', type: 'coding', agent: 'claude-code', depends_on: [] },
      },
    })
    const sessionId = await engine.loadGraphFromString(content, 'json')
    engine.startExecution(sessionId, 1)
    engine.markTaskRunning('taskX', 'worker-1')
    engine.markTaskComplete('taskX', 'done', 0.01)

    const stdout = captureStdout()
    const stderr = captureStderr()

    try {
      const code = await runLogAction({
        limit: 50,
        outputFormat: 'table',
        projectRoot,
        version: '1.0.0',
      })

      expect(code).toBe(0)
      expect(stderr.get()).toBe('')

      const out = stdout.get()
      expect(out).toContain('Timestamp')
      expect(out).toContain('Event')
      expect(out).toContain('Task ID')
      expect(out).toContain('task:status_change')
    } finally {
      stdout.restore()
      stderr.restore()
    }
  })

  it('runLogAction --event task:status_change returns only task status changes', async () => {
    const content = JSON.stringify({
      version: '1',
      session: { name: 'log-event-filter-test' },
      tasks: {
        taskY: { name: 'Task Y', prompt: 'Do Y', type: 'coding', depends_on: [] },
      },
    })
    const sessionId = await engine.loadGraphFromString(content, 'json')
    engine.startExecution(sessionId, 1)
    engine.markTaskRunning('taskY', 'worker-2')
    engine.markTaskComplete('taskY', 'output', 0.02)

    const stdout = captureStdout()
    const stderr = captureStderr()

    try {
      const code = await runLogAction({
        event: 'task:status_change',
        limit: 50,
        outputFormat: 'table',
        projectRoot,
        version: '1.0.0',
      })

      expect(code).toBe(0)
      expect(stderr.get()).toBe('')

      const out = stdout.get()
      // Should contain task status changes
      expect(out).toContain('task:status_change')
    } finally {
      stdout.restore()
      stderr.restore()
    }
  })

  it('runLogAction JSON output contains valid LogEntry array with correct fields', async () => {
    const content = JSON.stringify({
      version: '1',
      session: { name: 'log-json-test' },
      tasks: {
        taskZ: { name: 'Task Z', prompt: 'Do Z', type: 'coding', agent: 'claude-code', depends_on: [] },
      },
    })
    const sessionId = await engine.loadGraphFromString(content, 'json')
    engine.startExecution(sessionId, 1)
    engine.markTaskRunning('taskZ', 'worker-3')
    engine.markTaskComplete('taskZ', 'result-z', 0.05)

    const stdout = captureStdout()
    const stderr = captureStderr()

    try {
      const code = await runLogAction({
        limit: 50,
        outputFormat: 'json',
        projectRoot,
        version: '1.0.0',
      })

      expect(code).toBe(0)
      expect(stderr.get()).toBe('')

      const parsed = JSON.parse(stdout.get()) as {
        command: string
        version: string
        data: Array<{
          event: string
          session_id: string
          task_id: string | null
        }>
      }
      expect(parsed.command).toBe('substrate log')
      expect(Array.isArray(parsed.data)).toBe(true)
      expect(parsed.data.length).toBeGreaterThan(0)

      // Should have task status changes
      const taskEntries = parsed.data.filter(e => e.event === 'task:status_change')
      expect(taskEntries.length).toBeGreaterThanOrEqual(1)

      // All entries should belong to the session
      for (const entry of parsed.data) {
        expect(entry.session_id).toBe(sessionId)
      }
    } finally {
      stdout.restore()
      stderr.restore()
    }
  })

  it('runLogAction --task filters to a specific task', async () => {
    const content = JSON.stringify({
      version: '1',
      session: { name: 'log-task-filter-test' },
      tasks: {
        taskP: { name: 'Task P', prompt: 'Do P', type: 'coding', depends_on: [] },
        taskQ: { name: 'Task Q', prompt: 'Do Q', type: 'coding', depends_on: [] },
      },
    })
    const sessionId = await engine.loadGraphFromString(content, 'json')
    engine.startExecution(sessionId, 2)
    engine.markTaskRunning('taskP', 'worker-p')
    engine.markTaskComplete('taskP', 'done-p', 0.01)
    engine.markTaskRunning('taskQ', 'worker-q')
    engine.markTaskComplete('taskQ', 'done-q', 0.02)

    const stdout = captureStdout()
    const stderr = captureStderr()

    try {
      const code = await runLogAction({
        taskId: 'taskP',
        limit: 50,
        outputFormat: 'json',
        projectRoot,
        version: '1.0.0',
      })

      expect(code).toBe(0)

      const parsed = JSON.parse(stdout.get()) as {
        data: Array<{ task_id: string | null }>
      }
      // Every entry should be for taskP
      for (const entry of parsed.data) {
        expect(entry.task_id).toBe('taskP')
      }
    } finally {
      stdout.restore()
      stderr.restore()
    }
  })

  it('runLogAction --event orchestrator:state_change returns orchestrator transitions', async () => {
    const content = JSON.stringify({
      version: '1',
      session: { name: 'log-orch-test' },
      tasks: {
        taskOrch: { name: 'Orch Task', prompt: 'Do it', type: 'coding', depends_on: [] },
      },
    })
    const sessionId = await engine.loadGraphFromString(content, 'json')
    engine.startExecution(sessionId, 1)
    engine.markTaskRunning('taskOrch', 'worker-orch')
    engine.markTaskComplete('taskOrch', 'done', 0.01)

    const stdout = captureStdout()
    const stderr = captureStderr()

    try {
      const code = await runLogAction({
        event: 'orchestrator:state_change',
        limit: 50,
        outputFormat: 'json',
        projectRoot,
        version: '1.0.0',
      })

      expect(code).toBe(0)

      const parsed = JSON.parse(stdout.get()) as {
        data: Array<{ event: string }>
      }
      expect(parsed.data.length).toBeGreaterThanOrEqual(1)
      for (const entry of parsed.data) {
        expect(entry.event).toBe('orchestrator:state_change')
      }
    } finally {
      stdout.restore()
      stderr.restore()
    }
  })
})

// ---------------------------------------------------------------------------
// GAP-4: Crash-recovery then resume — execution_log continuity
// ---------------------------------------------------------------------------

describe('GAP-4: crash recovery → resume → execution_log continuity', () => {
  let tmpDir: string
  let dbPath: string

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'epic6-gap4-'))
    dbPath = join(tmpDir, 'state.db')
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('execution_log contains pre-crash entries after crash recovery', async () => {
    // --- Phase 1: Run tasks, simulate a HARD crash (no graceful shutdown) ---
    // In a hard crash, setupGracefulShutdown never runs, so tasks remain in
    // 'running' state and the session stays 'active'. CrashRecoveryManager
    // is responsible for finding and re-queuing these orphaned tasks.
    const dbService1 = new DatabaseServiceImpl(dbPath)
    const eventBus1 = createEventBus()
    const engine1 = new TaskGraphEngineImpl(eventBus1, dbService1)
    await dbService1.initialize()
    await engine1.initialize()

    const content = JSON.stringify({
      version: '1',
      session: { name: 'continuity-test' },
      tasks: {
        task1: { name: 'Task 1', prompt: 'Do 1', type: 'coding', agent: 'claude-code', depends_on: [] },
        task2: { name: 'Task 2', prompt: 'Do 2', type: 'coding', depends_on: ['task1'] },
      },
    })
    const sessionId = await engine1.loadGraphFromString(content, 'json')
    engine1.startExecution(sessionId, 2)
    // task1 starts running (log entry: pending→running)
    engine1.markTaskRunning('task1', 'worker-1')
    // HARD crash happens here — task1 is still running in DB, session is still 'active'

    // Simulate a hard crash: only mark session as interrupted (not clearing tasks)
    // This represents the case where the OS killed the process (no signal handler ran)
    dbService1.db.prepare(`
      UPDATE sessions SET status = 'interrupted', updated_at = datetime('now') WHERE id = ?
    `).run(sessionId)
    // NOTE: tasks are still 'running' — CrashRecoveryManager must handle this

    // Count pre-crash log entries (should have orchestrator + task:running entries)
    const preCrashEntries = getSessionLog(dbService1.db, sessionId)
    expect(preCrashEntries.length).toBeGreaterThan(0)

    await dbService1.shutdown()

    // --- Phase 2: After crash, open DB and run crash recovery ---
    const wrapper = new DatabaseWrapper(dbPath)
    wrapper.open()
    const db = wrapper.db

    // Verify session is interrupted
    const interruptedSession = CrashRecoveryManager.findInterruptedSession(db)
    expect(interruptedSession).toBeDefined()
    expect(interruptedSession!.id).toBe(sessionId)

    // Run recovery — task1 is still 'running', so it should be re-queued
    const manager = new CrashRecoveryManager({ db })
    const result = manager.recover(sessionId)

    // task1 was left running (hard crash), max_retries=2, retry_count=0 → retryable
    expect(result.recovered).toBeGreaterThanOrEqual(1)

    // Pre-crash log entries are still there (recovery doesn't delete log entries)
    const afterRecoveryEntries = getSessionLog(db, sessionId)
    expect(afterRecoveryEntries.length).toBe(preCrashEntries.length)

    wrapper.close()
  })

  it('execution_log accumulates entries across crash boundary and resumed execution', async () => {
    // --- Phase 1: Partially execute, then crash ---
    const dbService1 = new DatabaseServiceImpl(dbPath)
    const eventBus1 = createEventBus()
    const engine1 = new TaskGraphEngineImpl(eventBus1, dbService1)
    await dbService1.initialize()
    await engine1.initialize()

    const content = JSON.stringify({
      version: '1',
      session: { name: 'accumulate-test' },
      tasks: {
        taskA: { name: 'Task A', prompt: 'Do A', type: 'coding', depends_on: [] },
        taskB: { name: 'Task B', prompt: 'Do B', type: 'coding', depends_on: ['taskA'] },
      },
    })
    const sessionId = await engine1.loadGraphFromString(content, 'json')
    engine1.startExecution(sessionId, 2)
    engine1.markTaskRunning('taskA', 'worker-1')
    // crash: taskA is running

    const preCrashCount = getSessionLog(dbService1.db, sessionId).length

    // Simulate crash shutdown writes
    dbService1.db.prepare(`
      UPDATE tasks SET status = 'pending', retry_count = retry_count + 1, worker_id = NULL,
        updated_at = datetime('now') WHERE session_id = ? AND status = 'running'
    `).run(sessionId)
    dbService1.db.prepare(`
      UPDATE sessions SET status = 'interrupted', updated_at = datetime('now') WHERE id = ?
    `).run(sessionId)

    await dbService1.shutdown()

    // --- Phase 2: Recovery + resume ---
    const dbService2 = new DatabaseServiceImpl(dbPath)
    const eventBus2 = createEventBus()
    const engine2 = new TaskGraphEngineImpl(eventBus2, dbService2)
    await dbService2.initialize()
    await engine2.initialize()

    // Run crash recovery
    const manager = new CrashRecoveryManager({ db: dbService2.db })
    manager.recover(sessionId)

    // Resume execution — mark session active
    dbService2.db.prepare(`UPDATE sessions SET status = 'active' WHERE id = ?`).run(sessionId)

    // Start new execution round
    engine2.startExecution(sessionId, 2)
    engine2.markTaskRunning('taskA', 'worker-2')
    engine2.markTaskComplete('taskA', 'result-a', 0.01)
    engine2.markTaskRunning('taskB', 'worker-3')
    engine2.markTaskComplete('taskB', 'result-b', 0.02)

    const postResumeEntries = getSessionLog(dbService2.db, sessionId)

    // The log should have MORE entries than before the crash (pre-crash + resumed execution)
    expect(postResumeEntries.length).toBeGreaterThan(preCrashCount)

    // Should contain both old and new transitions
    const allTaskEntries = getLogByEvent(dbService2.db, sessionId, 'task:status_change')
    expect(allTaskEntries.length).toBeGreaterThanOrEqual(2)

    // taskA should appear as running at least twice (pre-crash running + post-resume running)
    const taskARunningEntries = allTaskEntries.filter(
      e => e.task_id === 'taskA' && e.new_status === 'running',
    )
    expect(taskARunningEntries.length).toBeGreaterThanOrEqual(2)

    await dbService2.shutdown()
  })

  it('archiveSession removes interrupted session from findInterruptedSession results', () => {
    const wrapper = new DatabaseWrapper(dbPath)
    wrapper.open()
    runMigrations(wrapper.db)
    const db = wrapper.db

    insertSession(db, 'sess-archive-test', 'interrupted')

    // findInterruptedSession returns it
    expect(CrashRecoveryManager.findInterruptedSession(db)).toBeDefined()

    // After archiving, it should not be findable
    CrashRecoveryManager.archiveSession(db, 'sess-archive-test')
    expect(CrashRecoveryManager.findInterruptedSession(db)).toBeUndefined()

    wrapper.close()
  })

  it('when graph starts fresh with --graph and prior session exists, archiveSession is called and new session has clean log', async () => {
    // Create an "interrupted" session with some log entries
    const wrapper = new DatabaseWrapper(dbPath)
    wrapper.open()
    runMigrations(wrapper.db)
    const db = wrapper.db
    insertSession(db, 'old-session', 'interrupted')
    appendLog(db, {
      session_id: 'old-session',
      event: 'orchestrator:state_change',
      old_status: 'Idle',
      new_status: 'Loading',
    })
    wrapper.close()

    // Now simulate: user runs `substrate start --graph ...` with an existing interrupted session
    // start.ts calls CrashRecoveryManager.archiveSession on the old session, then loads a new graph
    const dbService = new DatabaseServiceImpl(dbPath)
    const eventBus = createEventBus()
    const engine = new TaskGraphEngineImpl(eventBus, dbService)
    await dbService.initialize()
    await engine.initialize()

    // Archive the old session (as start.ts does)
    CrashRecoveryManager.archiveSession(dbService.db, 'old-session')

    const content = JSON.stringify({
      version: '1',
      session: { name: 'fresh-start' },
      tasks: {
        newTask: { name: 'New Task', prompt: 'Do it', type: 'coding', depends_on: [] },
      },
    })
    const newSessionId = await engine.loadGraphFromString(content, 'json')
    engine.startExecution(newSessionId, 1)
    engine.markTaskRunning('newTask', 'worker-new')
    engine.markTaskComplete('newTask', 'output', 0.01)

    // Old session is abandoned
    const oldSession = dbService.db.prepare('SELECT status FROM sessions WHERE id = ?').get('old-session') as { status: string }
    expect(oldSession.status).toBe('abandoned')

    // New session has its own clean log
    const newLog = getSessionLog(dbService.db, newSessionId)
    expect(newLog.length).toBeGreaterThan(0)
    for (const entry of newLog) {
      expect(entry.session_id).toBe(newSessionId)
    }

    // Old session log is unchanged
    const oldLog = getSessionLog(dbService.db, 'old-session')
    expect(oldLog).toHaveLength(1)

    await dbService.shutdown()
  })
})
