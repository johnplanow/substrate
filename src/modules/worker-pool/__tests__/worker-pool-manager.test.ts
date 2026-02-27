/**
 * Tests for WorkerPoolManagerImpl
 *
 * Mocks child_process.spawn with a fake process (EventEmitter + PassThrough streams)
 * to simulate process lifecycle without actually spawning subprocesses.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import type { ChildProcess } from 'node:child_process'
import type { TypedEventBus } from '../../../core/event-bus.js'
import type { AdapterRegistry } from '../../../adapters/adapter-registry.js'
import type { WorkerAdapter } from '../../../adapters/worker-adapter.js'
import type { TaskGraphEngine } from '../../task-graph/task-graph-engine.js'
import type { DatabaseService } from '../../../persistence/database.js'
import type { Task } from '../../../persistence/queries/tasks.js'
import type { SpawnCommand, AdapterOptions, AdapterCapabilities, AdapterHealthResult, TaskResult, TokenEstimate, PlanRequest, PlanParseResult } from '../../../adapters/types.js'
import { WorkerPoolManagerImpl } from '../worker-pool-manager-impl.js'

// ---------------------------------------------------------------------------
// Fake process factory
// ---------------------------------------------------------------------------

function createFakeProcess(): {
  proc: ChildProcess
  emitClose: (code: number) => void
  writeStdout: (data: string) => void
  writeStderr: (data: string) => void
} {
  const emitter = new EventEmitter()
  const stdin = new PassThrough()
  const stdout = new PassThrough()
  const stderr = new PassThrough()

  // Create a minimal ChildProcess-like object
  const proc = Object.assign(emitter, {
    stdin,
    stdout,
    stderr,
    kill: vi.fn((signal?: string) => {
      // simulate process killed
      if (signal === 'SIGKILL') {
        emitter.emit('close', 1)
      }
    }),
    pid: 12345,
  }) as unknown as ChildProcess

  const writeStdout = (data: string) => stdout.push(data)
  const writeStderr = (data: string) => stderr.push(data)
  const emitClose = (code: number) => emitter.emit('close', code)

  return { proc, emitClose, writeStdout, writeStderr }
}

// ---------------------------------------------------------------------------
// Mock spawn
// ---------------------------------------------------------------------------

let currentFakeProcess: ReturnType<typeof createFakeProcess>

vi.mock('node:child_process', () => ({
  spawn: vi.fn(() => currentFakeProcess.proc),
}))

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function createMockTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-1',
    session_id: 'session-1',
    name: 'Test Task',
    prompt: 'Do some work',
    status: 'ready',
    agent: 'claude-code',
    cost_usd: 0,
    input_tokens: 0,
    output_tokens: 0,
    retry_count: 0,
    max_retries: 2,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  }
}

function createMockAdapter(id = 'claude-code'): WorkerAdapter {
  return {
    id,
    displayName: 'Claude Code',
    adapterVersion: '1.0.0',
    buildCommand: vi.fn((_prompt: string, _options: AdapterOptions): SpawnCommand => ({
      binary: 'claude',
      args: ['-p', _prompt, '--output-format', 'json'],
      cwd: _options.worktreePath,
    })),
    parseOutput: vi.fn((_stdout: string, _stderr: string, _exitCode: number): TaskResult => ({
      success: _exitCode === 0,
      output: _stdout || 'parsed output',
      exitCode: _exitCode,
    })),
    buildPlanningCommand: vi.fn((_request: PlanRequest, _options: AdapterOptions): SpawnCommand => ({
      binary: 'claude',
      args: ['-p', _request.goal],
      cwd: _options.worktreePath,
    })),
    parsePlanOutput: vi.fn((_stdout: string, _stderr: string, _exitCode: number): PlanParseResult => ({
      success: true,
      tasks: [],
    })),
    estimateTokens: vi.fn((_prompt: string): TokenEstimate => ({ input: 10, output: 5, total: 15 })),
    healthCheck: vi.fn(async (): Promise<AdapterHealthResult> => ({ healthy: true, supportsHeadless: true })),
    getCapabilities: vi.fn((): AdapterCapabilities => ({
      supportsJsonOutput: true,
      supportsStreaming: false,
      supportsSubscriptionBilling: true,
      supportsApiBilling: true,
      supportsPlanGeneration: true,
      maxContextTokens: 200_000,
      supportedTaskTypes: ['code'],
      supportedLanguages: ['*'],
    })),
  }
}

function createMockEventBus(): TypedEventBus {
  const emitter = new EventEmitter()
  return {
    emit: vi.fn((event: string, payload: unknown) => emitter.emit(event, payload)),
    on: vi.fn((event: string, handler: (payload: unknown) => void) => emitter.on(event, handler)),
    off: vi.fn((event: string, handler: (payload: unknown) => void) => emitter.off(event, handler)),
  } as unknown as TypedEventBus
}

function createMockEngine(): TaskGraphEngine {
  return {
    initialize: vi.fn(async () => {}),
    shutdown: vi.fn(async () => {}),
    markTaskRunning: vi.fn(),
    markTaskComplete: vi.fn(),
    markTaskFailed: vi.fn(),
    markTaskCancelled: vi.fn(),
    loadGraph: vi.fn(async () => 'session-1'),
    loadGraphFromString: vi.fn(async () => 'session-1'),
    startExecution: vi.fn(),
    getReadyTasks: vi.fn(() => []),
    getTask: vi.fn(() => undefined),
    getAllTasks: vi.fn(() => []),
    getTasksByStatus: vi.fn(() => []),
    pause: vi.fn(),
    resume: vi.fn(),
    cancelAll: vi.fn(),
    state: 'Executing' as const,
  } as unknown as TaskGraphEngine
}

function createMockDb(task?: Task): DatabaseService {
  const db = {
    prepare: vi.fn(() => ({
      get: vi.fn(() => task),
      all: vi.fn(() => []),
      run: vi.fn(),
    })),
  }
  return {
    initialize: vi.fn(async () => {}),
    shutdown: vi.fn(async () => {}),
    isOpen: true,
    db: db as unknown as DatabaseService['db'],
  }
}

function createMockAdapterRegistry(adapter?: WorkerAdapter): AdapterRegistry {
  return {
    register: vi.fn(),
    get: vi.fn(() => adapter),
    getAll: vi.fn(() => (adapter ? [adapter] : [])),
    getPlanningCapable: vi.fn(() => []),
    discoverAndRegister: vi.fn(async () => ({ registeredCount: 0, failedCount: 0, results: [] })),
  } as unknown as AdapterRegistry
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('WorkerPoolManagerImpl', () => {
  beforeEach(() => {
    currentFakeProcess = createFakeProcess()
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  // -------------------------------------------------------------------------
  // AC1: Worker Spawning on task:ready
  // -------------------------------------------------------------------------

  describe('AC1: spawnWorker emits task:started and worker:spawned', () => {
    it('emits task:started before spawning and worker:spawned after', () => {
      const task = createMockTask()
      const adapter = createMockAdapter()
      const eventBus = createMockEventBus()
      const engine = createMockEngine()
      const db = createMockDb(task)
      const registry = createMockAdapterRegistry(adapter)

      const manager = new WorkerPoolManagerImpl(eventBus, registry, engine, db)

      manager.spawnWorker(task, adapter, '/tmp/worktree')

      const emitMock = eventBus.emit as ReturnType<typeof vi.fn>
      const calls = emitMock.mock.calls as Array<[string, unknown]>

      const taskStartedCall = calls.find(([event]) => event === 'task:started')
      expect(taskStartedCall).toBeDefined()
      expect(taskStartedCall![1]).toMatchObject({
        taskId: 'task-1',
        agent: 'claude-code',
      })

      const workerSpawnedCall = calls.find(([event]) => event === 'worker:spawned')
      expect(workerSpawnedCall).toBeDefined()
      expect(workerSpawnedCall![1]).toMatchObject({
        taskId: 'task-1',
        agent: 'claude-code',
      })
    })

    it('calls adapter.buildCommand with task.prompt and options', () => {
      const task = createMockTask({ prompt: 'Fix the bug' })
      const adapter = createMockAdapter()
      const eventBus = createMockEventBus()
      const engine = createMockEngine()
      const db = createMockDb(task)
      const registry = createMockAdapterRegistry(adapter)

      const manager = new WorkerPoolManagerImpl(eventBus, registry, engine, db)
      manager.spawnWorker(task, adapter, '/my/worktree')

      expect(adapter.buildCommand).toHaveBeenCalledWith(
        'Fix the bug',
        expect.objectContaining({ worktreePath: '/my/worktree', billingMode: 'subscription' }),
      )
    })

    it('adds worker to active pool after spawn', () => {
      const task = createMockTask()
      const adapter = createMockAdapter()
      const eventBus = createMockEventBus()
      const engine = createMockEngine()
      const db = createMockDb(task)
      const registry = createMockAdapterRegistry(adapter)

      const manager = new WorkerPoolManagerImpl(eventBus, registry, engine, db)
      manager.spawnWorker(task, adapter, process.cwd())

      expect(manager.getWorkerCount()).toBe(1)
    })

    it('calls engine.markTaskRunning after spawn', () => {
      const task = createMockTask()
      const adapter = createMockAdapter()
      const eventBus = createMockEventBus()
      const engine = createMockEngine()
      const db = createMockDb(task)
      const registry = createMockAdapterRegistry(adapter)

      const manager = new WorkerPoolManagerImpl(eventBus, registry, engine, db)
      manager.spawnWorker(task, adapter, process.cwd())

      expect(engine.markTaskRunning).toHaveBeenCalledWith('task-1', expect.any(String))
    })
  })

  // -------------------------------------------------------------------------
  // AC2: Successful Worker Completion
  // -------------------------------------------------------------------------

  describe('AC2: process exits 0 → task:complete emitted', () => {
    it('emits task:complete with parsed result when exit code is 0', () => {
      const task = createMockTask()
      const adapter = createMockAdapter()
      const eventBus = createMockEventBus()
      const engine = createMockEngine()
      const db = createMockDb(task)
      const registry = createMockAdapterRegistry(adapter)

      const manager = new WorkerPoolManagerImpl(eventBus, registry, engine, db)
      manager.spawnWorker(task, adapter, process.cwd())

      // Simulate stdout then exit 0
      currentFakeProcess.writeStdout('{"output":"done"}')
      currentFakeProcess.emitClose(0)

      const emitMock = eventBus.emit as ReturnType<typeof vi.fn>
      const calls = emitMock.mock.calls as Array<[string, unknown]>
      const completeCall = calls.find(([event]) => event === 'task:complete')

      expect(completeCall).toBeDefined()
      expect(completeCall![1]).toMatchObject({
        taskId: 'task-1',
        result: expect.objectContaining({ exitCode: 0 }),
      })
    })

    it('removes worker from pool after completion', () => {
      const task = createMockTask()
      const adapter = createMockAdapter()
      const eventBus = createMockEventBus()
      const engine = createMockEngine()
      const db = createMockDb(task)
      const registry = createMockAdapterRegistry(adapter)

      const manager = new WorkerPoolManagerImpl(eventBus, registry, engine, db)
      manager.spawnWorker(task, adapter, process.cwd())
      expect(manager.getWorkerCount()).toBe(1)

      currentFakeProcess.emitClose(0)
      expect(manager.getWorkerCount()).toBe(0)
    })

    it('does NOT call engine.markTaskComplete directly (engine subscribes to task:complete event)', () => {
      const task = createMockTask()
      const adapter = createMockAdapter()
      const eventBus = createMockEventBus()
      const engine = createMockEngine()
      const db = createMockDb(task)
      const registry = createMockAdapterRegistry(adapter)

      const manager = new WorkerPoolManagerImpl(eventBus, registry, engine, db)
      manager.spawnWorker(task, adapter, process.cwd())

      currentFakeProcess.emitClose(0)

      // Worker pool manager should NOT call engine.markTaskComplete directly —
      // it only emits task:complete, and the engine's own event listener handles the DB update.
      expect(engine.markTaskComplete).not.toHaveBeenCalled()
    })
  })

  // -------------------------------------------------------------------------
  // AC3: Worker Failure Handling
  // -------------------------------------------------------------------------

  describe('AC3: process exits non-0 → task:failed emitted, others unaffected', () => {
    it('emits task:failed with stderr when exit code is non-zero', () => {
      const task = createMockTask()
      const adapter = createMockAdapter()
      const eventBus = createMockEventBus()
      const engine = createMockEngine()
      const db = createMockDb(task)
      const registry = createMockAdapterRegistry(adapter)

      const manager = new WorkerPoolManagerImpl(eventBus, registry, engine, db)
      manager.spawnWorker(task, adapter, process.cwd())

      currentFakeProcess.writeStderr('something went wrong')
      currentFakeProcess.emitClose(1)

      const emitMock = eventBus.emit as ReturnType<typeof vi.fn>
      const calls = emitMock.mock.calls as Array<[string, unknown]>
      const failedCall = calls.find(([event]) => event === 'task:failed')

      expect(failedCall).toBeDefined()
      expect(failedCall![1]).toMatchObject({
        taskId: 'task-1',
        error: expect.objectContaining({ message: 'something went wrong', code: '1' }),
      })
    })

    it('does not affect other running workers when one fails', () => {
      const task1 = createMockTask({ id: 'task-1' })
      const task2 = createMockTask({ id: 'task-2' })
      const adapter = createMockAdapter()
      const eventBus = createMockEventBus()
      const engine = createMockEngine()
      const db = createMockDb()
      const registry = createMockAdapterRegistry(adapter)

      const manager = new WorkerPoolManagerImpl(eventBus, registry, engine, db)

      // Spawn first worker
      const fakeProc1 = currentFakeProcess
      manager.spawnWorker(task1, adapter, process.cwd())

      // Spawn second worker with a fresh fake process
      currentFakeProcess = createFakeProcess()
      manager.spawnWorker(task2, adapter, process.cwd())

      expect(manager.getWorkerCount()).toBe(2)

      // Fail the first worker
      fakeProc1.emitClose(1)

      // Second worker should still be active
      expect(manager.getWorkerCount()).toBe(1)
      const workers = manager.getActiveWorkers()
      expect(workers[0]?.taskId).toBe('task-2')
    })

    it('removes worker from pool after failure', () => {
      const task = createMockTask()
      const adapter = createMockAdapter()
      const eventBus = createMockEventBus()
      const engine = createMockEngine()
      const db = createMockDb(task)
      const registry = createMockAdapterRegistry(adapter)

      const manager = new WorkerPoolManagerImpl(eventBus, registry, engine, db)
      manager.spawnWorker(task, adapter, process.cwd())
      expect(manager.getWorkerCount()).toBe(1)

      currentFakeProcess.emitClose(2)
      expect(manager.getWorkerCount()).toBe(0)
    })

    it('does NOT call engine.markTaskFailed directly (engine subscribes to task:failed event)', () => {
      const task = createMockTask()
      const adapter = createMockAdapter()
      const eventBus = createMockEventBus()
      const engine = createMockEngine()
      const db = createMockDb(task)
      const registry = createMockAdapterRegistry(adapter)

      const manager = new WorkerPoolManagerImpl(eventBus, registry, engine, db)
      manager.spawnWorker(task, adapter, process.cwd())

      currentFakeProcess.writeStderr('error occurred')
      currentFakeProcess.emitClose(42)

      // Worker pool manager should NOT call engine.markTaskFailed directly —
      // it only emits task:failed, and the engine's own event listener handles the DB update.
      expect(engine.markTaskFailed).not.toHaveBeenCalled()
    })
  })

  // -------------------------------------------------------------------------
  // AC4: Terminate All Workers
  // -------------------------------------------------------------------------

  describe('AC4: terminateAll() sends SIGTERM and clears pool', () => {
    it('emits worker:terminated for each terminated worker', async () => {
      const task = createMockTask()
      const adapter = createMockAdapter()
      const eventBus = createMockEventBus()
      const engine = createMockEngine()
      const db = createMockDb(task)
      const registry = createMockAdapterRegistry(adapter)

      const manager = new WorkerPoolManagerImpl(eventBus, registry, engine, db)
      manager.spawnWorker(task, adapter, process.cwd())

      // Override setTimeout to be immediate so we don't wait 5 seconds
      vi.useFakeTimers()

      const terminatePromise = manager.terminateAll()
      vi.advanceTimersByTime(5_000)
      await terminatePromise

      vi.useRealTimers()

      const emitMock = eventBus.emit as ReturnType<typeof vi.fn>
      const calls = emitMock.mock.calls as Array<[string, unknown]>
      const terminatedCalls = calls.filter(([event]) => event === 'worker:terminated')

      expect(terminatedCalls.length).toBeGreaterThanOrEqual(1)
      expect(terminatedCalls[0]![1]).toMatchObject({ reason: 'terminateAll' })
    })

    it('clears the active pool after terminateAll', async () => {
      const task = createMockTask()
      const adapter = createMockAdapter()
      const eventBus = createMockEventBus()
      const engine = createMockEngine()
      const db = createMockDb(task)
      const registry = createMockAdapterRegistry(adapter)

      const manager = new WorkerPoolManagerImpl(eventBus, registry, engine, db)
      manager.spawnWorker(task, adapter, process.cwd())
      expect(manager.getWorkerCount()).toBe(1)

      vi.useFakeTimers()
      const terminatePromise = manager.terminateAll()
      vi.advanceTimersByTime(5_000)
      await terminatePromise
      vi.useRealTimers()

      expect(manager.getWorkerCount()).toBe(0)
    })

    it('sends SIGTERM first then SIGKILL after grace period for stubborn processes', async () => {
      const task = createMockTask()
      const adapter = createMockAdapter()
      const eventBus = createMockEventBus()
      const engine = createMockEngine()
      const db = createMockDb(task)
      const registry = createMockAdapterRegistry(adapter)

      const manager = new WorkerPoolManagerImpl(eventBus, registry, engine, db)
      manager.spawnWorker(task, adapter, process.cwd())

      const proc = currentFakeProcess.proc
      const killMock = proc.kill as ReturnType<typeof vi.fn>

      vi.useFakeTimers()
      const terminatePromise = manager.terminateAll()

      // SIGTERM should have been sent immediately
      expect(killMock).toHaveBeenCalledWith('SIGTERM')
      expect(killMock).not.toHaveBeenCalledWith('SIGKILL')

      // After grace period, SIGKILL for stubborn processes
      vi.advanceTimersByTime(5_000)
      await terminatePromise
      vi.useRealTimers()

      expect(killMock).toHaveBeenCalledWith('SIGKILL')

      // Verify order: SIGTERM before SIGKILL
      const killCalls = killMock.mock.calls.map((c: unknown[]) => c[0])
      const sigtermIdx = killCalls.indexOf('SIGTERM')
      const sigkillIdx = killCalls.indexOf('SIGKILL')
      expect(sigtermIdx).toBeLessThan(sigkillIdx)
    })
  })

  // -------------------------------------------------------------------------
  // AC5: Active Worker Queries
  // -------------------------------------------------------------------------

  describe('AC5: getActiveWorkers() returns correct WorkerInfo list', () => {
    it('returns WorkerInfo with expected fields', () => {
      const task = createMockTask({ id: 'task-5' })
      const adapter = createMockAdapter('my-adapter')
      const eventBus = createMockEventBus()
      const engine = createMockEngine()
      const db = createMockDb(task)
      const registry = createMockAdapterRegistry(adapter)

      const manager = new WorkerPoolManagerImpl(eventBus, registry, engine, db)
      manager.spawnWorker(task, adapter, process.cwd())

      const workers = manager.getActiveWorkers()
      expect(workers).toHaveLength(1)

      const info = workers[0]!
      expect(info.taskId).toBe('task-5')
      expect(info.adapter).toBe('my-adapter')
      expect(info.status).toBe('running')
      expect(info.startedAt).toBeInstanceOf(Date)
      expect(typeof info.elapsedMs).toBe('number')
      expect(info.elapsedMs).toBeGreaterThanOrEqual(0)
    })

    it('getWorkerCount() returns count of active workers', () => {
      const task1 = createMockTask({ id: 'task-1' })
      const task2 = createMockTask({ id: 'task-2' })
      const adapter = createMockAdapter()
      const eventBus = createMockEventBus()
      const engine = createMockEngine()
      const db = createMockDb()
      const registry = createMockAdapterRegistry(adapter)

      const manager = new WorkerPoolManagerImpl(eventBus, registry, engine, db)
      expect(manager.getWorkerCount()).toBe(0)

      manager.spawnWorker(task1, adapter, process.cwd())
      expect(manager.getWorkerCount()).toBe(1)

      currentFakeProcess = createFakeProcess()
      manager.spawnWorker(task2, adapter, process.cwd())
      expect(manager.getWorkerCount()).toBe(2)
    })

    it('getWorker() returns WorkerInfo for existing worker and null for unknown', () => {
      const task = createMockTask()
      const adapter = createMockAdapter()
      const eventBus = createMockEventBus()
      const engine = createMockEngine()
      const db = createMockDb(task)
      const registry = createMockAdapterRegistry(adapter)

      const manager = new WorkerPoolManagerImpl(eventBus, registry, engine, db)
      const handle = manager.spawnWorker(task, adapter, process.cwd())

      expect(manager.getWorker(handle.workerId)).not.toBeNull()
      expect(manager.getWorker('nonexistent-id')).toBeNull()
    })
  })

  // -------------------------------------------------------------------------
  // AC6: Worker Timeout
  // -------------------------------------------------------------------------

  describe('AC6: timeout kills process and emits task:failed', () => {
    it('emits task:failed with timeout message when timeoutMs elapses', () => {
      vi.useFakeTimers()

      const task = createMockTask()
      // Use a custom adapter that returns a SpawnCommand with timeoutMs
      const adapter = createMockAdapter()
      const buildCommandFn = vi.fn((_prompt: string, options: AdapterOptions): SpawnCommand => ({
        binary: 'claude',
        args: ['-p', _prompt],
        cwd: options.worktreePath,
        timeoutMs: 1_000,
      }))
      ;(adapter.buildCommand as ReturnType<typeof vi.fn>).mockImplementation(buildCommandFn)

      const eventBus = createMockEventBus()
      const engine = createMockEngine()
      const db = createMockDb(task)
      const registry = createMockAdapterRegistry(adapter)

      // Reset fake process so kill emits close
      currentFakeProcess = createFakeProcess()

      const manager = new WorkerPoolManagerImpl(eventBus, registry, engine, db)
      manager.spawnWorker(task, adapter, process.cwd())

      // Advance timer past timeout
      vi.advanceTimersByTime(1_001)

      vi.useRealTimers()

      const emitMock = eventBus.emit as ReturnType<typeof vi.fn>
      const calls = emitMock.mock.calls as Array<[string, unknown]>
      const failedCall = calls.find(([event]) => event === 'task:failed')

      expect(failedCall).toBeDefined()
      expect((failedCall![1] as { error: { message: string } }).error.message).toMatch(/timed out/)
    })
  })

  // -------------------------------------------------------------------------
  // task:ready integration
  // -------------------------------------------------------------------------

  describe('worktree:created event integration', () => {
    it('subscribes to worktree:created on initialize()', async () => {
      const eventBus = createMockEventBus()
      const engine = createMockEngine()
      const db = createMockDb()
      const registry = createMockAdapterRegistry()

      const manager = new WorkerPoolManagerImpl(eventBus, registry, engine, db)
      await manager.initialize()

      expect(eventBus.on).toHaveBeenCalledWith('worktree:created', expect.any(Function))
    })

    it('emits task:failed when adapter not found for task agent', async () => {
      const task = createMockTask({ agent: 'unknown-agent' })
      const eventBus = createMockEventBus()
      const engine = createMockEngine()
      // DB returns the task
      const db = createMockDb(task)
      // Registry returns undefined (no adapter)
      const registry = createMockAdapterRegistry(undefined)

      const manager = new WorkerPoolManagerImpl(eventBus, registry, engine, db)
      await manager.initialize()

      // Manually invoke the worktree:created listener via the eventBus.on mock
      const onMock = eventBus.on as ReturnType<typeof vi.fn>
      const worktreeCreatedCall = onMock.mock.calls.find(([event]: [string]) => event === 'worktree:created') as [string, (payload: { taskId: string; worktreePath: string; branchName: string }) => void] | undefined
      expect(worktreeCreatedCall).toBeDefined()
      worktreeCreatedCall![1]({ taskId: 'task-1', worktreePath: '/tmp/worktree/task-1', branchName: 'substrate/task-task-1' })

      const emitMock = eventBus.emit as ReturnType<typeof vi.fn>
      const calls = emitMock.mock.calls as Array<[string, unknown]>
      const failedCall = calls.find(([event]) => event === 'task:failed')

      expect(failedCall).toBeDefined()
      expect((failedCall![1] as { error: { code: string } }).error.code).toBe('ADAPTER_NOT_FOUND')
    })

    it('emits task:failed when task has no agent', async () => {
      const task = createMockTask({ agent: null })
      const eventBus = createMockEventBus()
      const engine = createMockEngine()
      const db = createMockDb(task)
      const registry = createMockAdapterRegistry()

      const manager = new WorkerPoolManagerImpl(eventBus, registry, engine, db)
      await manager.initialize()

      const onMock = eventBus.on as ReturnType<typeof vi.fn>
      const worktreeCreatedCall = onMock.mock.calls.find(([event]: [string]) => event === 'worktree:created') as [string, (payload: { taskId: string; worktreePath: string; branchName: string }) => void] | undefined
      expect(worktreeCreatedCall).toBeDefined()
      worktreeCreatedCall![1]({ taskId: 'task-1', worktreePath: '/tmp/worktree/task-1', branchName: 'substrate/task-task-1' })

      const emitMock = eventBus.emit as ReturnType<typeof vi.fn>
      const calls = emitMock.mock.calls as Array<[string, unknown]>
      const failedCall = calls.find(([event]) => event === 'task:failed')

      expect(failedCall).toBeDefined()
      expect((failedCall![1] as { error: { code: string } }).error.code).toBe('NO_AGENT')
    })

    it('logs warning and skips when task not found in DB', async () => {
      const eventBus = createMockEventBus()
      const engine = createMockEngine()
      // DB returns undefined (task not found)
      const db = createMockDb(undefined)
      const registry = createMockAdapterRegistry()

      const manager = new WorkerPoolManagerImpl(eventBus, registry, engine, db)
      await manager.initialize()

      const onMock = eventBus.on as ReturnType<typeof vi.fn>
      const worktreeCreatedCall = onMock.mock.calls.find(([event]: [string]) => event === 'worktree:created') as [string, (payload: { taskId: string; worktreePath: string; branchName: string }) => void] | undefined
      expect(worktreeCreatedCall).toBeDefined()

      // Should not throw
      expect(() => worktreeCreatedCall![1]({ taskId: 'nonexistent', worktreePath: '/tmp/worktree/nonexistent', branchName: 'substrate/task-nonexistent' })).not.toThrow()

      // Should not emit task:failed for this case (just log warning and skip)
      const emitMock = eventBus.emit as ReturnType<typeof vi.fn>
      const calls = emitMock.mock.calls as Array<[string, unknown]>
      const failedCall = calls.find(([event]) => event === 'task:failed')
      expect(failedCall).toBeUndefined()
    })

    it('unsubscribes from worktree:created on shutdown()', async () => {
      const eventBus = createMockEventBus()
      const engine = createMockEngine()
      const db = createMockDb()
      const registry = createMockAdapterRegistry()

      const manager = new WorkerPoolManagerImpl(eventBus, registry, engine, db)
      await manager.initialize()
      await manager.shutdown()

      expect(eventBus.off).toHaveBeenCalledWith('worktree:created', expect.any(Function))
    })
  })

  // -------------------------------------------------------------------------
  // terminateWorker
  // -------------------------------------------------------------------------

  describe('terminateWorker()', () => {
    it('sends SIGTERM and emits worker:terminated for the specified worker', () => {
      const task = createMockTask()
      const adapter = createMockAdapter()
      const eventBus = createMockEventBus()
      const engine = createMockEngine()
      const db = createMockDb(task)
      const registry = createMockAdapterRegistry(adapter)

      const manager = new WorkerPoolManagerImpl(eventBus, registry, engine, db)
      const handle = manager.spawnWorker(task, adapter, process.cwd())

      manager.terminateWorker(handle.workerId, 'test-reason')

      expect(manager.getWorkerCount()).toBe(0)

      const emitMock = eventBus.emit as ReturnType<typeof vi.fn>
      const calls = emitMock.mock.calls as Array<[string, unknown]>
      const terminatedCall = calls.find(([event]) => event === 'worker:terminated')
      expect(terminatedCall).toBeDefined()
      expect(terminatedCall![1]).toMatchObject({ workerId: handle.workerId, reason: 'test-reason' })
    })

    it('does NOT emit task:failed when process closes after terminateWorker', () => {
      // When terminateWorker sends SIGTERM and the process closes, the _terminated
      // flag should prevent the onError callback from emitting task:failed
      const task = createMockTask()
      const adapter = createMockAdapter()
      const eventBus = createMockEventBus()
      const engine = createMockEngine()
      const db = createMockDb(task)
      const registry = createMockAdapterRegistry(adapter)

      const manager = new WorkerPoolManagerImpl(eventBus, registry, engine, db)
      const handle = manager.spawnWorker(task, adapter, process.cwd())

      manager.terminateWorker(handle.workerId, 'cancelled')

      // Simulate process closing with non-zero exit code (from SIGTERM)
      currentFakeProcess.emitClose(143) // 128 + 15 (SIGTERM)

      const emitMock = eventBus.emit as ReturnType<typeof vi.fn>
      const calls = emitMock.mock.calls as Array<[string, unknown]>
      const failedCalls = calls.filter(([event]) => event === 'task:failed')
      // No spurious task:failed for intentionally terminated workers
      expect(failedCalls).toHaveLength(0)
    })
  })

  // -------------------------------------------------------------------------
  // Terminated flag: no spurious task:failed on terminateAll SIGKILL
  // -------------------------------------------------------------------------

  describe('no spurious task:failed on terminateAll', () => {
    it('does NOT emit task:failed for workers force-killed by terminateAll', async () => {
      const task = createMockTask()
      const adapter = createMockAdapter()
      const eventBus = createMockEventBus()
      const engine = createMockEngine()
      const db = createMockDb(task)
      const registry = createMockAdapterRegistry(adapter)

      const manager = new WorkerPoolManagerImpl(eventBus, registry, engine, db)
      manager.spawnWorker(task, adapter, process.cwd())

      vi.useFakeTimers()
      const terminatePromise = manager.terminateAll()
      vi.advanceTimersByTime(5_000)
      await terminatePromise
      vi.useRealTimers()

      // The fake process emits close(1) when SIGKILL is called
      // but _terminated flag should prevent onError from firing task:failed
      const emitMock = eventBus.emit as ReturnType<typeof vi.fn>
      const calls = emitMock.mock.calls as Array<[string, unknown]>
      const failedCalls = calls.filter(([event]) => event === 'task:failed')
      expect(failedCalls).toHaveLength(0)
    })
  })

  // -------------------------------------------------------------------------
  // H1 Fix: maxConcurrency enforcement
  // -------------------------------------------------------------------------

  describe('maxConcurrency enforcement (H1 fix)', () => {
    it('rejects spawn when at max concurrency after config:reloaded', async () => {
      const eventBus = createMockEventBus()
      const engine = createMockEngine()
      const adapter = createMockAdapter()
      const db = createMockDb(createMockTask())
      const registry = createMockAdapterRegistry(adapter)

      const manager = new WorkerPoolManagerImpl(eventBus, registry, engine, db)
      await manager.initialize()

      // Set maxConcurrency to 1 via config:reloaded event
      const onCalls = (eventBus.on as ReturnType<typeof vi.fn>).mock.calls as Array<[string, (payload: unknown) => void]>
      const configHandler = onCalls.find(([event]) => event === 'config:reloaded')![1]
      configHandler({
        newConfig: { global: { max_concurrent_tasks: 1 } },
        changedKeys: ['global.max_concurrent_tasks'],
      })

      // First spawn succeeds
      const task1 = createMockTask({ id: 'task-max-1' })
      manager.spawnWorker(task1, adapter, '/tmp/wt')
      expect(manager.getWorkerCount()).toBe(1)

      // Second spawn should throw
      const task2 = createMockTask({ id: 'task-max-2' })
      expect(() => manager.spawnWorker(task2, adapter, '/tmp/wt2')).toThrow('Worker pool at max concurrency (1)')

      // Verify task:failed event was emitted for the rejected task
      const emitMock = eventBus.emit as ReturnType<typeof vi.fn>
      const calls = emitMock.mock.calls as Array<[string, unknown]>
      const failedCall = calls.find(([event, payload]) =>
        event === 'task:failed' && (payload as { taskId: string }).taskId === 'task-max-2',
      )
      expect(failedCall).toBeDefined()
      expect((failedCall![1] as { error: { code: string } }).error.code).toBe('MAX_CONCURRENCY')
    })

    it('allows spawn when maxConcurrency is null (default)', () => {
      const eventBus = createMockEventBus()
      const engine = createMockEngine()
      const adapter = createMockAdapter()
      const db = createMockDb(createMockTask())
      const registry = createMockAdapterRegistry(adapter)

      const manager = new WorkerPoolManagerImpl(eventBus, registry, engine, db)

      // Without config:reloaded, _maxConcurrency is null — no limit
      const task1 = createMockTask({ id: 'task-unlim-1' })
      const task2 = createMockTask({ id: 'task-unlim-2' })

      // Need separate fake processes for concurrent spawns
      manager.spawnWorker(task1, adapter, '/tmp/wt1')
      currentFakeProcess = createFakeProcess() // new process for second spawn
      manager.spawnWorker(task2, adapter, '/tmp/wt2')

      expect(manager.getWorkerCount()).toBe(2)
    })
  })
})
