/**
 * Unit tests for `src/cli/commands/resume.ts`
 *
 * Covers Acceptance Criteria:
 *   AC7: No interrupted session → stdout "No interrupted session found", exit 0
 *   AC5: Interrupted session found → "Resuming interrupted session <id>",
 *        recover() called, startExecution() called
 *   AC5: graph:complete fires → exit 0 returned
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// ---------------------------------------------------------------------------
// Fake event bus factory — shared mutable reference
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
    off: vi.fn((event: string, handler: Handler) => {
      const list = handlers.get(event) ?? []
      const idx = list.indexOf(handler)
      if (idx !== -1) list.splice(idx, 1)
    }),
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
// Fake TaskGraphEngine factory
// ---------------------------------------------------------------------------

const _mockLoadGraph = vi.fn()
const _mockStartExecution = vi.fn()
const _mockGetAllTasks = vi.fn()
const _mockGetReadyTasks = vi.fn()
const _mockCancelAll = vi.fn()
const _mockTgeInitialize = vi.fn()
const _mockTgeShutdown = vi.fn()
const _mockTgePause = vi.fn()

// ---------------------------------------------------------------------------
// Fake DatabaseService factory
// ---------------------------------------------------------------------------

const _mockDbInitialize = vi.fn()
const _mockDbShutdown = vi.fn()

// ---------------------------------------------------------------------------
// Fake config system factory
// ---------------------------------------------------------------------------

const _mockConfigLoad = vi.fn()
const _mockConfigGetConfig = vi.fn()

// ---------------------------------------------------------------------------
// Fake routing engine factory
// ---------------------------------------------------------------------------

const _mockRoutingInitialize = vi.fn()
const _mockRoutingShutdown = vi.fn()

// ---------------------------------------------------------------------------
// Fake worker pool manager factory
// ---------------------------------------------------------------------------

const _mockWpmInitialize = vi.fn()
const _mockWpmShutdown = vi.fn()
const _mockWpmTerminateAll = vi.fn()

// ---------------------------------------------------------------------------
// Fake git worktree manager factory
// ---------------------------------------------------------------------------

const _mockGwmInitialize = vi.fn()
const _mockGwmShutdown = vi.fn()

// ---------------------------------------------------------------------------
// CrashRecoveryManager mock — findInterruptedSession controls the key path
// ---------------------------------------------------------------------------

const _mockFindInterruptedSession = vi.fn()
const _mockRecover = vi.fn()
const _mockArchiveSession = vi.fn()

// ---------------------------------------------------------------------------
// Module mocks — MUST be declared before any imports that use them
// ---------------------------------------------------------------------------

vi.mock('../../../core/event-bus.js', () => ({
  createEventBus: () => makeFakeBus(),
}))

vi.mock('../../../modules/database/database-service.js', () => ({
  createDatabaseService: () => ({
    initialize: _mockDbInitialize,
    shutdown: _mockDbShutdown,
    get db() { return { prepare: vi.fn(() => ({ get: vi.fn(), run: vi.fn() })), pragma: vi.fn() } },
  }),
}))

vi.mock('../../../modules/task-graph/task-graph-engine.js', () => ({
  createTaskGraphEngine: () => ({
    initialize: _mockTgeInitialize,
    shutdown: _mockTgeShutdown,
    loadGraph: _mockLoadGraph,
    startExecution: _mockStartExecution,
    getAllTasks: _mockGetAllTasks,
    getReadyTasks: _mockGetReadyTasks,
    cancelAll: _mockCancelAll,
    pause: _mockTgePause,
    state: 'Idle',
  }),
}))

vi.mock('../../../modules/routing/routing-engine.js', () => ({
  createRoutingEngine: () => ({
    initialize: _mockRoutingInitialize,
    shutdown: _mockRoutingShutdown,
    setMonitorAgent: vi.fn(),
  }),
}))

vi.mock('../../../persistence/monitor-database.js', () => ({
  createMonitorDatabase: () => ({
    close: vi.fn(),
  }),
}))

vi.mock('../../../modules/monitor/monitor-agent-impl.js', () => ({
  createMonitorAgent: () => ({
    initialize: vi.fn(async () => {}),
    shutdown: vi.fn(async () => {}),
  }),
}))

vi.mock('../../../modules/worker-pool/worker-pool-manager-impl.js', () => ({
  createWorkerPoolManager: () => ({
    initialize: _mockWpmInitialize,
    shutdown: _mockWpmShutdown,
    terminateAll: _mockWpmTerminateAll,
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

vi.mock('../../../cli/formatters/streaming.js', () => ({
  emitEvent: vi.fn(),
}))

vi.mock('../../../utils/logger.js', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}))

vi.mock('fs', () => ({
  existsSync: vi.fn().mockReturnValue(true),
  mkdirSync: vi.fn(),
  watch: vi.fn(() => ({
    on: vi.fn(),
    close: vi.fn(),
  })),
}))

vi.mock('../../../recovery/crash-recovery.js', () => ({
  CrashRecoveryManager: class MockCrashRecoveryManager {
    recover(...args: unknown[]) { return _mockRecover(...args) }
    static findInterruptedSession(...args: unknown[]) { return _mockFindInterruptedSession(...args) }
    static archiveSession(...args: unknown[]) { return _mockArchiveSession(...args) }
  },
}))

vi.mock('../../../recovery/shutdown-handler.js', () => ({
  setupGracefulShutdown: vi.fn(({ taskGraphEngine }: { taskGraphEngine: { cancelAll: () => void } }) => {
    const sigintHandler = (): void => { taskGraphEngine.cancelAll() }
    const sigtermHandler = (): void => { taskGraphEngine.cancelAll() }
    process.on('SIGINT', sigintHandler)
    process.on('SIGTERM', sigtermHandler)
    return (): void => {
      process.removeListener('SIGINT', sigintHandler)
      process.removeListener('SIGTERM', sigtermHandler)
    }
  }),
}))

vi.mock('../../../modules/task-graph/task-parser.js', () => {
  class ParseError extends Error {
    public readonly filePath?: string
    constructor(message: string) {
      super(message)
      this.name = 'ParseError'
    }
  }
  return { ParseError, parseGraphFile: vi.fn() }
})

vi.mock('../../../modules/task-graph/task-validator.js', () => {
  class ValidationError extends Error {
    public readonly errors: string[]
    constructor(errors: string[]) {
      super(errors.join('\n'))
      this.name = 'ValidationError'
      this.errors = errors
    }
  }
  return { ValidationError, validateGraph: vi.fn() }
})

vi.mock('../../../modules/config/config-watcher.js', () => ({
  createConfigWatcher: vi.fn(() => ({
    start: vi.fn(),
    stop: vi.fn(),
  })),
  computeChangedKeys: vi.fn(() => []),
}))

// ---------------------------------------------------------------------------
// Imports — after all vi.mock() declarations
// ---------------------------------------------------------------------------

import {
  runResumeAction,
  RESUME_EXIT_SUCCESS,
  RESUME_EXIT_ERROR,
  RESUME_EXIT_USAGE_ERROR,
} from '../resume.js'
import type { ResumeActionOptions } from '../resume.js'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PROJECT_ROOT = '/fake/project'

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function defaultOptions(overrides: Partial<ResumeActionOptions> = {}): ResumeActionOptions {
  return {
    outputFormat: 'human',
    projectRoot: PROJECT_ROOT,
    version: '1.0.0',
    noWatchConfig: true,
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

/** Fire graph:complete via setImmediate to resolve the done-promise. */
function scheduleGraphComplete(opts: {
  totalTasks?: number
  completedTasks?: number
  failedTasks?: number
  totalCostUsd?: number
} = {}): void {
  const payload = {
    totalTasks: opts.totalTasks ?? 2,
    completedTasks: opts.completedTasks ?? 2,
    failedTasks: opts.failedTasks ?? 0,
    totalCostUsd: opts.totalCostUsd ?? 0.05,
  }
  setImmediate(() => {
    if (_capturedBus) _capturedBus._fire('graph:complete', payload)
  })
}

// ---------------------------------------------------------------------------
// Setup / Teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  captureOutput()
  _capturedBus = null

  // All module mocks return defaults
  _mockDbInitialize.mockResolvedValue(undefined)
  _mockDbShutdown.mockResolvedValue(undefined)
  _mockTgeInitialize.mockResolvedValue(undefined)
  _mockTgeShutdown.mockResolvedValue(undefined)
  _mockTgePause.mockReturnValue(undefined)
  _mockRoutingInitialize.mockResolvedValue(undefined)
  _mockRoutingShutdown.mockResolvedValue(undefined)
  _mockWpmInitialize.mockResolvedValue(undefined)
  _mockWpmShutdown.mockResolvedValue(undefined)
  _mockWpmTerminateAll.mockResolvedValue(undefined)
  _mockGwmInitialize.mockResolvedValue(undefined)
  _mockGwmShutdown.mockResolvedValue(undefined)
  _mockConfigLoad.mockResolvedValue(undefined)
  _mockConfigGetConfig.mockReturnValue({ global: { max_concurrent_workers: 4 } })
  _mockStartExecution.mockReturnValue(undefined)
  _mockCancelAll.mockReturnValue(undefined)
  _mockRecover.mockReturnValue({ recovered: 1, failed: 0, newlyReady: 1, actions: [] })

  // Default: no interrupted session found
  _mockFindInterruptedSession.mockReturnValue(undefined)
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.clearAllMocks()
})

// ---------------------------------------------------------------------------
// Exit code constants
// ---------------------------------------------------------------------------

describe('exit code constants', () => {
  it('RESUME_EXIT_SUCCESS is 0', () => { expect(RESUME_EXIT_SUCCESS).toBe(0) })
  it('RESUME_EXIT_ERROR is 1', () => { expect(RESUME_EXIT_ERROR).toBe(1) })
  it('RESUME_EXIT_USAGE_ERROR is 2', () => { expect(RESUME_EXIT_USAGE_ERROR).toBe(2) })
})

// ---------------------------------------------------------------------------
// AC7: No interrupted session found
// ---------------------------------------------------------------------------

describe('AC7: no interrupted session found', () => {
  it('returns exit code 0 when no interrupted session exists', async () => {
    _mockFindInterruptedSession.mockReturnValue(undefined)

    const exitCode = await runResumeAction(defaultOptions())

    expect(exitCode).toBe(RESUME_EXIT_SUCCESS)
  })

  it('prints "No interrupted session found" to stdout', async () => {
    _mockFindInterruptedSession.mockReturnValue(undefined)

    await runResumeAction(defaultOptions())

    expect(getStdout()).toContain('No interrupted session found')
  })

  it('writes nothing to stderr when no interrupted session', async () => {
    _mockFindInterruptedSession.mockReturnValue(undefined)

    await runResumeAction(defaultOptions())

    expect(getStderr()).toBe('')
  })

  it('does NOT call recover() when no interrupted session found', async () => {
    _mockFindInterruptedSession.mockReturnValue(undefined)

    await runResumeAction(defaultOptions())

    expect(_mockRecover).not.toHaveBeenCalled()
  })

  it('does NOT call startExecution() when no interrupted session found', async () => {
    _mockFindInterruptedSession.mockReturnValue(undefined)

    await runResumeAction(defaultOptions())

    expect(_mockStartExecution).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// AC5: Interrupted session found — recover and resume
// ---------------------------------------------------------------------------

describe('AC5: interrupted session found → recover and resume', () => {
  const INTERRUPTED_SESSION_ID = 'sess-interrupted-abc'

  beforeEach(() => {
    _mockFindInterruptedSession.mockReturnValue({
      id: INTERRUPTED_SESSION_ID,
      status: 'interrupted',
      created_at: '2026-01-01T00:00:00Z',
    })
  })

  it('logs "Resuming interrupted session <id>" to stdout', async () => {
    scheduleGraphComplete()

    await runResumeAction(defaultOptions())

    expect(getStdout()).toContain(`Resuming interrupted session ${INTERRUPTED_SESSION_ID}`)
  })

  it('calls CrashRecoveryManager.recover() with the interrupted session ID', async () => {
    scheduleGraphComplete()

    await runResumeAction(defaultOptions())

    expect(_mockRecover).toHaveBeenCalledWith(INTERRUPTED_SESSION_ID)
  })

  it('calls startExecution() with the interrupted session ID', async () => {
    scheduleGraphComplete()

    await runResumeAction(defaultOptions())

    expect(_mockStartExecution).toHaveBeenCalledWith(INTERRUPTED_SESSION_ID, expect.any(Number))
  })

  it('returns exit code 0 when graph:complete fires', async () => {
    scheduleGraphComplete({ totalTasks: 2, completedTasks: 2, failedTasks: 0, totalCostUsd: 0.10 })

    const exitCode = await runResumeAction(defaultOptions())

    expect(exitCode).toBe(RESUME_EXIT_SUCCESS)
  })

  it('calls CrashRecoveryManager.findInterruptedSession()', async () => {
    scheduleGraphComplete()

    await runResumeAction(defaultOptions())

    expect(_mockFindInterruptedSession).toHaveBeenCalled()
  })

  it('passes maxConcurrency option to startExecution', async () => {
    scheduleGraphComplete()

    await runResumeAction(defaultOptions({ maxConcurrency: 3 }))

    expect(_mockStartExecution).toHaveBeenCalledWith(INTERRUPTED_SESSION_ID, 3)
  })

  it('does NOT call loadGraph (existing session, no new graph)', async () => {
    scheduleGraphComplete()

    await runResumeAction(defaultOptions())

    expect(_mockLoadGraph).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// Multiple interrupted sessions — most-recent is resumed
// ---------------------------------------------------------------------------

describe('AC7: multiple interrupted sessions — most-recent resumed', () => {
  it('uses the session returned by findInterruptedSession (most-recent by created_at DESC)', async () => {
    // findInterruptedSession already does ORDER BY created_at DESC LIMIT 1 in SQL;
    // we verify that resume uses whichever session it returns
    const mostRecentSession = { id: 'sess-newer', status: 'interrupted', created_at: '2026-02-01T00:00:00Z' }
    _mockFindInterruptedSession.mockReturnValue(mostRecentSession)

    scheduleGraphComplete()
    await runResumeAction(defaultOptions())

    expect(_mockRecover).toHaveBeenCalledWith('sess-newer')
    expect(_mockStartExecution).toHaveBeenCalledWith('sess-newer', expect.any(Number))
  })
})

// ---------------------------------------------------------------------------
// System error handling
// ---------------------------------------------------------------------------

describe('system error handling', () => {
  it('returns exit code 1 when database initialization throws', async () => {
    _mockDbInitialize.mockRejectedValue(new Error('disk full'))

    const exitCode = await runResumeAction(defaultOptions())

    expect(exitCode).toBe(RESUME_EXIT_ERROR)
  })

  it('writes system error to stderr when initialization fails', async () => {
    _mockDbInitialize.mockRejectedValue(new Error('disk full'))

    await runResumeAction(defaultOptions())

    expect(getStderr()).toContain('disk full')
  })
})
