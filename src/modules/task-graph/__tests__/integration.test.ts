/**
 * Integration tests for TaskGraphEngine (AC: #1, #4, #5)
 *
 * Uses an in-memory SQLite database for all DB tests.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { join } from 'node:path'
import { DatabaseServiceImpl } from '../../../persistence/database.js'
import { createEventBus } from '../../../core/event-bus.js'
import { TaskGraphEngineImpl, createTaskGraphEngine } from '../task-graph-engine.js'
import { validateGraph, ValidationError } from '../task-validator.js'
import { AdapterRegistry } from '../../../adapters/adapter-registry.js'
import { getTasksByStatus } from '../../../persistence/queries/tasks.js'
import { getSession } from '../../../persistence/queries/sessions.js'

const FIXTURES_DIR = join(import.meta.dirname, 'fixtures')

// ---------------------------------------------------------------------------
// Test setup helpers
// ---------------------------------------------------------------------------

function createTestEngine() {
  const dbService = new DatabaseServiceImpl(':memory:')
  const eventBus = createEventBus()
  const engine = new TaskGraphEngineImpl(eventBus, dbService)
  return { dbService, eventBus, engine }
}

// ---------------------------------------------------------------------------
// AC1: Valid YAML fixture → tasks persisted with status 'pending'
// ---------------------------------------------------------------------------

describe('TaskGraphEngine — integration', () => {
  let dbService: DatabaseServiceImpl
  let engine: TaskGraphEngineImpl
  let eventBus: ReturnType<typeof createEventBus>

  beforeEach(async () => {
    const setup = createTestEngine()
    dbService = setup.dbService
    engine = setup.engine
    eventBus = setup.eventBus
    await dbService.initialize()
    await engine.initialize()
  })

  afterEach(async () => {
    await dbService.shutdown()
  })

  // -------------------------------------------------------------------------
  // AC1: Load valid YAML → tasks persisted with status 'pending'
  // -------------------------------------------------------------------------

  it('AC1: loads a valid YAML file and persists tasks with status pending', async () => {
    const filePath = join(FIXTURES_DIR, 'valid-graph.yaml')
    const sessionId = await engine.loadGraph(filePath)

    expect(sessionId).toBeDefined()
    expect(typeof sessionId).toBe('string')

    // Verify session was created
    const session = getSession(dbService.db, sessionId)
    expect(session).toBeDefined()
    expect(session?.name).toBe('test-project')
    expect(session?.graph_file).toBe(filePath)

    // Verify tasks were created with status 'pending'
    const pendingTasks = getTasksByStatus(dbService.db, sessionId, 'pending')
    expect(pendingTasks.length).toBe(3) // task-1, task-2, task-3

    // Every task must have status 'pending'
    for (const task of pendingTasks) {
      expect(task.status).toBe('pending')
    }
  })

  it('AC1: dependencies are persisted to task_dependencies table', async () => {
    const filePath = join(FIXTURES_DIR, 'valid-graph.yaml')
    const sessionId = await engine.loadGraph(filePath)

    // Check that task-2 depends on task-1
    const deps = dbService.db
      .prepare('SELECT * FROM task_dependencies WHERE task_id = ?')
      .all('task-2') as Array<{ task_id: string; depends_on: string }>

    expect(deps).toHaveLength(1)
    expect(deps[0].depends_on).toBe('task-1')
  })

  it('AC1: emits graph:loaded event with sessionId, taskCount and readyCount', async () => {
    const loadedEvents: Array<{ sessionId: string; taskCount: number; readyCount: number }> = []
    eventBus.on('graph:loaded', (payload) => {
      loadedEvents.push(payload)
    })

    const filePath = join(FIXTURES_DIR, 'valid-graph.yaml')
    await engine.loadGraph(filePath)

    expect(loadedEvents).toHaveLength(1)
    expect(typeof loadedEvents[0].sessionId).toBe('string')
    expect(loadedEvents[0].sessionId.length).toBeGreaterThan(0)
    expect(loadedEvents[0].taskCount).toBe(3)
    // task-1, task-3 have no deps (or only task-1 dep which is pending)
    // Actually task-1 has no deps so it's ready; task-2 and task-3 depend on task-1
    expect(loadedEvents[0].readyCount).toBeGreaterThanOrEqual(1)
  })

  // -------------------------------------------------------------------------
  // AC4: Cyclic graph → ValidationError thrown, no DB rows
  // -------------------------------------------------------------------------

  it('AC4: rejects cyclic graph with ValidationError', async () => {
    const filePath = join(FIXTURES_DIR, 'cyclic-graph.yaml')

    await expect(engine.loadGraph(filePath)).rejects.toThrow(ValidationError)
  })

  it('AC4: no DB rows created when cyclic graph is rejected', async () => {
    const filePath = join(FIXTURES_DIR, 'cyclic-graph.yaml')

    try {
      await engine.loadGraph(filePath)
    } catch (_err) {
      // Expected
    }

    // Verify no sessions were created
    const sessions = dbService.db.prepare('SELECT * FROM sessions').all()
    expect(sessions).toHaveLength(0)

    // Verify no tasks were created
    const tasks = dbService.db.prepare('SELECT * FROM tasks').all()
    expect(tasks).toHaveLength(0)
  })

  it('AC4: ValidationError message contains cycle path', async () => {
    const filePath = join(FIXTURES_DIR, 'cyclic-graph.yaml')

    let caughtError: ValidationError | null = null
    try {
      await engine.loadGraph(filePath)
    } catch (err) {
      if (err instanceof ValidationError) {
        caughtError = err
      }
    }

    expect(caughtError).not.toBeNull()
    const errorText = caughtError!.errors.join(' ')
    expect(errorText.toLowerCase()).toContain('circular')
  })

  // -------------------------------------------------------------------------
  // AC5: Graph with missing dep → ValidationError with helpful message
  // -------------------------------------------------------------------------

  it('AC5: rejects graph with missing dependency reference', async () => {
    const filePath = join(FIXTURES_DIR, 'missing-dep-graph.yaml')

    await expect(engine.loadGraph(filePath)).rejects.toThrow(ValidationError)
  })

  it('AC5: error message identifies the missing dependency', async () => {
    const filePath = join(FIXTURES_DIR, 'missing-dep-graph.yaml')

    let caughtError: ValidationError | null = null
    try {
      await engine.loadGraph(filePath)
    } catch (err) {
      if (err instanceof ValidationError) {
        caughtError = err
      }
    }

    expect(caughtError).not.toBeNull()
    const errorText = caughtError!.errors.join(' ')
    expect(errorText).toContain('nonexistent-task')
  })

  // -------------------------------------------------------------------------
  // AC2: JSON file → same behavior as YAML
  // -------------------------------------------------------------------------

  it('AC2: loads a valid JSON file with same behavior as YAML', async () => {
    const filePath = join(FIXTURES_DIR, 'valid-graph.json')
    const sessionId = await engine.loadGraph(filePath)

    expect(sessionId).toBeDefined()

    const session = getSession(dbService.db, sessionId)
    expect(session).toBeDefined()
    expect(session?.name).toBe('json-test-project')

    const pendingTasks = getTasksByStatus(dbService.db, sessionId, 'pending')
    expect(pendingTasks.length).toBe(2)

    for (const task of pendingTasks) {
      expect(task.status).toBe('pending')
    }
  })

  // -------------------------------------------------------------------------
  // AC3: loadGraphFromString
  // -------------------------------------------------------------------------

  it('AC3: loadGraphFromString with YAML content works identically to file loading', async () => {
    const content = `
version: "1"
session:
  name: "string-test"
  budget_usd: 3.0
tasks:
  st-1:
    name: "String Task 1"
    prompt: "Do string task 1"
    type: "coding"
    depends_on: []
  st-2:
    name: "String Task 2"
    prompt: "Do string task 2"
    type: "testing"
    depends_on:
      - st-1
`
    const sessionId = await engine.loadGraphFromString(content, 'yaml')

    expect(sessionId).toBeDefined()

    const session = getSession(dbService.db, sessionId)
    expect(session?.name).toBe('string-test')

    const pendingTasks = getTasksByStatus(dbService.db, sessionId, 'pending')
    expect(pendingTasks.length).toBe(2)
  })

  it('AC3: loadGraphFromString with JSON content works identically to file loading', async () => {
    const content = JSON.stringify({
      version: '1',
      session: { name: 'json-string-test' },
      tasks: {
        'jst-1': { name: 'JSON String Task', prompt: 'Do it', type: 'coding', depends_on: [] },
      },
    })
    const sessionId = await engine.loadGraphFromString(content, 'json')

    expect(sessionId).toBeDefined()

    const session = getSession(dbService.db, sessionId)
    expect(session?.name).toBe('json-string-test')
  })

  it('AC3: loadGraphFromString throws ValidationError for cyclic content', async () => {
    const content = `
version: "1"
session:
  name: "cyclic"
tasks:
  a:
    name: "A"
    prompt: "A"
    type: "coding"
    depends_on: [b]
  b:
    name: "B"
    prompt: "B"
    type: "coding"
    depends_on: [a]
`
    await expect(engine.loadGraphFromString(content, 'yaml')).rejects.toThrow(ValidationError)
  })

  // -------------------------------------------------------------------------
  // AC7: Version compatibility
  // -------------------------------------------------------------------------

  it('AC7: rejects graph with unsupported version', async () => {
    const content = `
version: "99"
session:
  name: "bad-version"
tasks:
  t1:
    name: "T1"
    prompt: "Do it"
    type: "coding"
    depends_on: []
`
    let caughtError: ValidationError | null = null
    try {
      await engine.loadGraphFromString(content, 'yaml')
    } catch (err) {
      if (err instanceof ValidationError) {
        caughtError = err
      }
    }

    expect(caughtError).not.toBeNull()
    const errorText = caughtError!.errors.join(' ')
    expect(errorText).toContain('99')
    expect(errorText.toLowerCase()).toContain('not supported')
  })

  it('AC7: no DB rows created when version is rejected', async () => {
    const content = `
version: "2"
session:
  name: "bad"
tasks: {}
`
    try {
      await engine.loadGraphFromString(content, 'yaml')
    } catch (_err) {
      // Expected
    }

    const sessions = dbService.db.prepare('SELECT * FROM sessions').all()
    expect(sessions).toHaveLength(0)
  })

  // -------------------------------------------------------------------------
  // AC6: Agent assignment with unknown agent → warning (not error)
  // -------------------------------------------------------------------------

  it('AC6: produces a warning (not error) when task references unknown agent', () => {
    const raw = {
      version: '1',
      session: { name: 'agent-test' },
      tasks: {
        't1': {
          name: 'Agent Task',
          prompt: 'Do it',
          type: 'coding',
          depends_on: [],
          agent: 'unknown-agent',
        },
      },
    }

    // Provide an empty registry (no agents registered)
    const registry = new AdapterRegistry()

    const result = validateGraph(raw, registry)

    // Should still be valid (agent availability is a warning, not an error)
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
    expect(result.warnings.length).toBeGreaterThan(0)

    // Warning should mention the unknown agent
    const warningText = result.warnings.join(' ')
    expect(warningText).toContain('unknown-agent')
  })
})

// ---------------------------------------------------------------------------
// StubTaskGraphEngine (factory without databaseService)
// ---------------------------------------------------------------------------

describe('createTaskGraphEngine — stub path', () => {
  it('returns a stub engine when no databaseService is provided', async () => {
    const eventBus = createEventBus()
    const engine = createTaskGraphEngine({ eventBus })
    await engine.initialize()
    await engine.shutdown()
    // Stub engine throws on loadGraph (databaseService required)
    await expect(engine.loadGraph('any.yaml')).rejects.toThrow('databaseService is required')
  })

  it('stub engine throws on loadGraphFromString', async () => {
    const eventBus = createEventBus()
    const engine = createTaskGraphEngine({ eventBus })
    await engine.initialize()
    await expect(engine.loadGraphFromString('{}', 'json')).rejects.toThrow('databaseService is required')
  })
})
