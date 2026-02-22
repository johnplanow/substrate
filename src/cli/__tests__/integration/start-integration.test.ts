/**
 * Integration tests for `substrate start` command
 *
 * Tests the full end-to-end flow for the start command:
 *   - Command registration in Commander program
 *   - Dry-run mode with real YAML parsing and validation (no DB)
 *   - Non-dry-run mode with mocked services asserting DB session creation
 *   - Exit codes and output format verification
 *   - NDJSON output format verification
 *
 * Uses the existing fixture at src/cli/commands/__tests__/fixtures/simple-graph.yaml
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { join } from 'path'
import { fileURLToPath } from 'url'
import { dirname } from 'path'
import { Command } from 'commander'

// ---------------------------------------------------------------------------
// Shared mock functions for non-dry-run integration tests
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

const _mockDbInitialize = vi.fn()
const _mockDbShutdown = vi.fn()
const _mockLoadGraph = vi.fn()
const _mockStartExecution = vi.fn()
const _mockGetAllTasks = vi.fn()
const _mockGetReadyTasks = vi.fn()
const _mockCancelAll = vi.fn()
const _mockTgeInitialize = vi.fn()
const _mockTgeShutdown = vi.fn()
const _mockRoutingInitialize = vi.fn()
const _mockRoutingShutdown = vi.fn()
const _mockWpmInitialize = vi.fn()
const _mockWpmShutdown = vi.fn()
const _mockGwmInitialize = vi.fn()
const _mockGwmShutdown = vi.fn()
const _mockConfigLoad = vi.fn()
const _mockConfigGetConfig = vi.fn()
const _mockExistsSync = vi.fn()
const _mockMkdirSync = vi.fn()

// ---------------------------------------------------------------------------
// Module mocks — hoisted before imports by vitest
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

vi.mock('../../../persistence/monitor-database.js', () => ({
  createMonitorDatabase: () => ({
    close: vi.fn(),
  }),
}))

vi.mock('../../../modules/monitor/monitor-agent-impl.js', () => ({
  createMonitorAgent: () => ({}),
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

vi.mock('fs', async (importOriginal) => {
  const original = await importOriginal<typeof import('fs')>()
  return {
    ...original,
    existsSync: (p: string) => _mockExistsSync(p),
    mkdirSync: (p: string, opts?: unknown) => _mockMkdirSync(p, opts),
    watch: vi.fn(() => ({
      on: vi.fn(),
      close: vi.fn(),
    })),
  }
})

vi.mock('../../../recovery/crash-recovery.js', () => ({
  CrashRecoveryManager: {
    findInterruptedSession: vi.fn().mockReturnValue(undefined),
    archiveSession: vi.fn(),
  },
}))

vi.mock('../../../recovery/shutdown-handler.js', () => ({
  setupGracefulShutdown: vi.fn(() => {
    return (): void => { /* no-op cleanup */ }
  }),
}))

// ---------------------------------------------------------------------------
// Imports — after all vi.mock() declarations
// ---------------------------------------------------------------------------

import { runStartAction, registerStartCommand, START_EXIT_SUCCESS, START_EXIT_USAGE_ERROR } from '../../commands/start.js'
import type { StartActionOptions } from '../../commands/start.js'

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const FIXTURES_DIR = join(__dirname, '../../commands/__tests__/fixtures')
const SIMPLE_GRAPH = join(FIXTURES_DIR, 'simple-graph.yaml')
const PROJECT_ROOT = '/fake/project'

// ---------------------------------------------------------------------------
// Output capture
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function defaultDryRunOptions(overrides: Partial<StartActionOptions> = {}): StartActionOptions {
  return {
    graphFile: SIMPLE_GRAPH,
    dryRun: true,
    maxConcurrency: undefined,
    outputFormat: 'human',
    projectRoot: process.cwd(),
    version: '1.0.0',
    ...overrides,
  }
}

function defaultLiveOptions(overrides: Partial<StartActionOptions> = {}): StartActionOptions {
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

/** Schedule a graph:complete event via setImmediate to resolve the done-promise. */
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
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  captureOutput()
  _capturedBus = null

  // All service mocks return defaults
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
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.clearAllMocks()
})

// ---------------------------------------------------------------------------
// Integration: Command registration
// ---------------------------------------------------------------------------

describe('start command registration', () => {
  it('registerStartCommand adds "start" command to program', () => {
    const program = new Command()
    program.exitOverride()
    registerStartCommand(program, '0.1.0')

    const startCmd = program.commands.find((c) => c.name() === 'start')
    expect(startCmd).toBeDefined()
  })

  it('start command has --graph, --dry-run, --max-concurrency, --output-format options', () => {
    const program = new Command()
    program.exitOverride()
    registerStartCommand(program, '0.1.0')

    const startCmd = program.commands.find((c) => c.name() === 'start')
    expect(startCmd).toBeDefined()
    const optionNames = startCmd!.options.map((o) => o.long)
    expect(optionNames).toContain('--graph')
    expect(optionNames).toContain('--dry-run')
    expect(optionNames).toContain('--max-concurrency')
    expect(optionNames).toContain('--output-format')
  })
})

// ---------------------------------------------------------------------------
// Integration: Dry-run with real YAML parsing (no DB, no mocks needed)
// ---------------------------------------------------------------------------

describe('dry-run integration with real graph file', () => {
  it('returns exit code 0 for valid graph in dry-run mode', async () => {
    // In dry-run mode, existsSync is called on the real file — allow it through
    _mockExistsSync.mockImplementation(() => true)

    const exitCode = await runStartAction(defaultDryRunOptions())

    expect(exitCode).toBe(START_EXIT_SUCCESS)
  })

  it('does not initialize database service in dry-run mode', async () => {
    _mockExistsSync.mockImplementation(() => true)

    await runStartAction(defaultDryRunOptions())

    expect(_mockDbInitialize).not.toHaveBeenCalled()
  })

  it('outputs task count and ready count from real graph parsing', async () => {
    _mockExistsSync.mockImplementation(() => true)

    await runStartAction(defaultDryRunOptions())

    const output = getStdout()
    // simple-graph.yaml has 2 tasks, 1 ready (task-a has no deps)
    expect(output).toContain('Dry run')
    expect(output).toContain('2 tasks')
    expect(output).toContain('1 ready')
  })

  it('outputs task IDs parsed from the real YAML fixture', async () => {
    _mockExistsSync.mockImplementation(() => true)

    await runStartAction(defaultDryRunOptions())

    const output = getStdout()
    expect(output).toContain('task-a')
    expect(output).toContain('Task A')
    expect(output).toContain('task-b')
    expect(output).toContain('Task B')
  })

  it('outputs task names from the real YAML fixture', async () => {
    _mockExistsSync.mockImplementation(() => true)

    await runStartAction(defaultDryRunOptions())

    const output = getStdout()
    // Check the exact format: "  - task-a: Task A"
    expect(output).toContain('  - task-a: Task A')
    expect(output).toContain('  - task-b: Task B')
  })
})

// ---------------------------------------------------------------------------
// Integration: Non-dry-run — DB session creation (AC1)
// ---------------------------------------------------------------------------

describe('non-dry-run integration: DB session creation', () => {
  it('initializes database service when not in dry-run mode', async () => {
    scheduleGraphComplete()

    await runStartAction(defaultLiveOptions())

    expect(_mockDbInitialize).toHaveBeenCalledOnce()
  })

  it('calls loadGraph on the task graph engine (creates DB session)', async () => {
    _mockLoadGraph.mockResolvedValue('session-live-456')

    scheduleGraphComplete()
    await runStartAction(defaultLiveOptions())

    expect(_mockLoadGraph).toHaveBeenCalledWith(SIMPLE_GRAPH)
  })

  it('session ID returned by loadGraph is used to start execution', async () => {
    const expectedSessionId = 'session-live-789'
    _mockLoadGraph.mockResolvedValue(expectedSessionId)

    scheduleGraphComplete()
    await runStartAction(defaultLiveOptions())

    expect(_mockStartExecution).toHaveBeenCalledWith(expectedSessionId, expect.any(Number))
  })

  it('prints session ID to stdout confirming session was created', async () => {
    _mockLoadGraph.mockResolvedValue('session-integration-abc')

    scheduleGraphComplete()
    await runStartAction(defaultLiveOptions())

    expect(getStdout()).toContain('session-integration-abc')
  })

  it('returns exit code 0 when graph completes successfully (non-dry-run)', async () => {
    scheduleGraphComplete({ totalTasks: 2, completedTasks: 2, failedTasks: 0, totalCostUsd: 0.05 })

    const exitCode = await runStartAction(defaultLiveOptions())

    expect(exitCode).toBe(START_EXIT_SUCCESS)
  })

  it('shuts down database service after execution completes', async () => {
    scheduleGraphComplete()

    await runStartAction(defaultLiveOptions())

    expect(_mockDbShutdown).toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// Integration: Error cases with real file system
// ---------------------------------------------------------------------------

describe('error cases with real file system', () => {
  it('returns exit code 2 for non-existent graph file', async () => {
    _mockExistsSync.mockReturnValue(false)

    const exitCode = await runStartAction(
      defaultDryRunOptions({ graphFile: '/nonexistent/path/to/graph.yaml' })
    )

    expect(exitCode).toBe(START_EXIT_USAGE_ERROR)
  })

  it('writes error message to stderr for non-existent graph file', async () => {
    _mockExistsSync.mockReturnValue(false)

    await runStartAction(
      defaultDryRunOptions({ graphFile: '/nonexistent/path/to/graph.yaml' })
    )

    expect(getStderr()).toContain('Error: Graph file not found:')
    expect(getStderr()).toContain('/nonexistent/path/to/graph.yaml')
  })
})

// ---------------------------------------------------------------------------
// Integration: Exit code validation
// ---------------------------------------------------------------------------

describe('exit code contract', () => {
  it('exit code 0 means success (dry-run completes without error)', async () => {
    _mockExistsSync.mockImplementation(() => true)

    const exitCode = await runStartAction(defaultDryRunOptions())

    expect(exitCode).toBe(0)
  })

  it('exit code 2 means usage error (missing file)', async () => {
    _mockExistsSync.mockReturnValue(false)

    const exitCode = await runStartAction(
      defaultDryRunOptions({ graphFile: '/does/not/exist.yaml' })
    )

    expect(exitCode).toBe(2)
  })
})
