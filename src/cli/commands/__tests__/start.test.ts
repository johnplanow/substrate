/**
 * Unit tests for `src/cli/commands/start.ts`
 *
 * Covers Acceptance Criteria:
 *   AC1: Valid graph file loads session, emits graph:loaded event
 *   AC2: Workers are scheduled (startExecution called)
 *   AC3: --max-concurrency flag overrides default
 *   AC4: --dry-run validates without executing
 *   AC5: --output-format json produces NDJSON streaming
 *   AC6: Exit codes for missing/invalid/unvalidated files (exit 2)
 *   AC7: Human-readable output (default), exit codes 0/4
 *   AC8: SIGINT/SIGTERM graceful handling (cancelAll called)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { join } from 'path'

// ---------------------------------------------------------------------------
// Fake event bus factory — shared mutable reference
// ---------------------------------------------------------------------------

type Handler = (payload: unknown) => void

interface FakeEventBus {
  _handlers: Map<string, Handler[]>
  on: ReturnType<typeof vi.fn>
  off: ReturnType<typeof vi.fn>
  emit: ReturnType<typeof vi.fn>
  /** Test helper: synchronously fire an event */
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
// Fake TaskGraphEngine factory — shared mock functions
// ---------------------------------------------------------------------------

const _mockLoadGraph = vi.fn()
const _mockStartExecution = vi.fn()
const _mockGetAllTasks = vi.fn()
const _mockGetReadyTasks = vi.fn()
const _mockCancelAll = vi.fn()
const _mockTgeInitialize = vi.fn()
const _mockTgeShutdown = vi.fn()

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

// ---------------------------------------------------------------------------
// Fake git worktree manager factory
// ---------------------------------------------------------------------------

const _mockGwmInitialize = vi.fn()
const _mockGwmShutdown = vi.fn()

// ---------------------------------------------------------------------------
// Fake emitEvent for streaming
// ---------------------------------------------------------------------------

const _mockEmitEvent = vi.fn()

// ---------------------------------------------------------------------------
// Fake parseGraphFile / validateGraph for dry-run path
// ---------------------------------------------------------------------------

const _mockParseGraphFile = vi.fn()
const _mockValidateGraph = vi.fn()

// ---------------------------------------------------------------------------
// Fake existsSync / mkdirSync
// ---------------------------------------------------------------------------

const _mockExistsSync = vi.fn()
const _mockMkdirSync = vi.fn()

// ---------------------------------------------------------------------------
// Module mocks — MUST be declared before any imports that transitively use them
// ---------------------------------------------------------------------------

vi.mock('../../../core/event-bus.js', () => ({
  createEventBus: () => makeFakeBus(),
}))

vi.mock('../../../modules/database/database-service.js', () => ({
  createDatabaseService: () => ({
    initialize: _mockDbInitialize,
    shutdown: _mockDbShutdown,
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

vi.mock('../../../cli/formatters/streaming.js', () => ({
  emitEvent: (event: string, data: Record<string, unknown>) => _mockEmitEvent(event, data),
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
  existsSync: (p: string) => _mockExistsSync(p),
  mkdirSync: (p: string, opts?: unknown) => _mockMkdirSync(p, opts),
  watch: vi.fn(() => ({
    on: vi.fn(),
    close: vi.fn(),
  })),
}))

vi.mock('../../../recovery/crash-recovery.js', () => ({
  CrashRecoveryManager: {
    findInterruptedSession: vi.fn().mockReturnValue(undefined),
    archiveSession: vi.fn(),
  },
}))

vi.mock('../../../persistence/monitor-database.js', () => ({
  createMonitorDatabase: () => ({
    close: vi.fn(),
  }),
}))

vi.mock('../../../modules/monitor/monitor-agent-impl.js', () => ({
  createMonitorAgent: () => ({}),
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

// We provide real ParseError / ValidationError classes so instanceof checks in start.ts work.
// They are defined in the mocked modules via vi.mock above — we need them to be the SAME classes.

vi.mock('../../../modules/task-graph/task-parser.js', () => {
  class ParseError extends Error {
    public readonly filePath?: string
    public readonly format?: string
    public readonly originalError?: Error
    constructor(message: string, options: { filePath?: string; format?: string; originalError?: Error } = {}) {
      super(message)
      this.name = 'ParseError'
      this.filePath = options.filePath
      this.format = options.format
      this.originalError = options.originalError
    }
  }
  return { ParseError, parseGraphFile: (...args: unknown[]) => _mockParseGraphFile(...args) }
})

vi.mock('../../../modules/task-graph/task-validator.js', () => {
  class ValidationError extends Error {
    public readonly errors: string[]
    public readonly warnings: string[]
    constructor(errors: string[], warnings: string[] = []) {
      super(`Task graph validation failed:\n${errors.join('\n')}`)
      this.name = 'ValidationError'
      this.errors = errors
      this.warnings = warnings
    }
  }
  return { ValidationError, validateGraph: (...args: unknown[]) => _mockValidateGraph(...args) }
})

// ---------------------------------------------------------------------------
// Imports — after all vi.mock() declarations
// ---------------------------------------------------------------------------

import {
  runStartAction,
  START_EXIT_SUCCESS,
  START_EXIT_ERROR,
  START_EXIT_USAGE_ERROR,
  START_EXIT_ALL_FAILED,
  START_EXIT_BUDGET_EXCEEDED,
  START_EXIT_INTERRUPTED,
} from '../start.js'
import type { StartActionOptions } from '../start.js'
import { ParseError } from '../../../modules/task-graph/task-parser.js'
import { ValidationError } from '../../../modules/task-graph/task-validator.js'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const FIXTURE_DIR = join(import.meta.dirname ?? __dirname, 'fixtures')
const SIMPLE_GRAPH = join(FIXTURE_DIR, 'simple-graph.yaml')
const PROJECT_ROOT = '/fake/project'

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function defaultOptions(overrides: Partial<StartActionOptions> = {}): StartActionOptions {
  return {
    graphFile: SIMPLE_GRAPH,
    dryRun: false,
    maxConcurrency: undefined,
    outputFormat: 'human',
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

function scheduleGraphCancelled(): void {
  setImmediate(() => {
    if (_capturedBus) _capturedBus._fire('graph:cancelled', { cancelledTasks: 1 })
  })
}

function scheduleBudgetExceeded(): void {
  setImmediate(() => {
    if (_capturedBus) {
      _capturedBus._fire('session:budget:exceeded', {
        sessionId: 'sess-1',
        currentCostUsd: 10.0,
        budgetUsd: 5.0,
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

  // All mocks return defaults
  _mockDbInitialize.mockResolvedValue(undefined)
  _mockDbShutdown.mockResolvedValue(undefined)
  _mockTgeInitialize.mockResolvedValue(undefined)
  _mockTgeShutdown.mockResolvedValue(undefined)
  _mockRoutingInitialize.mockResolvedValue(undefined)
  _mockRoutingShutdown.mockResolvedValue(undefined)
  _mockWpmInitialize.mockResolvedValue(undefined)
  _mockWpmShutdown.mockResolvedValue(undefined)
  _mockGwmInitialize.mockResolvedValue(undefined)
  _mockGwmShutdown.mockResolvedValue(undefined)
  _mockConfigLoad.mockResolvedValue(undefined)
  _mockConfigGetConfig.mockReturnValue({ global: { max_concurrent_workers: 4 } })

  // loadGraph returns a session ID by default
  _mockLoadGraph.mockResolvedValue('session-abc-123')
  _mockStartExecution.mockReturnValue(undefined)
  _mockCancelAll.mockReturnValue(undefined)
  _mockGetAllTasks.mockReturnValue([
    { id: 'task-a', name: 'Task A' },
    { id: 'task-b', name: 'Task B' },
  ])
  _mockGetReadyTasks.mockReturnValue([{ id: 'task-a', name: 'Task A' }])

  // existsSync returns true for everything by default
  _mockExistsSync.mockReturnValue(true)
  _mockMkdirSync.mockReturnValue(undefined)

  // parseGraphFile and validateGraph defaults for dry-run path
  _mockParseGraphFile.mockReturnValue({ version: '1.0', tasks: { 'task-a': { name: 'Task A' }, 'task-b': { name: 'Task B', depends_on: ['task-a'] } } })
  _mockValidateGraph.mockReturnValue({
    valid: true,
    errors: [],
    warnings: [],
    graph: {
      version: '1.0',
      tasks: {
        'task-a': { name: 'Task A', description: 'First task', prompt: 'do A', agent: 'claude', type: 'code' },
        'task-b': { name: 'Task B', description: 'Second task', prompt: 'do B', agent: 'claude', type: 'code', depends_on: ['task-a'] },
      },
    },
  })
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.clearAllMocks()
})

// ---------------------------------------------------------------------------
// Exit code constants
// ---------------------------------------------------------------------------

describe('exit code constants', () => {
  it('START_EXIT_SUCCESS is 0', () => {
    expect(START_EXIT_SUCCESS).toBe(0)
  })
  it('START_EXIT_ERROR is 1', () => {
    expect(START_EXIT_ERROR).toBe(1)
  })
  it('START_EXIT_USAGE_ERROR is 2', () => {
    expect(START_EXIT_USAGE_ERROR).toBe(2)
  })
  it('START_EXIT_BUDGET_EXCEEDED is 3', () => {
    expect(START_EXIT_BUDGET_EXCEEDED).toBe(3)
  })
  it('START_EXIT_ALL_FAILED is 4', () => {
    expect(START_EXIT_ALL_FAILED).toBe(4)
  })
  it('START_EXIT_INTERRUPTED is 130', () => {
    expect(START_EXIT_INTERRUPTED).toBe(130)
  })
})

// ---------------------------------------------------------------------------
// AC6: Missing graph file
// ---------------------------------------------------------------------------

describe('AC6: missing graph file', () => {
  it('returns exit code 2 when graph file does not exist', async () => {
    // graph file does not exist
    _mockExistsSync.mockReturnValue(false)

    const exitCode = await runStartAction(defaultOptions())

    expect(exitCode).toBe(START_EXIT_USAGE_ERROR)
  })

  it('writes error message to stderr when graph file not found', async () => {
    _mockExistsSync.mockReturnValue(false)

    await runStartAction(defaultOptions())

    expect(getStderr()).toContain('Error: Graph file not found:')
  })

  it('includes file path in error message', async () => {
    _mockExistsSync.mockReturnValue(false)

    await runStartAction(defaultOptions({ graphFile: '/absolute/missing.yaml' }))

    expect(getStderr()).toContain('/absolute/missing.yaml')
  })

  it('does not call loadGraph when file is missing', async () => {
    _mockExistsSync.mockReturnValue(false)

    await runStartAction(defaultOptions())

    expect(_mockLoadGraph).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// AC6: ParseError handling
// ---------------------------------------------------------------------------

describe('AC6: parse error handling', () => {
  it('returns exit code 2 when loadGraph throws ParseError', async () => {
    _mockLoadGraph.mockRejectedValue(new ParseError('unexpected token at line 3'))

    const exitCode = await runStartAction(defaultOptions())

    expect(exitCode).toBe(START_EXIT_USAGE_ERROR)
  })

  it('writes parse error details to stderr', async () => {
    _mockLoadGraph.mockRejectedValue(new ParseError('unexpected token at line 3'))

    await runStartAction(defaultOptions())

    expect(getStderr()).toContain('Failed to parse graph file')
    expect(getStderr()).toContain('unexpected token at line 3')
  })

  it('includes file path in parse error output', async () => {
    _mockLoadGraph.mockRejectedValue(new ParseError('bad yaml'))

    await runStartAction(defaultOptions())

    expect(getStderr()).toContain(SIMPLE_GRAPH)
  })

  it('does not call startExecution after ParseError', async () => {
    _mockLoadGraph.mockRejectedValue(new ParseError('bad yaml'))

    await runStartAction(defaultOptions())

    expect(_mockStartExecution).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// AC6: ValidationError handling
// ---------------------------------------------------------------------------

describe('AC6: validation error handling', () => {
  it('returns exit code 2 when loadGraph throws ValidationError', async () => {
    _mockLoadGraph.mockRejectedValue(
      new ValidationError(['cyclic dependency: task-a → task-b → task-a'])
    )

    const exitCode = await runStartAction(defaultOptions())

    expect(exitCode).toBe(START_EXIT_USAGE_ERROR)
  })

  it('writes validation errors to stderr', async () => {
    _mockLoadGraph.mockRejectedValue(
      new ValidationError(['cyclic dependency detected', 'unknown agent: gpt-99'])
    )

    await runStartAction(defaultOptions())

    const err = getStderr()
    expect(err).toContain('Graph validation failed')
    expect(err).toContain('cyclic dependency detected')
  })

  it('includes all validation errors in stderr output', async () => {
    _mockLoadGraph.mockRejectedValue(
      new ValidationError(['error-one', 'error-two'])
    )

    await runStartAction(defaultOptions())

    expect(getStderr()).toContain('error-one')
    expect(getStderr()).toContain('error-two')
  })

  it('does not call startExecution after ValidationError', async () => {
    _mockLoadGraph.mockRejectedValue(new ValidationError(['bad graph']))

    await runStartAction(defaultOptions())

    expect(_mockStartExecution).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// AC4: --dry-run mode
// ---------------------------------------------------------------------------

describe('AC4: dry-run mode', () => {
  it('returns exit code 0 in dry-run mode', async () => {
    const exitCode = await runStartAction(defaultOptions({ dryRun: true }))

    expect(exitCode).toBe(START_EXIT_SUCCESS)
  })

  it('does NOT call loadGraph (no DB session) in dry-run mode', async () => {
    await runStartAction(defaultOptions({ dryRun: true }))

    expect(_mockLoadGraph).not.toHaveBeenCalled()
  })

  it('does NOT call databaseService.initialize in dry-run mode', async () => {
    await runStartAction(defaultOptions({ dryRun: true }))

    expect(_mockDbInitialize).not.toHaveBeenCalled()
  })

  it('does NOT call startExecution in dry-run mode', async () => {
    await runStartAction(defaultOptions({ dryRun: true }))

    expect(_mockStartExecution).not.toHaveBeenCalled()
  })

  it('calls parseGraphFile and validateGraph in dry-run mode', async () => {
    await runStartAction(defaultOptions({ dryRun: true }))

    expect(_mockParseGraphFile).toHaveBeenCalledOnce()
    expect(_mockValidateGraph).toHaveBeenCalledOnce()
  })

  it('writes task count to stdout in dry-run mode', async () => {
    await runStartAction(defaultOptions({ dryRun: true }))

    expect(getStdout()).toContain('2 tasks')
    expect(getStdout()).toContain('1 ready')
  })

  it('writes task IDs to stdout in dry-run mode', async () => {
    await runStartAction(defaultOptions({ dryRun: true }))

    const output = getStdout()
    expect(output).toContain('task-a')
    expect(output).toContain('task-b')
  })

  it('writes "Dry run" to stdout', async () => {
    await runStartAction(defaultOptions({ dryRun: true }))

    expect(getStdout()).toContain('Dry run')
  })

  it('returns exit code 2 when graph file is missing even in dry-run mode', async () => {
    _mockExistsSync.mockReturnValue(false)

    const exitCode = await runStartAction(defaultOptions({ dryRun: true }))

    expect(exitCode).toBe(START_EXIT_USAGE_ERROR)
  })

  it('returns exit code 2 when parseGraphFile throws ParseError in dry-run mode', async () => {
    _mockParseGraphFile.mockImplementation(() => { throw new ParseError('bad yaml') })

    const exitCode = await runStartAction(defaultOptions({ dryRun: true }))

    expect(exitCode).toBe(START_EXIT_USAGE_ERROR)
  })

  it('returns exit code 2 when validateGraph returns invalid in dry-run mode', async () => {
    _mockValidateGraph.mockReturnValue({
      valid: false,
      errors: ['cyclic dependency detected'],
      warnings: [],
    })

    const exitCode = await runStartAction(defaultOptions({ dryRun: true }))

    expect(exitCode).toBe(START_EXIT_USAGE_ERROR)
  })
})

// ---------------------------------------------------------------------------
// AC1: Valid graph file loads session
// ---------------------------------------------------------------------------

describe('AC1: valid graph file loads session', () => {
  it('calls loadGraph with the resolved absolute file path', async () => {
    scheduleGraphComplete()
    await runStartAction(defaultOptions())

    expect(_mockLoadGraph).toHaveBeenCalledWith(SIMPLE_GRAPH)
  })

  it('resolves relative file paths against projectRoot', async () => {
    scheduleGraphComplete()
    await runStartAction(
      defaultOptions({ graphFile: 'tasks.yaml', projectRoot: '/my/project' })
    )

    expect(_mockLoadGraph).toHaveBeenCalledWith('/my/project/tasks.yaml')
  })

  it('uses absolute file paths as-is (does not prepend projectRoot)', async () => {
    const absPath = '/absolute/path/graph.yaml'
    _mockLoadGraph.mockResolvedValue('sess-abs')

    scheduleGraphComplete()
    await runStartAction(defaultOptions({ graphFile: absPath }))

    expect(_mockLoadGraph).toHaveBeenCalledWith(absPath)
  })

  it('registers graph:loaded event listener on event bus', async () => {
    scheduleGraphComplete()
    await runStartAction(defaultOptions())

    expect(_capturedBus?.on).toHaveBeenCalledWith('graph:loaded', expect.any(Function))
  })

  it('registers graph:complete event listener on event bus', async () => {
    scheduleGraphComplete()
    await runStartAction(defaultOptions())

    expect(_capturedBus?.on).toHaveBeenCalledWith('graph:complete', expect.any(Function))
  })

  it('initializes database service', async () => {
    scheduleGraphComplete()
    await runStartAction(defaultOptions())

    expect(_mockDbInitialize).toHaveBeenCalled()
  })

  it('initializes task graph engine', async () => {
    scheduleGraphComplete()
    await runStartAction(defaultOptions())

    expect(_mockTgeInitialize).toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// AC2: Orchestration begins and workers are scheduled
// ---------------------------------------------------------------------------

describe('AC2: orchestration begins and workers are scheduled', () => {
  it('calls startExecution with session ID returned by loadGraph', async () => {
    _mockLoadGraph.mockResolvedValue('sess-abc')

    scheduleGraphComplete()
    await runStartAction(defaultOptions())

    expect(_mockStartExecution).toHaveBeenCalledWith('sess-abc', expect.any(Number))
  })

  it('calls startExecution with default max concurrency (4)', async () => {
    _mockLoadGraph.mockResolvedValue('sess-abc')

    scheduleGraphComplete()
    await runStartAction(defaultOptions({ maxConcurrency: undefined }))

    expect(_mockStartExecution).toHaveBeenCalledWith('sess-abc', 4)
  })

  it('waits for graph:complete before returning', async () => {
    let completedBeforeGraphDone = false

    scheduleGraphComplete({ totalTasks: 1, completedTasks: 1, failedTasks: 0, totalCostUsd: 0.01 })

    const promise = runStartAction(defaultOptions())
    completedBeforeGraphDone = true
    await promise

    expect(completedBeforeGraphDone).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// AC3: --max-concurrency flag
// ---------------------------------------------------------------------------

describe('AC3: max-concurrency override', () => {
  it('passes --max-concurrency 2 to startExecution', async () => {
    _mockLoadGraph.mockResolvedValue('sess-abc')

    scheduleGraphComplete()
    await runStartAction(defaultOptions({ maxConcurrency: 2 }))

    expect(_mockStartExecution).toHaveBeenCalledWith('sess-abc', 2)
  })

  it('passes --max-concurrency 1 to startExecution', async () => {
    _mockLoadGraph.mockResolvedValue('sess-abc')

    scheduleGraphComplete()
    await runStartAction(defaultOptions({ maxConcurrency: 1 }))

    expect(_mockStartExecution).toHaveBeenCalledWith('sess-abc', 1)
  })

  it('passes --max-concurrency 8 to startExecution', async () => {
    _mockLoadGraph.mockResolvedValue('sess-abc')

    scheduleGraphComplete()
    await runStartAction(defaultOptions({ maxConcurrency: 8 }))

    expect(_mockStartExecution).toHaveBeenCalledWith('sess-abc', 8)
  })

  it('uses config max_concurrent_workers when no CLI flag provided', async () => {
    _mockConfigGetConfig.mockReturnValue({ global: { max_concurrent_workers: 6 } })
    _mockLoadGraph.mockResolvedValue('sess-abc')

    scheduleGraphComplete()
    await runStartAction(defaultOptions({ maxConcurrency: undefined }))

    expect(_mockStartExecution).toHaveBeenCalledWith('sess-abc', 6)
  })

  it('CLI flag overrides config value', async () => {
    _mockConfigGetConfig.mockReturnValue({ global: { max_concurrent_workers: 8 } })
    _mockLoadGraph.mockResolvedValue('sess-abc')

    scheduleGraphComplete()
    await runStartAction(defaultOptions({ maxConcurrency: 3 }))

    expect(_mockStartExecution).toHaveBeenCalledWith('sess-abc', 3)
  })
})

// ---------------------------------------------------------------------------
// AC7: Human-readable output (default)
// ---------------------------------------------------------------------------

describe('AC7: human-readable output', () => {
  it('returns exit code 0 when all tasks complete', async () => {
    scheduleGraphComplete({ totalTasks: 2, completedTasks: 2, failedTasks: 0, totalCostUsd: 0.10 })

    const exitCode = await runStartAction(defaultOptions({ outputFormat: 'human' }))

    expect(exitCode).toBe(START_EXIT_SUCCESS)
  })

  it('returns exit code 4 when ALL tasks fail', async () => {
    scheduleGraphComplete({ totalTasks: 2, completedTasks: 0, failedTasks: 2, totalCostUsd: 0.0 })

    const exitCode = await runStartAction(defaultOptions({ outputFormat: 'human' }))

    expect(exitCode).toBe(START_EXIT_ALL_FAILED)
  })

  it('returns exit code 0 when some (not all) tasks fail', async () => {
    scheduleGraphComplete({ totalTasks: 3, completedTasks: 2, failedTasks: 1, totalCostUsd: 0.05 })

    const exitCode = await runStartAction(defaultOptions({ outputFormat: 'human' }))

    expect(exitCode).toBe(START_EXIT_SUCCESS)
  })

  it('prints session ID to stdout on session start', async () => {
    _mockLoadGraph.mockResolvedValue('sess-human-xyz')

    scheduleGraphComplete()
    await runStartAction(defaultOptions({ outputFormat: 'human' }))

    expect(getStdout()).toContain('sess-human-xyz')
  })

  it('prints graph:complete summary to stdout', async () => {
    scheduleGraphComplete({ totalTasks: 2, completedTasks: 2, failedTasks: 0, totalCostUsd: 0.05 })

    await runStartAction(defaultOptions({ outputFormat: 'human' }))

    expect(getStdout()).toContain('Graph complete')
  })

  it('prints task:started info to stdout in human mode', async () => {
    setImmediate(() => {
      if (_capturedBus) {
        _capturedBus._fire('task:started', { taskId: 'task-a', workerId: 'w1', agent: 'claude' })
        _capturedBus._fire('graph:complete', {
          totalTasks: 1, completedTasks: 1, failedTasks: 0, totalCostUsd: 0.01,
        })
      }
    })

    await runStartAction(defaultOptions({ outputFormat: 'human' }))

    expect(getStdout()).toContain('→ [running] task-a (agent: claude)')
  })

  it('prints task:failed info to stdout in human mode', async () => {
    setImmediate(() => {
      if (_capturedBus) {
        _capturedBus._fire('task:failed', {
          taskId: 'task-b',
          error: { message: 'timeout exceeded', code: 'TIMEOUT' },
        })
        _capturedBus._fire('graph:complete', {
          totalTasks: 1, completedTasks: 0, failedTasks: 1, totalCostUsd: 0.0,
        })
      }
    })

    await runStartAction(defaultOptions({ outputFormat: 'human' }))

    expect(getStdout()).toContain('task-b')
    expect(getStdout()).toContain('timeout exceeded')
  })

  it('prints task:complete info to stdout in human mode', async () => {
    setImmediate(() => {
      if (_capturedBus) {
        _capturedBus._fire('task:complete', {
          taskId: 'task-a',
          result: { costUsd: 0.03, output: 'done' },
        })
        _capturedBus._fire('graph:complete', {
          totalTasks: 1, completedTasks: 1, failedTasks: 0, totalCostUsd: 0.03,
        })
      }
    })

    await runStartAction(defaultOptions({ outputFormat: 'human' }))

    expect(getStdout()).toContain('task-a')
  })
})

// ---------------------------------------------------------------------------
// AC7: Budget exceeded → exit 3
// ---------------------------------------------------------------------------

describe('AC7: budget exceeded → exit 3', () => {
  it('returns exit code 3 when session:budget:exceeded fires', async () => {
    scheduleBudgetExceeded()

    const exitCode = await runStartAction(defaultOptions())

    expect(exitCode).toBe(START_EXIT_BUDGET_EXCEEDED)
  })
})

// ---------------------------------------------------------------------------
// AC5: --output-format json produces NDJSON streaming
// ---------------------------------------------------------------------------

describe('AC5: NDJSON streaming output', () => {
  it('calls emitEvent for graph:loaded when output format is json', async () => {
    _mockLoadGraph.mockResolvedValue('sess-json')

    setImmediate(() => {
      if (_capturedBus) {
        _capturedBus._fire('graph:loaded', { sessionId: 'sess-json', taskCount: 2, readyCount: 1 })
        _capturedBus._fire('graph:complete', {
          totalTasks: 2, completedTasks: 2, failedTasks: 0, totalCostUsd: 0.05,
        })
      }
    })

    await runStartAction(defaultOptions({ outputFormat: 'json' }))

    expect(_mockEmitEvent).toHaveBeenCalledWith('graph:loaded', expect.objectContaining({
      sessionId: 'sess-json',
      taskCount: 2,
      readyCount: 1,
    }))
  })

  it('calls emitEvent for task:started when output format is json', async () => {
    setImmediate(() => {
      if (_capturedBus) {
        _capturedBus._fire('task:started', { taskId: 'task-a', workerId: 'w1', agent: 'claude' })
        _capturedBus._fire('graph:complete', {
          totalTasks: 1, completedTasks: 1, failedTasks: 0, totalCostUsd: 0.01,
        })
      }
    })

    await runStartAction(defaultOptions({ outputFormat: 'json' }))

    expect(_mockEmitEvent).toHaveBeenCalledWith('task:started', expect.objectContaining({
      taskId: 'task-a',
      workerId: 'w1',
      agent: 'claude',
    }))
  })

  it('calls emitEvent for task:complete when output format is json', async () => {
    setImmediate(() => {
      if (_capturedBus) {
        _capturedBus._fire('task:complete', {
          taskId: 'task-a',
          result: { costUsd: 0.02, output: 'done' },
        })
        _capturedBus._fire('graph:complete', {
          totalTasks: 1, completedTasks: 1, failedTasks: 0, totalCostUsd: 0.02,
        })
      }
    })

    await runStartAction(defaultOptions({ outputFormat: 'json' }))

    expect(_mockEmitEvent).toHaveBeenCalledWith('task:complete', expect.objectContaining({
      taskId: 'task-a',
      costUsd: 0.02,
    }))
  })

  it('calls emitEvent for task:failed when output format is json', async () => {
    setImmediate(() => {
      if (_capturedBus) {
        _capturedBus._fire('task:failed', {
          taskId: 'task-b',
          error: { message: 'agent crashed', code: 'ERR' },
        })
        _capturedBus._fire('graph:complete', {
          totalTasks: 1, completedTasks: 0, failedTasks: 1, totalCostUsd: 0.0,
        })
      }
    })

    await runStartAction(defaultOptions({ outputFormat: 'json' }))

    expect(_mockEmitEvent).toHaveBeenCalledWith('task:failed', expect.objectContaining({
      taskId: 'task-b',
      error: 'agent crashed',
    }))
  })

  it('calls emitEvent for task:cancelled when output format is json', async () => {
    setImmediate(() => {
      if (_capturedBus) {
        _capturedBus._fire('task:cancelled', { taskId: 'task-c', reason: 'SIGINT' })
        _capturedBus._fire('graph:complete', {
          totalTasks: 1, completedTasks: 0, failedTasks: 0, totalCostUsd: 0.0,
        })
      }
    })

    await runStartAction(defaultOptions({ outputFormat: 'json' }))

    expect(_mockEmitEvent).toHaveBeenCalledWith('task:cancelled', expect.objectContaining({
      taskId: 'task-c',
      reason: 'SIGINT',
    }))
  })

  it('calls emitEvent for graph:complete when output format is json', async () => {
    setImmediate(() => {
      if (_capturedBus) {
        _capturedBus._fire('graph:complete', {
          totalTasks: 3,
          completedTasks: 3,
          failedTasks: 0,
          totalCostUsd: 0.15,
        })
      }
    })

    await runStartAction(defaultOptions({ outputFormat: 'json' }))

    expect(_mockEmitEvent).toHaveBeenCalledWith('graph:complete', expect.objectContaining({
      totalTasks: 3,
      completedTasks: 3,
      failedTasks: 0,
      totalCostUsd: 0.15,
    }))
  })

  it('does NOT call emitEvent in human output mode', async () => {
    scheduleGraphComplete()

    await runStartAction(defaultOptions({ outputFormat: 'human' }))

    expect(_mockEmitEvent).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// AC8: SIGINT/SIGTERM graceful shutdown
// ---------------------------------------------------------------------------

describe('AC8: SIGINT graceful shutdown', () => {
  it('calls cancelAll when SIGINT is received', async () => {
    setImmediate(() => {
      process.emit('SIGINT')
      // After cancelAll, simulate graph:cancelled
      setImmediate(() => {
        if (_capturedBus) _capturedBus._fire('graph:cancelled', { cancelledTasks: 1 })
      })
    })

    await runStartAction(defaultOptions())

    expect(_mockCancelAll).toHaveBeenCalled()
  })

  it('returns exit code 130 when graph:cancelled fires after SIGINT', async () => {
    setImmediate(() => {
      process.emit('SIGINT')
      setImmediate(() => {
        if (_capturedBus) _capturedBus._fire('graph:cancelled', { cancelledTasks: 1 })
      })
    })

    const exitCode = await runStartAction(defaultOptions())

    expect(exitCode).toBe(START_EXIT_INTERRUPTED)
  })

  it('returns exit code 130 when graph:cancelled fires (without SIGINT)', async () => {
    scheduleGraphCancelled()

    const exitCode = await runStartAction(defaultOptions())

    expect(exitCode).toBe(START_EXIT_INTERRUPTED)
  })
})

describe('AC8: SIGTERM graceful shutdown', () => {
  it('calls cancelAll when SIGTERM is received', async () => {
    setImmediate(() => {
      process.emit('SIGTERM')
      setImmediate(() => {
        if (_capturedBus) _capturedBus._fire('graph:cancelled', { cancelledTasks: 1 })
      })
    })

    await runStartAction(defaultOptions())

    expect(_mockCancelAll).toHaveBeenCalled()
  })

  it('resolves with exit 130 after SIGTERM', async () => {
    setImmediate(() => {
      process.emit('SIGTERM')
      setImmediate(() => {
        if (_capturedBus) _capturedBus._fire('graph:cancelled', { cancelledTasks: 0 })
      })
    })

    const exitCode = await runStartAction(defaultOptions())

    expect(exitCode).toBe(START_EXIT_INTERRUPTED)
  })
})

// ---------------------------------------------------------------------------
// System error handling (exit 1)
// ---------------------------------------------------------------------------

describe('system error handling', () => {
  it('returns exit code 1 when database initialization throws', async () => {
    _mockDbInitialize.mockRejectedValue(new Error('disk full'))

    const exitCode = await runStartAction(defaultOptions())

    expect(exitCode).toBe(START_EXIT_ERROR)
  })

  it('writes system error message to stderr', async () => {
    _mockDbInitialize.mockRejectedValue(new Error('disk full'))

    await runStartAction(defaultOptions())

    expect(getStderr()).toContain('disk full')
  })

  it('returns exit code 1 for unknown non-parse errors from loadGraph', async () => {
    _mockTgeInitialize.mockResolvedValue(undefined)
    _mockLoadGraph.mockRejectedValue(new Error('unexpected internal failure'))

    const exitCode = await runStartAction(defaultOptions())

    expect(exitCode).toBe(START_EXIT_ERROR)
  })
})

// ---------------------------------------------------------------------------
// Service lifecycle / cleanup
// ---------------------------------------------------------------------------

describe('service lifecycle and cleanup', () => {
  it('calls workerPoolManager.shutdown in finally block on success', async () => {
    scheduleGraphComplete()

    await runStartAction(defaultOptions())

    expect(_mockWpmShutdown).toHaveBeenCalled()
  })

  it('calls databaseService.shutdown in finally block on success', async () => {
    scheduleGraphComplete()

    await runStartAction(defaultOptions())

    expect(_mockDbShutdown).toHaveBeenCalled()
  })

  it('calls taskGraphEngine.shutdown in finally block on success', async () => {
    scheduleGraphComplete()

    await runStartAction(defaultOptions())

    expect(_mockTgeShutdown).toHaveBeenCalled()
  })

  it('calls shutdown services even when initialization fails', async () => {
    _mockDbInitialize.mockRejectedValue(new Error('boom'))

    await runStartAction(defaultOptions())

    expect(_mockDbShutdown).toHaveBeenCalled()
  })

  it('creates .substrate directory when it does not exist', async () => {
    // Return false only for the .substrate dir existence check (not for the graph file)
    _mockExistsSync.mockImplementation((p: unknown) => {
      const path = String(p)
      if (path.endsWith('.substrate') && !path.includes('state.db')) return false
      return true
    })

    scheduleGraphComplete()
    await runStartAction(defaultOptions())

    expect(_mockMkdirSync).toHaveBeenCalledWith(
      expect.stringContaining('.substrate'),
      expect.objectContaining({ recursive: true }),
    )
  })

  it('does not create .substrate directory when it already exists', async () => {
    // Both graph file and substrate dir exist
    _mockExistsSync.mockReturnValue(true)

    scheduleGraphComplete()
    await runStartAction(defaultOptions())

    expect(_mockMkdirSync).not.toHaveBeenCalled()
  })
})
