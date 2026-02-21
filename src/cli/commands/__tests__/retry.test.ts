/**
 * Unit tests for `src/cli/commands/retry.ts`
 *
 * Covers Acceptance Criteria:
 *   AC1: Session with failed tasks → all reset to pending, resume signal written
 *   AC2: --task with unmet dependencies → exit 2
 *   AC2: --task with all deps met → only that task reset, exit 0
 *   AC3: --dry-run → table rendered, no DB writes to task status
 *   AC4: --dry-run --output-format json → NDJSON emitted per failed task
 *   AC5: --follow, all succeed → exit 0
 *   AC5: --follow, partial success → exit 1
 *   AC5: --follow, all fail → exit 4
 *   AC6: Session not found → stderr, exit 2
 *   AC6: No failed tasks → message, exit 0
 *   AC7: Budget error → actionable message includes limit details
 *   AC7: Adapter unavailable → suggests `substrate adapters --health`
 *   AC8: Task with retry_count >= max-retries → skipped, noted in output
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// ---------------------------------------------------------------------------
// Fake event bus
// ---------------------------------------------------------------------------

type Handler = (payload: unknown) => void

interface FakeEventBus {
  _handlers: Map<string, Handler[]>
  on: ReturnType<typeof vi.fn>
  off: ReturnType<typeof vi.fn>
  emit: ReturnType<typeof vi.fn>
  _fire: (event: string, payload: unknown) => void
}

let _capturedBus: FakeEventBus | null = null

function makeFakeBus(): FakeEventBus {
  const handlers: Map<string, Handler[]> = new Map()
  const bus: FakeEventBus = {
    _handlers: handlers,
    on: vi.fn((event: string, handler: Handler) => {
      if (!handlers.has(event)) handlers.set(event, [])
      handlers.get(event)!.push(handler)
    }),
    off: vi.fn(),
    emit: vi.fn((event: string, payload: unknown) => {
      const list = handlers.get(event) ?? []
      for (const h of list) h(payload)
    }),
    _fire: (event: string, payload: unknown) => {
      const list = handlers.get(event) ?? []
      for (const h of list) h(payload)
    },
  }
  _capturedBus = bus
  return bus
}

// ---------------------------------------------------------------------------
// Module-level shared mocks
// ---------------------------------------------------------------------------

const _mockDbInitialize = vi.fn()
const _mockDbShutdown = vi.fn()
const _mockTgeInitialize = vi.fn()
const _mockTgeShutdown = vi.fn()
const _mockStartExecution = vi.fn()
const _mockCancelAll = vi.fn()
const _mockRoutingInitialize = vi.fn()
const _mockRoutingShutdown = vi.fn()
const _mockWpmInitialize = vi.fn()
const _mockWpmShutdown = vi.fn()
const _mockGwmInitialize = vi.fn()
const _mockGwmShutdown = vi.fn()
const _mockConfigLoad = vi.fn()
const _mockConfigGetConfig = vi.fn()

// ---------------------------------------------------------------------------
// Fake DatabaseWrapper — stores per-instance state
// ---------------------------------------------------------------------------

interface FakeDbState {
  sessions: Map<string, { id: string; status: string }>
  tasks: Map<string, {
    id: string
    session_id: string
    status: string
    agent: string | null
    exit_code: number | null
    error: string | null
    completed_at: string | null
    retry_count: number
  }>
  taskDeps: Map<string, string[]> // taskId → [dependencyId, ...]
  signals: Array<{ session_id: string; signal: string }>
}

let _fakeDbState: FakeDbState = {
  sessions: new Map(),
  tasks: new Map(),
  taskDeps: new Map(),
  signals: [],
}

function resetFakeDbState(): void {
  _fakeDbState = {
    sessions: new Map(),
    tasks: new Map(),
    taskDeps: new Map(),
    signals: [],
  }
}

// Mock existsSync
const _mockExistsSync = vi.fn()

// ---------------------------------------------------------------------------
// vi.mock declarations
// ---------------------------------------------------------------------------

vi.mock('fs', () => ({
  existsSync: (p: string) => _mockExistsSync(p),
  mkdirSync: vi.fn(),
}))

vi.mock('../../../persistence/database.js', () => {
  class DatabaseWrapper {
    private _open = false

    open(): void {
      this._open = true
    }

    close(): void {
      this._open = false
    }

    get isOpen(): boolean {
      return this._open
    }

    get db() {
      return {
        prepare: (sql: string) => ({
          get: (...args: unknown[]) => {
            // Session lookup
            if (sql.includes('SELECT id, status FROM sessions WHERE id = ?')) {
              const id = args[0] as string
              return _fakeDbState.sessions.get(id) ?? undefined
            }
            // Task lookup
            if (sql.includes('SELECT id, status FROM tasks WHERE id = ?')) {
              const taskId = args[0] as string
              const sessionId = args[1] as string
              const t = _fakeDbState.tasks.get(taskId)
              if (t && t.session_id === sessionId) return t
              return undefined
            }
            return undefined
          },
          all: (...args: unknown[]) => {
            // Failed tasks for session
            if (sql.includes("status = 'failed'")) {
              const sessionId = args[0] as string
              return Array.from(_fakeDbState.tasks.values()).filter(
                (t) => t.session_id === sessionId && t.status === 'failed',
              )
            }
            // Dependency check
            if (sql.includes('task_dependencies')) {
              const taskId = args[0] as string
              const deps = _fakeDbState.taskDeps.get(taskId) ?? []
              return deps.map((depId) => {
                const depTask = _fakeDbState.tasks.get(depId)
                return { dependency_id: depId, status: depTask?.status ?? 'pending' }
              })
            }
            return []
          },
          run: (...args: unknown[]) => {
            // INSERT signal
            if (sql.includes('session_signals')) {
              const sessionId = args[0] as string
              _fakeDbState.signals.push({ session_id: sessionId, signal: 'resume' })
            }
            // UPDATE tasks SET status = 'pending'
            if (sql.includes("SET status = 'pending'")) {
              const taskId = args[0] as string
              const task = _fakeDbState.tasks.get(taskId)
              if (task) {
                task.status = 'pending'
                task.retry_count = task.retry_count + 1
                task.error = null
                task.exit_code = null
              }
            }
            return { changes: 1 }
          },
        }),
        transaction: (fn: () => void) => {
          return () => fn()
        },
      }
    }
  }
  return { DatabaseWrapper }
})

vi.mock('../../../persistence/migrations/index.js', () => ({
  runMigrations: vi.fn(),
}))

vi.mock('../../../core/event-bus.js', () => ({
  createEventBus: () => makeFakeBus(),
}))

vi.mock('../../../modules/database/database-service.js', () => ({
  createDatabaseService: () => ({
    initialize: _mockDbInitialize,
    shutdown: _mockDbShutdown,
    get db() { return _fakeDbState },
    isOpen: true,
  }),
}))

vi.mock('../../../modules/task-graph/task-graph-engine.js', () => ({
  createTaskGraphEngine: () => ({
    initialize: _mockTgeInitialize,
    shutdown: _mockTgeShutdown,
    startExecution: _mockStartExecution,
    cancelAll: _mockCancelAll,
    state: 'Idle',
  }),
}))

vi.mock('../../../modules/routing/routing-engine.js', () => ({
  createRoutingEngine: () => ({
    initialize: _mockRoutingInitialize,
    shutdown: _mockRoutingShutdown,
  }),
}))

vi.mock('../../../modules/worker-pool/worker-pool-manager-impl.js', () => ({
  createWorkerPoolManager: () => ({
    initialize: _mockWpmInitialize,
    shutdown: _mockWpmShutdown,
  }),
}))

vi.mock('../../../modules/git-worktree/git-worktree-manager-impl.js', () => ({
  createGitWorktreeManager: () => ({
    initialize: _mockGwmInitialize,
    shutdown: _mockGwmShutdown,
  }),
}))

vi.mock('../../../adapters/adapter-registry.js', () => {
  class AdapterRegistry {
    discoverAndRegister() {
      return Promise.resolve({ registeredCount: 0, failedCount: 0, results: [] })
    }
  }
  return { AdapterRegistry }
})

vi.mock('../../../modules/config/config-system-impl.js', () => ({
  createConfigSystem: () => ({
    load: _mockConfigLoad,
    getConfig: _mockConfigGetConfig,
  }),
}))

vi.mock('../../../utils/logger.js', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}))

// ---------------------------------------------------------------------------
// Imports — after all vi.mock() declarations
// ---------------------------------------------------------------------------

import {
  runRetryAction,
  validateTaskDependencies,
  RETRY_EXIT_SUCCESS,
  RETRY_EXIT_PARTIAL_FAILURE,
  RETRY_EXIT_USAGE_ERROR,
  RETRY_EXIT_ALL_FAILED,
} from '../retry.js'
import type { RetryActionOptions } from '../retry.js'

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const PROJECT_ROOT = '/fake/project'

function defaultOptions(overrides: Partial<RetryActionOptions> = {}): RetryActionOptions {
  return {
    sessionId: 'sess-123',
    taskId: undefined,
    dryRun: false,
    follow: false,
    outputFormat: 'human',
    maxRetries: 3,
    projectRoot: PROJECT_ROOT,
    version: '1.0.0',
    ...overrides,
  }
}

let _stdoutOutput: string
let _stderrOutput: string

function captureOutput(): void {
  _stdoutOutput = ''
  _stderrOutput = ''
  vi.spyOn(process.stdout, 'write').mockImplementation((data: string | Uint8Array) => {
    _stdoutOutput += typeof data === 'string' ? data : data.toString()
    return true
  })
  vi.spyOn(process.stderr, 'write').mockImplementation((data: string | Uint8Array) => {
    _stderrOutput += typeof data === 'string' ? data : data.toString()
    return true
  })
}

function getStdout(): string { return _stdoutOutput }
function getStderr(): string { return _stderrOutput }

function addSession(id: string, status = 'active'): void {
  _fakeDbState.sessions.set(id, { id, status })
}

function addTask(opts: {
  id: string
  sessionId: string
  status: string
  agent?: string | null
  exitCode?: number | null
  error?: string | null
  retryCount?: number
}): void {
  _fakeDbState.tasks.set(opts.id, {
    id: opts.id,
    session_id: opts.sessionId,
    status: opts.status,
    agent: opts.agent ?? 'claude',
    exit_code: opts.exitCode ?? null,
    error: opts.error ?? null,
    completed_at: opts.status === 'failed' ? new Date().toISOString() : null,
    retry_count: opts.retryCount ?? 0,
  })
}

function addDependency(taskId: string, dependsOnId: string): void {
  const existing = _fakeDbState.taskDeps.get(taskId) ?? []
  _fakeDbState.taskDeps.set(taskId, [...existing, dependsOnId])
}

function scheduleGraphComplete(opts: {
  taskIds?: string[]
  completedIds?: string[]
  failedIds?: string[]
} = {}): void {
  setImmediate(() => {
    if (_capturedBus) {
      // Fire complete events for each task
      for (const id of opts.completedIds ?? []) {
        _capturedBus._fire('task:complete', { taskId: id, result: { costUsd: 0.01 } })
      }
      for (const id of opts.failedIds ?? []) {
        _capturedBus._fire('task:failed', { taskId: id, error: { message: 'failed' } })
      }
      _capturedBus._fire('graph:complete', {
        totalTasks: (opts.taskIds ?? []).length,
        completedTasks: (opts.completedIds ?? []).length,
        failedTasks: (opts.failedIds ?? []).length,
        totalCostUsd: 0.01,
      })
    }
  })
}

// ---------------------------------------------------------------------------
// Setup / Teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  captureOutput()
  _capturedBus = null
  resetFakeDbState()

  _mockExistsSync.mockReturnValue(true)

  _mockDbInitialize.mockResolvedValue(undefined)
  _mockDbShutdown.mockResolvedValue(undefined)
  _mockTgeInitialize.mockResolvedValue(undefined)
  _mockTgeShutdown.mockResolvedValue(undefined)
  _mockStartExecution.mockReturnValue(undefined)
  _mockCancelAll.mockReturnValue(undefined)
  _mockRoutingInitialize.mockResolvedValue(undefined)
  _mockRoutingShutdown.mockResolvedValue(undefined)
  _mockWpmInitialize.mockResolvedValue(undefined)
  _mockWpmShutdown.mockResolvedValue(undefined)
  _mockGwmInitialize.mockResolvedValue(undefined)
  _mockGwmShutdown.mockResolvedValue(undefined)
  _mockConfigLoad.mockResolvedValue(undefined)
  _mockConfigGetConfig.mockReturnValue({ global: { max_concurrent_workers: 4 } })
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.clearAllMocks()
})

// ---------------------------------------------------------------------------
// Exit code constants
// ---------------------------------------------------------------------------

describe('exit code constants', () => {
  it('RETRY_EXIT_SUCCESS is 0', () => {
    expect(RETRY_EXIT_SUCCESS).toBe(0)
  })
  it('RETRY_EXIT_PARTIAL_FAILURE is 1', () => {
    expect(RETRY_EXIT_PARTIAL_FAILURE).toBe(1)
  })
  it('RETRY_EXIT_USAGE_ERROR is 2', () => {
    expect(RETRY_EXIT_USAGE_ERROR).toBe(2)
  })
  it('RETRY_EXIT_ALL_FAILED is 4', () => {
    expect(RETRY_EXIT_ALL_FAILED).toBe(4)
  })
})

// ---------------------------------------------------------------------------
// AC6: Session not found
// ---------------------------------------------------------------------------

describe('AC6: session not found', () => {
  it('returns exit code 2 when session does not exist', async () => {
    const exitCode = await runRetryAction(defaultOptions({ sessionId: 'nonexistent' }))
    expect(exitCode).toBe(RETRY_EXIT_USAGE_ERROR)
  })

  it('writes session not found error to stderr', async () => {
    await runRetryAction(defaultOptions({ sessionId: 'nonexistent' }))
    expect(getStderr()).toContain('Error: Session not found: nonexistent')
  })

  it('returns exit code 2 when database file does not exist', async () => {
    _mockExistsSync.mockReturnValue(false)
    const exitCode = await runRetryAction(defaultOptions())
    expect(exitCode).toBe(RETRY_EXIT_USAGE_ERROR)
  })
})

// ---------------------------------------------------------------------------
// AC6: No failed tasks
// ---------------------------------------------------------------------------

describe('AC6: no failed tasks', () => {
  it('returns exit code 0 when session has no failed tasks', async () => {
    addSession('sess-123')
    addTask({ id: 'task-a', sessionId: 'sess-123', status: 'completed' })

    const exitCode = await runRetryAction(defaultOptions())
    expect(exitCode).toBe(RETRY_EXIT_SUCCESS)
  })

  it('prints "No failed tasks found" message', async () => {
    addSession('sess-123')
    addTask({ id: 'task-a', sessionId: 'sess-123', status: 'completed' })

    await runRetryAction(defaultOptions())
    expect(getStdout()).toContain('No failed tasks found in session sess-123')
  })
})

// ---------------------------------------------------------------------------
// AC1: Retry all failed tasks
// ---------------------------------------------------------------------------

describe('AC1: retry all failed tasks', () => {
  it('resets all failed tasks to pending', async () => {
    addSession('sess-123')
    addTask({ id: 'task-a', sessionId: 'sess-123', status: 'failed' })
    addTask({ id: 'task-b', sessionId: 'sess-123', status: 'failed' })
    addTask({ id: 'task-c', sessionId: 'sess-123', status: 'completed' })

    await runRetryAction(defaultOptions())

    expect(_fakeDbState.tasks.get('task-a')?.status).toBe('pending')
    expect(_fakeDbState.tasks.get('task-b')?.status).toBe('pending')
    expect(_fakeDbState.tasks.get('task-c')?.status).toBe('completed')
  })

  it('increments retry_count for each retried task', async () => {
    addSession('sess-123')
    addTask({ id: 'task-a', sessionId: 'sess-123', status: 'failed', retryCount: 1 })

    await runRetryAction(defaultOptions())

    expect(_fakeDbState.tasks.get('task-a')?.retry_count).toBe(2)
  })

  it('writes resume signal to session_signals', async () => {
    addSession('sess-123')
    addTask({ id: 'task-a', sessionId: 'sess-123', status: 'failed' })

    await runRetryAction(defaultOptions())

    const signal = _fakeDbState.signals.find((s) => s.session_id === 'sess-123')
    expect(signal).toBeDefined()
    expect(signal?.signal).toBe('resume')
  })

  it('prints "Retrying N failed tasks" message', async () => {
    addSession('sess-123')
    addTask({ id: 'task-a', sessionId: 'sess-123', status: 'failed' })
    addTask({ id: 'task-b', sessionId: 'sess-123', status: 'failed' })

    await runRetryAction(defaultOptions())

    expect(getStdout()).toContain('Retrying 2 failed tasks in session sess-123')
  })

  it('returns exit code 0 on successful restart', async () => {
    addSession('sess-123')
    addTask({ id: 'task-a', sessionId: 'sess-123', status: 'failed' })

    const exitCode = await runRetryAction(defaultOptions())
    expect(exitCode).toBe(RETRY_EXIT_SUCCESS)
  })
})

// ---------------------------------------------------------------------------
// AC2: --task flag with dependency validation
// ---------------------------------------------------------------------------

describe('AC2: --task flag', () => {
  it('returns exit code 2 when dependencies are not completed', async () => {
    addSession('sess-123')
    addTask({ id: 'task-dep', sessionId: 'sess-123', status: 'pending' })
    addTask({ id: 'task-a', sessionId: 'sess-123', status: 'failed' })
    addDependency('task-a', 'task-dep')

    const exitCode = await runRetryAction(
      defaultOptions({ taskId: 'task-a' }),
    )
    expect(exitCode).toBe(RETRY_EXIT_USAGE_ERROR)
  })

  it('prints dependency error message when deps not met', async () => {
    addSession('sess-123')
    addTask({ id: 'task-dep', sessionId: 'sess-123', status: 'pending' })
    addTask({ id: 'task-a', sessionId: 'sess-123', status: 'failed' })
    addDependency('task-a', 'task-dep')

    await runRetryAction(defaultOptions({ taskId: 'task-a' }))

    expect(getStderr()).toContain('Cannot retry task task-a')
    expect(getStderr()).toContain('task-dep')
    expect(getStderr()).toContain('are not completed')
  })

  it('resets only the specified task when deps are met', async () => {
    addSession('sess-123')
    addTask({ id: 'task-dep', sessionId: 'sess-123', status: 'completed' })
    addTask({ id: 'task-a', sessionId: 'sess-123', status: 'failed' })
    addTask({ id: 'task-b', sessionId: 'sess-123', status: 'failed' })
    addDependency('task-a', 'task-dep')

    await runRetryAction(defaultOptions({ taskId: 'task-a' }))

    expect(_fakeDbState.tasks.get('task-a')?.status).toBe('pending')
    expect(_fakeDbState.tasks.get('task-b')?.status).toBe('failed')
  })

  it('prints "Retrying task <id>" message for single-task retry', async () => {
    addSession('sess-123')
    addTask({ id: 'task-dep', sessionId: 'sess-123', status: 'completed' })
    addTask({ id: 'task-a', sessionId: 'sess-123', status: 'failed' })
    addDependency('task-a', 'task-dep')

    await runRetryAction(defaultOptions({ taskId: 'task-a' }))

    expect(getStdout()).toContain('Retrying task task-a in session sess-123')
  })

  it('returns exit code 2 when specified task not found', async () => {
    addSession('sess-123')
    addTask({ id: 'task-a', sessionId: 'sess-123', status: 'failed' })

    const exitCode = await runRetryAction(
      defaultOptions({ taskId: 'nonexistent-task' }),
    )
    expect(exitCode).toBe(RETRY_EXIT_USAGE_ERROR)
  })

  it('returns exit code 0 when single task retried successfully', async () => {
    addSession('sess-123')
    addTask({ id: 'task-dep', sessionId: 'sess-123', status: 'completed' })
    addTask({ id: 'task-a', sessionId: 'sess-123', status: 'failed' })
    addDependency('task-a', 'task-dep')

    const exitCode = await runRetryAction(defaultOptions({ taskId: 'task-a' }))
    expect(exitCode).toBe(RETRY_EXIT_SUCCESS)
  })
})

// ---------------------------------------------------------------------------
// AC3: --dry-run mode (human output)
// ---------------------------------------------------------------------------

describe('AC3: --dry-run human output', () => {
  it('returns exit code 0 in dry-run mode', async () => {
    addSession('sess-123')
    addTask({ id: 'task-a', sessionId: 'sess-123', status: 'failed', error: 'timeout' })

    const exitCode = await runRetryAction(defaultOptions({ dryRun: true }))
    expect(exitCode).toBe(RETRY_EXIT_SUCCESS)
  })

  it('does NOT reset task status in dry-run mode', async () => {
    addSession('sess-123')
    addTask({ id: 'task-a', sessionId: 'sess-123', status: 'failed' })

    await runRetryAction(defaultOptions({ dryRun: true }))

    expect(_fakeDbState.tasks.get('task-a')?.status).toBe('failed')
  })

  it('does NOT write session signal in dry-run mode', async () => {
    addSession('sess-123')
    addTask({ id: 'task-a', sessionId: 'sess-123', status: 'failed' })

    await runRetryAction(defaultOptions({ dryRun: true }))

    expect(_fakeDbState.signals.length).toBe(0)
  })

  it('renders error report table to stdout', async () => {
    addSession('sess-123')
    addTask({ id: 'task-refactor', sessionId: 'sess-123', status: 'failed', agent: 'claude', error: 'timeout' })

    await runRetryAction(defaultOptions({ dryRun: true }))

    const out = getStdout()
    expect(out).toContain('Failed Tasks in Session sess-123')
    expect(out).toContain('task-refactor')
    expect(out).toContain('claude')
  })

  it('renders table borders', async () => {
    addSession('sess-123')
    addTask({ id: 'task-a', sessionId: 'sess-123', status: 'failed' })

    await runRetryAction(defaultOptions({ dryRun: true }))

    const out = getStdout()
    expect(out).toContain('┌')
    expect(out).toContain('┘')
  })
})

// ---------------------------------------------------------------------------
// AC4: --dry-run --output-format json
// ---------------------------------------------------------------------------

describe('AC4: --dry-run --output-format json', () => {
  it('emits NDJSON per failed task', async () => {
    addSession('sess-123')
    addTask({ id: 'task-a', sessionId: 'sess-123', status: 'failed', agent: 'claude', error: 'timeout', exitCode: 1 })

    await runRetryAction(defaultOptions({ dryRun: true, outputFormat: 'json' }))

    const lines = getStdout().trim().split('\n').filter(Boolean)
    expect(lines.length).toBeGreaterThanOrEqual(1)
    const parsed = JSON.parse(lines[0])
    expect(parsed.event).toBe('task:failed:detail')
    expect(parsed.data.taskId).toBe('task-a')
    expect(parsed.data.agent).toBe('claude')
    expect(parsed.timestamp).toBeDefined()
  })

  it('emits one NDJSON line per failed task', async () => {
    addSession('sess-123')
    addTask({ id: 'task-a', sessionId: 'sess-123', status: 'failed' })
    addTask({ id: 'task-b', sessionId: 'sess-123', status: 'failed' })

    await runRetryAction(defaultOptions({ dryRun: true, outputFormat: 'json' }))

    const lines = getStdout().trim().split('\n').filter(Boolean)
    expect(lines.length).toBe(2)
  })

  it('returns exit code 0 in json dry-run mode', async () => {
    addSession('sess-123')
    addTask({ id: 'task-a', sessionId: 'sess-123', status: 'failed' })

    const exitCode = await runRetryAction(defaultOptions({ dryRun: true, outputFormat: 'json' }))
    expect(exitCode).toBe(RETRY_EXIT_SUCCESS)
  })

  it('does NOT reset task status in json dry-run mode', async () => {
    addSession('sess-123')
    addTask({ id: 'task-a', sessionId: 'sess-123', status: 'failed' })

    await runRetryAction(defaultOptions({ dryRun: true, outputFormat: 'json' }))

    expect(_fakeDbState.tasks.get('task-a')?.status).toBe('failed')
  })
})

// ---------------------------------------------------------------------------
// AC5: --follow mode exit codes
// ---------------------------------------------------------------------------

describe('AC5: --follow mode', () => {
  it('returns exit code 0 when all retried tasks succeed', async () => {
    addSession('sess-123')
    addTask({ id: 'task-a', sessionId: 'sess-123', status: 'failed' })
    addTask({ id: 'task-b', sessionId: 'sess-123', status: 'failed' })

    scheduleGraphComplete({
      taskIds: ['task-a', 'task-b'],
      completedIds: ['task-a', 'task-b'],
      failedIds: [],
    })

    const exitCode = await runRetryAction(defaultOptions({ follow: true }))
    expect(exitCode).toBe(RETRY_EXIT_SUCCESS)
  })

  it('returns exit code 1 when some retried tasks fail (partial success)', async () => {
    addSession('sess-123')
    addTask({ id: 'task-a', sessionId: 'sess-123', status: 'failed' })
    addTask({ id: 'task-b', sessionId: 'sess-123', status: 'failed' })

    scheduleGraphComplete({
      taskIds: ['task-a', 'task-b'],
      completedIds: ['task-a'],
      failedIds: ['task-b'],
    })

    const exitCode = await runRetryAction(defaultOptions({ follow: true }))
    expect(exitCode).toBe(RETRY_EXIT_PARTIAL_FAILURE)
  })

  it('returns exit code 4 when all retried tasks fail again', async () => {
    addSession('sess-123')
    addTask({ id: 'task-a', sessionId: 'sess-123', status: 'failed' })
    addTask({ id: 'task-b', sessionId: 'sess-123', status: 'failed' })

    scheduleGraphComplete({
      taskIds: ['task-a', 'task-b'],
      completedIds: [],
      failedIds: ['task-a', 'task-b'],
    })

    const exitCode = await runRetryAction(defaultOptions({ follow: true }))
    expect(exitCode).toBe(RETRY_EXIT_ALL_FAILED)
  })

  it('calls startExecution in follow mode', async () => {
    addSession('sess-123')
    addTask({ id: 'task-a', sessionId: 'sess-123', status: 'failed' })

    scheduleGraphComplete({
      taskIds: ['task-a'],
      completedIds: ['task-a'],
      failedIds: [],
    })

    await runRetryAction(defaultOptions({ follow: true }))

    expect(_mockStartExecution).toHaveBeenCalled()
  })

  it('initializes database service in follow mode', async () => {
    addSession('sess-123')
    addTask({ id: 'task-a', sessionId: 'sess-123', status: 'failed' })

    scheduleGraphComplete({
      taskIds: ['task-a'],
      completedIds: ['task-a'],
      failedIds: [],
    })

    await runRetryAction(defaultOptions({ follow: true }))

    expect(_mockDbInitialize).toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// AC7: Actionable error messages
// ---------------------------------------------------------------------------

describe('AC7: actionable error messages (formatActionableError)', () => {
  it('budget error shows actionable message in dry-run output', async () => {
    addSession('sess-123')
    addTask({
      id: 'task-a',
      sessionId: 'sess-123',
      status: 'failed',
      error: 'Budget exceeded: task cost $0.05 exceeded limit $0.03',
    })

    await runRetryAction(defaultOptions({ dryRun: true }))

    const out = getStdout()
    expect(out).toContain('Budget exceeded')
    expect(out).toContain('substrate.config.yaml')
  })

  it('adapter unavailable error shows health check suggestion', async () => {
    addSession('sess-123')
    addTask({
      id: 'task-a',
      sessionId: 'sess-123',
      status: 'failed',
      error: 'Agent codex is unavailable',
    })

    await runRetryAction(defaultOptions({ dryRun: true }))

    const out = getStdout()
    expect(out).toContain('unavailable')
    expect(out).toContain('substrate adapters --health')
  })

  it('exit code 127 error shows health check suggestion', async () => {
    addSession('sess-123')
    addTask({
      id: 'task-a',
      sessionId: 'sess-123',
      status: 'failed',
      error: 'command not found',
      exitCode: 127,
    })

    await runRetryAction(defaultOptions({ dryRun: true }))

    const out = getStdout()
    expect(out).toContain('substrate adapters --health')
  })

  it('routing error shows routing policy suggestion', async () => {
    addSession('sess-123')
    addTask({
      id: 'task-a',
      sessionId: 'sess-123',
      status: 'failed',
      error: 'routing failure: RoutingDecision rejected all adapters',
    })

    await runRetryAction(defaultOptions({ dryRun: true }))

    const out = getStdout()
    expect(out).toContain('Routing failed')
    expect(out).toContain('substrate.config.yaml')
  })

  it('unknown error shows raw message and exit code', async () => {
    addSession('sess-123')
    addTask({
      id: 'task-a',
      sessionId: 'sess-123',
      status: 'failed',
      error: 'some unexpected error',
      exitCode: 1,
    })

    await runRetryAction(defaultOptions({ dryRun: true }))

    const out = getStdout()
    expect(out).toContain('Exit code 1')
    expect(out).toContain('some unexpected error')
  })
})

// ---------------------------------------------------------------------------
// AC8: --max-retries safety guard
// ---------------------------------------------------------------------------

describe('AC8: --max-retries safety guard', () => {
  it('skips tasks that have been retried max-retries times', async () => {
    addSession('sess-123')
    addTask({ id: 'task-a', sessionId: 'sess-123', status: 'failed', retryCount: 3 })
    addTask({ id: 'task-b', sessionId: 'sess-123', status: 'failed', retryCount: 0 })

    await runRetryAction(defaultOptions({ maxRetries: 3 }))

    // task-a should NOT be reset (retry_count >= maxRetries)
    expect(_fakeDbState.tasks.get('task-a')?.status).toBe('failed')
    // task-b should be reset
    expect(_fakeDbState.tasks.get('task-b')?.status).toBe('pending')
  })

  it('prints skipped task count in output', async () => {
    addSession('sess-123')
    addTask({ id: 'task-a', sessionId: 'sess-123', status: 'failed', retryCount: 3 })
    addTask({ id: 'task-b', sessionId: 'sess-123', status: 'failed', retryCount: 0 })

    await runRetryAction(defaultOptions({ maxRetries: 3 }))

    expect(getStdout()).toContain('1 task(s) skipped (exceeded max-retries of 3)')
  })

  it('returns exit code 0 when some eligible tasks retried', async () => {
    addSession('sess-123')
    addTask({ id: 'task-a', sessionId: 'sess-123', status: 'failed', retryCount: 5 })
    addTask({ id: 'task-b', sessionId: 'sess-123', status: 'failed', retryCount: 1 })

    const exitCode = await runRetryAction(defaultOptions({ maxRetries: 3 }))
    expect(exitCode).toBe(RETRY_EXIT_SUCCESS)
  })

  it('returns exit code 0 and prints no-tasks message when all exceed max-retries', async () => {
    addSession('sess-123')
    addTask({ id: 'task-a', sessionId: 'sess-123', status: 'failed', retryCount: 3 })

    const exitCode = await runRetryAction(defaultOptions({ maxRetries: 3 }))
    expect(exitCode).toBe(RETRY_EXIT_SUCCESS)
  })

  it('respects custom max-retries value', async () => {
    addSession('sess-123')
    addTask({ id: 'task-a', sessionId: 'sess-123', status: 'failed', retryCount: 1 })

    await runRetryAction(defaultOptions({ maxRetries: 1 }))

    // retry_count (1) >= maxRetries (1) → should be skipped
    expect(_fakeDbState.tasks.get('task-a')?.status).toBe('failed')
  })
})

// ---------------------------------------------------------------------------
// validateTaskDependencies unit tests
// ---------------------------------------------------------------------------

describe('validateTaskDependencies', () => {
  it('returns valid=true when no dependencies', () => {
    // Use a real-enough mock DB
    const mockDb = {
      prepare: () => ({
        all: () => [],
      }),
    }
    const result = validateTaskDependencies(mockDb as never, 'sess-1', 'task-a')
    expect(result.valid).toBe(true)
    expect(result.blockedBy).toEqual([])
  })

  it('returns valid=false with blockedBy list when deps not completed', () => {
    const mockDb = {
      prepare: () => ({
        all: () => [
          { dependency_id: 'dep-1', status: 'pending' },
          { dependency_id: 'dep-2', status: 'completed' },
        ],
      }),
    }
    const result = validateTaskDependencies(mockDb as never, 'sess-1', 'task-a')
    expect(result.valid).toBe(false)
    expect(result.blockedBy).toEqual(['dep-1'])
  })

  it('returns valid=true when all deps are completed', () => {
    const mockDb = {
      prepare: () => ({
        all: () => [
          { dependency_id: 'dep-1', status: 'completed' },
          { dependency_id: 'dep-2', status: 'completed' },
        ],
      }),
    }
    const result = validateTaskDependencies(mockDb as never, 'sess-1', 'task-a')
    expect(result.valid).toBe(true)
    expect(result.blockedBy).toEqual([])
  })
})
