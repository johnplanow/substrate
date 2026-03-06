/**
 * Integration tests for Epic 15 — Pipeline Observability & Agent Integration
 *
 * These tests cover cross-module interactions that unit tests do not address:
 *
 * GAP-1: Event emitter -> runRunAction wiring (--events flag produces NDJSON on stdout)
 * GAP-2: Flag mutual exclusion gates in runRunAction:
 *         - --events blocks progressRenderer creation
 *         - --tui + non-TTY falls back to progressRenderer path (or default)
 *         - --output-format json blocks all renderer/emitter wiring
 * GAP-3: --help-agent flag registered on the CLI `run` subcommand
 * GAP-4: mapInternalPhaseToEventPhase coverage (all internal phase names)
 * GAP-5: --verbose flag effect on LOG_LEVEL environment variable
 * GAP-6: pipeline:complete NDJSON event is the last event emitted in --events mode
 * GAP-7: progressRenderer NOT activated when --output-format json
 * GAP-8: TUI is NOT started when --events flag is active
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { Command } from 'commander'
import { PassThrough } from 'node:stream'

// ---------------------------------------------------------------------------
// Mocks — all declared before imports (vitest hoisting)
// ---------------------------------------------------------------------------

// Mock DatabaseWrapper
const mockOpen = vi.fn()
const mockClose = vi.fn()
let mockDb: Record<string, unknown> = {}

vi.mock('../../../persistence/database.js', () => ({
  DatabaseWrapper: vi.fn(() => ({
    open: mockOpen,
    close: mockClose,
    get db() {
      return mockDb
    },
    get isOpen() {
      return true
    },
  })),
}))

vi.mock('../../../persistence/migrations/index.js', () => ({
  runMigrations: vi.fn(),
}))

const mockPackLoad = vi.fn()
vi.mock('../../../modules/methodology-pack/pack-loader.js', () => ({
  createPackLoader: vi.fn(() => ({
    load: mockPackLoad,
    discover: vi.fn(),
  })),
}))

const mockContextCompilerCompile = vi.fn()
vi.mock('../../../modules/context-compiler/index.js', () => ({
  createContextCompiler: vi.fn(() => ({
    compile: mockContextCompilerCompile,
    registerTemplate: vi.fn(),
  })),
}))

const mockDispatch = vi.fn()
const mockDispatcherShutdown = vi.fn()
vi.mock('../../../modules/agent-dispatch/index.js', () => ({
  createDispatcher: vi.fn(() => ({
    dispatch: mockDispatch,
    shutdown: mockDispatcherShutdown,
    getPending: vi.fn(() => 0),
    getRunning: vi.fn(() => 0),
  })),
}))

const mockDiscoverAndRegister = vi.fn()
vi.mock('../../../adapters/adapter-registry.js', () => ({
  AdapterRegistry: vi.fn(() => ({
    discoverAndRegister: mockDiscoverAndRegister,
  })),
}))

const mockOrchestratorRun = vi.fn()
const mockDiscoverPendingStoryKeys = vi.fn()
vi.mock('../../../modules/implementation-orchestrator/index.js', () => ({
  createImplementationOrchestrator: vi.fn(() => ({
    run: mockOrchestratorRun,
    pause: vi.fn(),
    resume: vi.fn(),
    getStatus: vi.fn(),
  })),
  discoverPendingStoryKeys: (...args: unknown[]) => mockDiscoverPendingStoryKeys(...args),
}))

const mockCreatePipelineRun = vi.fn()
const mockGetLatestRun = vi.fn()
const mockAddTokenUsage = vi.fn()
const mockGetTokenUsageSummary = vi.fn()
const mockGetRunningPipelineRuns = vi.fn().mockReturnValue([])
const mockUpdatePipelineRun = vi.fn()
vi.mock('../../../persistence/queries/decisions.js', () => ({
  createPipelineRun: (...args: unknown[]) => mockCreatePipelineRun(...args),
  getLatestRun: (...args: unknown[]) => mockGetLatestRun(...args),
  addTokenUsage: (...args: unknown[]) => mockAddTokenUsage(...args),
  getTokenUsageSummary: (...args: unknown[]) => mockGetTokenUsageSummary(...args),
  getRunningPipelineRuns: (...args: unknown[]) => mockGetRunningPipelineRuns(...args),
  updatePipelineRun: (...args: unknown[]) => mockUpdatePipelineRun(...args),
}))

vi.mock('../health.js', () => ({
  inspectProcessTree: vi.fn().mockReturnValue({ orchestrator_pid: null, child_pids: [], zombies: [] }),
}))

// Event bus — capture all listeners so tests can fire events
type EventListener = (payload: unknown) => void
const eventBusListeners: Record<string, EventListener[]> = {}
const mockEventBus = {
  on: vi.fn((event: string, listener: EventListener) => {
    if (!eventBusListeners[event]) eventBusListeners[event] = []
    eventBusListeners[event].push(listener)
  }),
  emit: vi.fn((event: string, payload: unknown) => {
    for (const listener of eventBusListeners[event] ?? []) {
      listener(payload)
    }
  }),
  off: vi.fn(),
}

vi.mock('../../../core/event-bus.js', () => ({
  createEventBus: vi.fn(() => mockEventBus),
}))

const mockExistsSync = vi.fn()
const mockMkdirSync = vi.fn()
const mockCpSync = vi.fn()
vi.mock('fs', () => ({
  existsSync: (...args: unknown[]) => mockExistsSync(...args),
  mkdirSync: (...args: unknown[]) => mockMkdirSync(...args),
  cpSync: (...args: unknown[]) => mockCpSync(...args),
}))

const mockReadFile = vi.fn()
const mockWriteFile = vi.fn()
vi.mock('fs/promises', () => ({
  readFile: (...args: unknown[]) => mockReadFile(...args),
  writeFile: (...args: unknown[]) => mockWriteFile(...args),
}))

const mockRequireResolve = vi.fn()
const mockRequireCall = vi.fn()
vi.mock('node:module', () => ({
  createRequire: vi.fn(() => {
    const req = (id: string) => mockRequireCall(id)
    req.resolve = (id: string) => mockRequireResolve(id)
    return req
  }),
}))

const mockResolveMainRepoRoot = vi.fn((root: string) => Promise.resolve(root ?? '/test/project'))
vi.mock('../../../utils/git-root.js', () => ({
  resolveMainRepoRoot: (...args: unknown[]) => mockResolveMainRepoRoot(...args),
}))

// Mock stop-after to avoid phase validation issues
vi.mock('../../../modules/stop-after/index.js', () => ({
  VALID_PHASES: ['analysis', 'planning', 'solutioning', 'implementation'],
  createStopAfterGate: vi.fn(() => ({ shouldHalt: () => false })),
  validateStopAfterFromConflict: vi.fn(() => ({ valid: true })),
  formatPhaseCompletionSummary: vi.fn(() => ''),
}))

// ---------------------------------------------------------------------------
// Import modules under test AFTER mocks
// ---------------------------------------------------------------------------

import { runRunAction, registerRunCommand } from '../run.js'

// ---------------------------------------------------------------------------
// Shared mock registry instance — required by runRunAction (throws if missing)
// ---------------------------------------------------------------------------

const mockRegistry = { discoverAndRegister: vi.fn().mockResolvedValue({ results: [], failedCount: 0 }) } as any

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mockPipelineRun(overrides = {}) {
  return {
    id: 'run-uuid-123',
    methodology: 'bmad',
    current_phase: 'implementation',
    status: 'running',
    config_json: null,
    token_usage_json: null,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    ...overrides,
  }
}

function mockPack() {
  return {
    manifest: {
      name: 'bmad',
      version: '1.0.0',
      description: 'BMAD methodology pack',
      prompts: {},
      constraints: {},
      templates: {},
    },
    getPrompt: vi.fn(),
    getConstraint: vi.fn(),
    getTemplate: vi.fn(),
  }
}

const defaultStatus = {
  state: 'COMPLETE',
  stories: {
    '10-1': { phase: 'COMPLETE', reviewCycles: 1 },
  },
  startedAt: '2026-01-01T00:00:00Z',
  completedAt: '2026-01-01T00:01:00Z',
  totalDurationMs: 60000,
}

// ---------------------------------------------------------------------------
// Reset helpers
// ---------------------------------------------------------------------------

function resetEventBusListeners() {
  for (const key of Object.keys(eventBusListeners)) {
    delete eventBusListeners[key]
  }
}

// ---------------------------------------------------------------------------
// GAP-1: --events flag produces NDJSON on stdout
// Tests that createEventEmitter is wired to process.stdout when eventsFlag=true
// ---------------------------------------------------------------------------

describe('GAP-1: --events flag wires NDJSON emitter to stdout', () => {
  let stdoutChunks: string[]
  let originalWrite: typeof process.stdout.write

  beforeEach(() => {
    vi.clearAllMocks()
    resetEventBusListeners()

    stdoutChunks = []
    originalWrite = process.stdout.write.bind(process.stdout)

    // Capture stdout writes
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
      stdoutChunks.push(chunk.toString())
      return true
    })

    mockExistsSync.mockReturnValue(true)
    mockPackLoad.mockResolvedValue(mockPack())
    mockDiscoverAndRegister.mockResolvedValue(undefined)
    mockCreatePipelineRun.mockReturnValue(mockPipelineRun())
    mockOrchestratorRun.mockResolvedValue(defaultStatus)
    mockGetTokenUsageSummary.mockReturnValue([])
    mockDiscoverPendingStoryKeys.mockReturnValue([])

    const mockPrepare = vi.fn().mockReturnValue({
      all: vi.fn().mockReturnValue([]),
      get: vi.fn().mockReturnValue(undefined),
    })
    mockDb = { prepare: mockPrepare }
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('writes pipeline:start as the first NDJSON line on stdout', async () => {
    await runRunAction({
      pack: 'bmad',
      stories: '10-1',
      concurrency: 1,
      outputFormat: 'human',
      projectRoot: '/test/project',
      events: true,
      registry: mockRegistry,
    })

    const allOutput = stdoutChunks.join('')
    const lines = allOutput.split('\n').filter((l) => l.trim().startsWith('{'))

    // First valid JSON line must be pipeline:start
    expect(lines.length).toBeGreaterThanOrEqual(1)
    const first = JSON.parse(lines[0]) as { type: string }
    expect(first.type).toBe('pipeline:start')
  })

  it('pipeline:start event includes run_id, stories, concurrency fields', async () => {
    await runRunAction({
      pack: 'bmad',
      stories: '10-1,10-2',
      concurrency: 3,
      outputFormat: 'human',
      projectRoot: '/test/project',
      events: true,
      registry: mockRegistry,
    })

    const allOutput = stdoutChunks.join('')
    const lines = allOutput.split('\n').filter((l) => l.trim().startsWith('{'))
    const startEvent = JSON.parse(lines[0]) as {
      type: string
      run_id: string
      stories: string[]
      concurrency: number
    }

    expect(startEvent.run_id).toBe('run-uuid-123')
    expect(startEvent.stories).toContain('10-1')
    expect(startEvent.stories).toContain('10-2')
    expect(startEvent.concurrency).toBe(3)
  })

  it('pipeline:complete is the last NDJSON event emitted', async () => {
    await runRunAction({
      pack: 'bmad',
      stories: '10-1',
      concurrency: 1,
      outputFormat: 'human',
      projectRoot: '/test/project',
      events: true,
      registry: mockRegistry,
    })

    const allOutput = stdoutChunks.join('')
    const lines = allOutput.split('\n').filter((l) => l.trim().startsWith('{'))

    // Last valid JSON line must be pipeline:complete
    expect(lines.length).toBeGreaterThanOrEqual(2)
    const last = JSON.parse(lines[lines.length - 1]) as { type: string }
    expect(last.type).toBe('pipeline:complete')
  })

  it('story:phase event emitted to stdout when orchestrator fires story-phase-complete', async () => {
    // Arrange: orchestrator fires the event during its run
    mockOrchestratorRun.mockImplementation(async () => {
      // Simulate the event bus firing orchestrator:story-phase-complete
      const listeners = eventBusListeners['orchestrator:story-phase-complete'] ?? []
      for (const listener of listeners) {
        listener({
          storyKey: '10-1',
          phase: 'IN_STORY_CREATION',
          result: { story_file: '/stories/10-1.md' },
        })
      }
      return defaultStatus
    })

    await runRunAction({
      pack: 'bmad',
      stories: '10-1',
      concurrency: 1,
      outputFormat: 'human',
      projectRoot: '/test/project',
      events: true,
      registry: mockRegistry,
    })

    const allOutput = stdoutChunks.join('')
    const lines = allOutput.split('\n').filter((l) => l.trim().startsWith('{'))

    const phaseEvents = lines
      .map((l) => JSON.parse(l) as { type: string; phase?: string })
      .filter((e) => e.type === 'story:phase')

    expect(phaseEvents.length).toBeGreaterThanOrEqual(1)
    expect(phaseEvents[0].phase).toBe('create-story')
  })

  it('story:done event emitted to stdout when orchestrator fires story-complete', async () => {
    mockOrchestratorRun.mockImplementation(async () => {
      const listeners = eventBusListeners['orchestrator:story-complete'] ?? []
      for (const listener of listeners) {
        listener({ storyKey: '10-1', reviewCycles: 2 })
      }
      return defaultStatus
    })

    await runRunAction({
      pack: 'bmad',
      stories: '10-1',
      concurrency: 1,
      outputFormat: 'human',
      projectRoot: '/test/project',
      events: true,
      registry: mockRegistry,
    })

    const allOutput = stdoutChunks.join('')
    const lines = allOutput.split('\n').filter((l) => l.trim().startsWith('{'))

    const doneEvents = lines
      .map((l) => JSON.parse(l) as { type: string; result?: string; review_cycles?: number })
      .filter((e) => e.type === 'story:done')

    expect(doneEvents.length).toBeGreaterThanOrEqual(1)
    expect(doneEvents[0].result).toBe('success')
    expect(doneEvents[0].review_cycles).toBe(2)
  })

  it('story:escalation event emitted when orchestrator fires story-escalated', async () => {
    mockOrchestratorRun.mockImplementation(async () => {
      const listeners = eventBusListeners['orchestrator:story-escalated'] ?? []
      for (const listener of listeners) {
        listener({
          storyKey: '10-1',
          lastVerdict: 'NEEDS_MAJOR_REVISION',
          reviewCycles: 3,
          issues: [{ severity: 'blocker', file: 'src/foo.ts', description: 'Null ref' }],
        })
      }
      return {
        state: 'COMPLETE',
        stories: { '10-1': { phase: 'ESCALATED', reviewCycles: 3 } },
      }
    })

    await runRunAction({
      pack: 'bmad',
      stories: '10-1',
      concurrency: 1,
      outputFormat: 'human',
      projectRoot: '/test/project',
      events: true,
      registry: mockRegistry,
    })

    const allOutput = stdoutChunks.join('')
    const lines = allOutput.split('\n').filter((l) => l.trim().startsWith('{'))

    const escalationEvents = lines
      .map((l) => JSON.parse(l) as { type: string; reason?: string; cycles?: number })
      .filter((e) => e.type === 'story:escalation')

    expect(escalationEvents.length).toBeGreaterThanOrEqual(1)
    expect(escalationEvents[0].reason).toBe('NEEDS_MAJOR_REVISION')
    expect(escalationEvents[0].cycles).toBe(3)
  })

  it('all NDJSON lines are valid JSON (none contain non-JSON prefixes)', async () => {
    await runRunAction({
      pack: 'bmad',
      stories: '10-1',
      concurrency: 1,
      outputFormat: 'human',
      projectRoot: '/test/project',
      events: true,
      registry: mockRegistry,
    })

    const allOutput = stdoutChunks.join('')
    const lines = allOutput.split('\n').filter((l) => l.trim().startsWith('{'))

    for (const line of lines) {
      expect(() => JSON.parse(line)).not.toThrow()
    }
  })
})

// ---------------------------------------------------------------------------
// GAP-2: Flag mutual exclusion gates
// ---------------------------------------------------------------------------

describe('GAP-2: Flag mutual exclusion — --events blocks progressRenderer', () => {
  let stdoutChunks: string[]

  beforeEach(() => {
    vi.clearAllMocks()
    resetEventBusListeners()

    stdoutChunks = []
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
      stdoutChunks.push(chunk.toString())
      return true
    })

    mockExistsSync.mockReturnValue(true)
    mockPackLoad.mockResolvedValue(mockPack())
    mockDiscoverAndRegister.mockResolvedValue(undefined)
    mockCreatePipelineRun.mockReturnValue(mockPipelineRun())
    mockOrchestratorRun.mockResolvedValue(defaultStatus)
    mockGetTokenUsageSummary.mockReturnValue([])
    mockDiscoverPendingStoryKeys.mockReturnValue([])

    const mockPrepare = vi.fn().mockReturnValue({
      all: vi.fn().mockReturnValue([]),
      get: vi.fn().mockReturnValue(undefined),
    })
    mockDb = { prepare: mockPrepare }
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('with --events, stdout does NOT contain the human progress header', async () => {
    await runRunAction({
      pack: 'bmad',
      stories: '10-1',
      concurrency: 1,
      outputFormat: 'human',
      projectRoot: '/test/project',
      events: true,
      registry: mockRegistry,
    })

    const allOutput = stdoutChunks.join('')
    // The progress renderer writes "substrate run —" as its header.
    // With --events, this must NOT appear since stdout is reserved for NDJSON.
    expect(allOutput).not.toContain('substrate run —')
  })

  it('with --events, stdout contains only parseable NDJSON (no human-readable lines)', async () => {
    await runRunAction({
      pack: 'bmad',
      stories: '10-1',
      concurrency: 1,
      outputFormat: 'human',
      projectRoot: '/test/project',
      events: true,
      registry: mockRegistry,
    })

    const allOutput = stdoutChunks.join('')
    // Strip empty lines
    const nonEmptyLines = allOutput.split('\n').filter((l) => l.trim().length > 0)

    // Every non-empty line must be valid JSON
    for (const line of nonEmptyLines) {
      expect(() => JSON.parse(line)).not.toThrow()
    }
  })

  it('without --events, human progress header is written to stdout', async () => {
    await runRunAction({
      pack: 'bmad',
      stories: '10-1',
      concurrency: 1,
      outputFormat: 'human',
      projectRoot: '/test/project',
      events: false,
      registry: mockRegistry,
    })

    const allOutput = stdoutChunks.join('')
    // Progress renderer header: "substrate run — N stories, concurrency M"
    expect(allOutput).toContain('substrate run —')
  })

  it('with --output-format json, no progress renderer header written', async () => {
    const stdoutSpy = vi.spyOn(process.stdout, 'write')

    await runRunAction({
      pack: 'bmad',
      stories: '10-1',
      concurrency: 1,
      outputFormat: 'json',
      projectRoot: '/test/project',
      registry: mockRegistry,
    })

    const allOutput = stdoutSpy.mock.calls.map((c) => String(c[0])).join('')
    // Progress renderer should NOT be active for JSON output format
    expect(allOutput).not.toContain('substrate run —')
  })

  it('with --output-format json, stdout contains a single JSON success blob at end', async () => {
    const stdoutSpy = vi.spyOn(process.stdout, 'write')

    await runRunAction({
      pack: 'bmad',
      stories: '10-1',
      concurrency: 1,
      outputFormat: 'json',
      projectRoot: '/test/project',
      registry: mockRegistry,
    })

    const allOutput = stdoutSpy.mock.calls.map((c) => String(c[0])).join('')
    const jsonLine = allOutput
      .split('\n')
      .filter((l) => l.includes('"success"'))
      .pop()

    expect(jsonLine).toBeDefined()
    const parsed = JSON.parse(jsonLine!) as { success: boolean; data: unknown }
    expect(parsed.success).toBe(true)
    expect(parsed.data).toHaveProperty('pipelineRunId')
  })
})

// ---------------------------------------------------------------------------
// GAP-3: --help-agent flag registered on CLI `run` subcommand
// ---------------------------------------------------------------------------

describe('GAP-3: --help-agent flag is registered on run command', () => {
  it('run command has --help-agent option registered', () => {
    const program = new Command()
    registerRunCommand(program, '1.0.0', '/test/project')

    const runCmd = program.commands.find((c) => c.name() === 'run')
    expect(runCmd).toBeDefined()

    const helpAgentOpt = runCmd!.options.find((o) => o.long === '--help-agent')
    expect(helpAgentOpt).toBeDefined()
  })

  it('--events flag is registered on run command', () => {
    const program = new Command()
    registerRunCommand(program, '1.0.0', '/test/project')

    const runCmd = program.commands.find((c) => c.name() === 'run')!
    const eventsOpt = runCmd.options.find((o) => o.long === '--events')
    expect(eventsOpt).toBeDefined()
  })

  it('--verbose flag is registered on run command', () => {
    const program = new Command()
    registerRunCommand(program, '1.0.0', '/test/project')

    const runCmd = program.commands.find((c) => c.name() === 'run')!
    const verboseOpt = runCmd.options.find((o) => o.long === '--verbose')
    expect(verboseOpt).toBeDefined()
  })

  it('--tui flag is registered on run command', () => {
    const program = new Command()
    registerRunCommand(program, '1.0.0', '/test/project')

    const runCmd = program.commands.find((c) => c.name() === 'run')!
    const tuiOpt = runCmd.options.find((o) => o.long === '--tui')
    expect(tuiOpt).toBeDefined()
  })
})

// ---------------------------------------------------------------------------
// GAP-4: mapInternalPhaseToEventPhase coverage via event bus wiring
// Tests that internal phase names are correctly mapped to protocol phase names
// ---------------------------------------------------------------------------

describe('GAP-4: Internal phase name -> event protocol phase mapping', () => {
  let stdoutChunks: string[]

  beforeEach(() => {
    vi.clearAllMocks()
    resetEventBusListeners()

    stdoutChunks = []
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
      stdoutChunks.push(chunk.toString())
      return true
    })

    mockExistsSync.mockReturnValue(true)
    mockPackLoad.mockResolvedValue(mockPack())
    mockDiscoverAndRegister.mockResolvedValue(undefined)
    mockCreatePipelineRun.mockReturnValue(mockPipelineRun())
    mockGetTokenUsageSummary.mockReturnValue([])
    mockDiscoverPendingStoryKeys.mockReturnValue([])

    const mockPrepare = vi.fn().mockReturnValue({
      all: vi.fn().mockReturnValue([]),
      get: vi.fn().mockReturnValue(undefined),
    })
    mockDb = { prepare: mockPrepare }
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  const internalToProtocol: Array<[string, string]> = [
    ['IN_STORY_CREATION', 'create-story'],
    ['IN_DEV', 'dev-story'],
    ['IN_REVIEW', 'code-review'],
    ['IN_MINOR_FIX', 'fix'],
    ['IN_MAJOR_FIX', 'fix'],
  ]

  for (const [internalPhase, expectedProtocolPhase] of internalToProtocol) {
    it(`maps '${internalPhase}' to '${expectedProtocolPhase}' in NDJSON output`, async () => {
      mockOrchestratorRun.mockImplementation(async () => {
        const listeners = eventBusListeners['orchestrator:story-phase-complete'] ?? []
        for (const listener of listeners) {
          listener({
            storyKey: '10-1',
            phase: internalPhase,
            result: {},
          })
        }
        return defaultStatus
      })

      await runRunAction({
        pack: 'bmad',
        stories: '10-1',
        concurrency: 1,
        outputFormat: 'human',
        projectRoot: '/test/project',
        events: true,
        registry: mockRegistry,
      })

      const allOutput = stdoutChunks.join('')
      const lines = allOutput.split('\n').filter((l) => l.trim().startsWith('{'))

      const phaseEvents = lines
        .map((l) => JSON.parse(l) as { type: string; phase?: string })
        .filter((e) => e.type === 'story:phase')

      expect(phaseEvents.length).toBeGreaterThanOrEqual(1)
      expect(phaseEvents[0].phase).toBe(expectedProtocolPhase)
    })
  }

  it('unknown internal phase (e.g., UNKNOWN_PHASE) produces no story:phase event', async () => {
    mockOrchestratorRun.mockImplementation(async () => {
      const listeners = eventBusListeners['orchestrator:story-phase-complete'] ?? []
      for (const listener of listeners) {
        listener({
          storyKey: '10-1',
          phase: 'UNKNOWN_INTERNAL_PHASE',
          result: {},
        })
      }
      return defaultStatus
    })

    await runRunAction({
      pack: 'bmad',
      stories: '10-1',
      concurrency: 1,
      outputFormat: 'human',
      projectRoot: '/test/project',
      events: true,
      registry: mockRegistry,
    })

    const allOutput = stdoutChunks.join('')
    const lines = allOutput.split('\n').filter((l) => l.trim().startsWith('{'))

    const phaseEvents = lines
      .map((l) => JSON.parse(l) as { type: string; phase?: string })
      .filter((e) => e.type === 'story:phase')

    // Unknown phase is silently dropped — no story:phase event
    expect(phaseEvents).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// GAP-5: --verbose flag and LOG_LEVEL environment variable
// ---------------------------------------------------------------------------

describe('GAP-5: --verbose flag sets LOG_LEVEL', () => {
  let originalLogLevel: string | undefined
  let stdoutSpy: ReturnType<typeof vi.spyOn>
  let stderrSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    vi.clearAllMocks()
    resetEventBusListeners()

    originalLogLevel = process.env.LOG_LEVEL
    delete process.env.LOG_LEVEL

    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)

    mockExistsSync.mockReturnValue(true)
    mockPackLoad.mockResolvedValue(mockPack())
    mockDiscoverAndRegister.mockResolvedValue(undefined)
    mockCreatePipelineRun.mockReturnValue(mockPipelineRun())
    mockOrchestratorRun.mockResolvedValue(defaultStatus)
    mockGetTokenUsageSummary.mockReturnValue([])
    mockDiscoverPendingStoryKeys.mockReturnValue([])

    const mockPrepare = vi.fn().mockReturnValue({
      all: vi.fn().mockReturnValue([]),
      get: vi.fn().mockReturnValue(undefined),
    })
    mockDb = { prepare: mockPrepare }
  })

  afterEach(() => {
    if (originalLogLevel !== undefined) {
      process.env.LOG_LEVEL = originalLogLevel
    } else {
      delete process.env.LOG_LEVEL
    }
    vi.restoreAllMocks()
  })

  it('without --verbose and without --events, sets LOG_LEVEL to silent', async () => {
    await runRunAction({
      pack: 'bmad',
      stories: '10-1',
      concurrency: 1,
      outputFormat: 'human',
      projectRoot: '/test/project',
      verbose: false,
      events: false,
      registry: mockRegistry,
    })

    expect(process.env.LOG_LEVEL).toBe('silent')
  })

  it('with --verbose, does NOT set LOG_LEVEL to silent', async () => {
    await runRunAction({
      pack: 'bmad',
      stories: '10-1',
      concurrency: 1,
      outputFormat: 'human',
      projectRoot: '/test/project',
      verbose: true,
      events: false,
      registry: mockRegistry,
    })

    // LOG_LEVEL should not be overwritten to 'silent' when --verbose is active
    expect(process.env.LOG_LEVEL).not.toBe('silent')
  })

  it('with --events, does NOT set LOG_LEVEL to silent', async () => {
    await runRunAction({
      pack: 'bmad',
      stories: '10-1',
      concurrency: 1,
      outputFormat: 'human',
      projectRoot: '/test/project',
      events: true,
      verbose: false,
      registry: mockRegistry,
    })

    // LOG_LEVEL should not be overwritten when --events is active
    expect(process.env.LOG_LEVEL).not.toBe('silent')
  })
})

// ---------------------------------------------------------------------------
// GAP-6: pipeline:complete NDJSON contains correct story outcome arrays
// ---------------------------------------------------------------------------

describe('GAP-6: pipeline:complete NDJSON carries correct story outcome arrays', () => {
  let stdoutChunks: string[]

  beforeEach(() => {
    vi.clearAllMocks()
    resetEventBusListeners()

    stdoutChunks = []
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
      stdoutChunks.push(chunk.toString())
      return true
    })

    mockExistsSync.mockReturnValue(true)
    mockPackLoad.mockResolvedValue(mockPack())
    mockDiscoverAndRegister.mockResolvedValue(undefined)
    mockCreatePipelineRun.mockReturnValue(mockPipelineRun())
    mockGetTokenUsageSummary.mockReturnValue([])
    mockDiscoverPendingStoryKeys.mockReturnValue([])

    const mockPrepare = vi.fn().mockReturnValue({
      all: vi.fn().mockReturnValue([]),
      get: vi.fn().mockReturnValue(undefined),
    })
    mockDb = { prepare: mockPrepare }
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('pipeline:complete succeeded array contains story keys with phase=COMPLETE', async () => {
    mockOrchestratorRun.mockResolvedValue({
      state: 'COMPLETE',
      stories: {
        '10-1': { phase: 'COMPLETE', reviewCycles: 1 },
        '10-2': { phase: 'COMPLETE', reviewCycles: 2 },
      },
    })

    await runRunAction({
      pack: 'bmad',
      stories: '10-1,10-2',
      concurrency: 2,
      outputFormat: 'human',
      projectRoot: '/test/project',
      events: true,
      registry: mockRegistry,
    })

    const lines = stdoutChunks.join('').split('\n').filter((l) => l.trim().startsWith('{'))
    const complete = lines
      .map((l) => JSON.parse(l) as { type: string; succeeded?: string[]; failed?: string[]; escalated?: string[] })
      .find((e) => e.type === 'pipeline:complete')

    expect(complete).toBeDefined()
    expect(complete!.succeeded).toContain('10-1')
    expect(complete!.succeeded).toContain('10-2')
    expect(complete!.failed).toHaveLength(0)
    expect(complete!.escalated).toHaveLength(0)
  })

  it('pipeline:complete escalated array contains ESCALATED stories (without error)', async () => {
    mockOrchestratorRun.mockResolvedValue({
      state: 'COMPLETE',
      stories: {
        '10-1': { phase: 'COMPLETE', reviewCycles: 1 },
        '10-2': { phase: 'ESCALATED', reviewCycles: 3 }, // no error => escalated
      },
    })

    await runRunAction({
      pack: 'bmad',
      stories: '10-1,10-2',
      concurrency: 2,
      outputFormat: 'human',
      projectRoot: '/test/project',
      events: true,
      registry: mockRegistry,
    })

    const lines = stdoutChunks.join('').split('\n').filter((l) => l.trim().startsWith('{'))
    const complete = lines
      .map((l) => JSON.parse(l) as { type: string; succeeded?: string[]; failed?: string[]; escalated?: string[] })
      .find((e) => e.type === 'pipeline:complete')

    expect(complete).toBeDefined()
    expect(complete!.succeeded).toContain('10-1')
    expect(complete!.escalated).toContain('10-2')
    expect(complete!.failed).toHaveLength(0)
  })

  it('pipeline:complete failed array contains ESCALATED stories with error field', async () => {
    mockOrchestratorRun.mockResolvedValue({
      state: 'COMPLETE',
      stories: {
        '10-1': { phase: 'ESCALATED', reviewCycles: 0, error: 'Agent crashed' }, // has error => failed
      },
    })

    await runRunAction({
      pack: 'bmad',
      stories: '10-1',
      concurrency: 1,
      outputFormat: 'human',
      projectRoot: '/test/project',
      events: true,
      registry: mockRegistry,
    })

    const lines = stdoutChunks.join('').split('\n').filter((l) => l.trim().startsWith('{'))
    const complete = lines
      .map((l) => JSON.parse(l) as { type: string; succeeded?: string[]; failed?: string[]; escalated?: string[] })
      .find((e) => e.type === 'pipeline:complete')

    expect(complete).toBeDefined()
    expect(complete!.failed).toContain('10-1')
    expect(complete!.succeeded).toHaveLength(0)
    expect(complete!.escalated).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// GAP-7: progressRenderer NOT activated when --output-format json
// And NOT activated when --events is set (already tested in GAP-2)
// ---------------------------------------------------------------------------

describe('GAP-7: progressRenderer only active in default human mode', () => {
  let stdoutChunks: string[]

  beforeEach(() => {
    vi.clearAllMocks()
    resetEventBusListeners()

    stdoutChunks = []
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
      stdoutChunks.push(chunk.toString())
      return true
    })

    mockExistsSync.mockReturnValue(true)
    mockPackLoad.mockResolvedValue(mockPack())
    mockDiscoverAndRegister.mockResolvedValue(undefined)
    mockCreatePipelineRun.mockReturnValue(mockPipelineRun())
    mockOrchestratorRun.mockResolvedValue(defaultStatus)
    mockGetTokenUsageSummary.mockReturnValue([])
    mockDiscoverPendingStoryKeys.mockReturnValue([])

    const mockPrepare = vi.fn().mockReturnValue({
      all: vi.fn().mockReturnValue([]),
      get: vi.fn().mockReturnValue(undefined),
    })
    mockDb = { prepare: mockPrepare }
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('human mode WITHOUT --events writes progress header containing story count', async () => {
    await runRunAction({
      pack: 'bmad',
      stories: '10-1,10-2',
      concurrency: 2,
      outputFormat: 'human',
      projectRoot: '/test/project',
      registry: mockRegistry,
    })

    const allOutput = stdoutChunks.join('')
    // Progress renderer: "substrate run — N stories, concurrency M"
    expect(allOutput).toContain('substrate run —')
    expect(allOutput).toContain('2 stories')
    expect(allOutput).toContain('concurrency 2')
  })

  it('human mode WITHOUT --events writes Pipeline complete summary at end', async () => {
    await runRunAction({
      pack: 'bmad',
      stories: '10-1',
      concurrency: 1,
      outputFormat: 'human',
      projectRoot: '/test/project',
      registry: mockRegistry,
    })

    const allOutput = stdoutChunks.join('')
    expect(allOutput).toContain('Pipeline complete:')
  })

  it('json mode does NOT write progress header', async () => {
    await runRunAction({
      pack: 'bmad',
      stories: '10-1',
      concurrency: 1,
      outputFormat: 'json',
      projectRoot: '/test/project',
      registry: mockRegistry,
    })

    const allOutput = stdoutChunks.join('')
    expect(allOutput).not.toContain('substrate run —')
  })
})

// ---------------------------------------------------------------------------
// GAP-8: TUI is NOT started when --events flag is active
// ---------------------------------------------------------------------------

describe('GAP-8: TUI not started when --events is active', () => {
  let stdoutChunks: string[]

  beforeEach(() => {
    vi.clearAllMocks()
    resetEventBusListeners()

    stdoutChunks = []
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
      stdoutChunks.push(chunk.toString())
      return true
    })

    mockExistsSync.mockReturnValue(true)
    mockPackLoad.mockResolvedValue(mockPack())
    mockDiscoverAndRegister.mockResolvedValue(undefined)
    mockCreatePipelineRun.mockReturnValue(mockPipelineRun())
    mockOrchestratorRun.mockResolvedValue(defaultStatus)
    mockGetTokenUsageSummary.mockReturnValue([])
    mockDiscoverPendingStoryKeys.mockReturnValue([])

    const mockPrepare = vi.fn().mockReturnValue({
      all: vi.fn().mockReturnValue([]),
      get: vi.fn().mockReturnValue(undefined),
    })
    mockDb = { prepare: mockPrepare }
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('with --events active, stdout does NOT contain TUI alt-screen escape codes', async () => {
    await runRunAction({
      pack: 'bmad',
      stories: '10-1',
      concurrency: 1,
      outputFormat: 'human',
      projectRoot: '/test/project',
      events: true,
      tui: true, // Even if --tui is set, --events takes priority
      registry: mockRegistry,
    })

    const allOutput = stdoutChunks.join('')
    // Alt-screen enter code that TUI uses
    expect(allOutput).not.toContain('\x1b[?1049h')
  })

  it('with --output-format json active, stdout does NOT contain TUI alt-screen codes', async () => {
    await runRunAction({
      pack: 'bmad',
      stories: '10-1',
      concurrency: 1,
      outputFormat: 'json',
      projectRoot: '/test/project',
      tui: true, // Even if --tui is set, json format takes priority
      registry: mockRegistry,
    })

    const allOutput = stdoutChunks.join('')
    expect(allOutput).not.toContain('\x1b[?1049h')
  })
})

// ---------------------------------------------------------------------------
// GAP: CLAUDE.md scaffold integration ordering in runAutoInit
// Verify scaffoldClaudeMd is called AFTER pack scaffolding and db init
// ---------------------------------------------------------------------------

describe('CLAUDE.md scaffold is called from runAutoInit (not runRunAction)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetEventBusListeners()

    mockExistsSync.mockReturnValue(true)
    mockPackLoad.mockResolvedValue(mockPack())
    mockDiscoverAndRegister.mockResolvedValue(undefined)
    mockCreatePipelineRun.mockReturnValue(mockPipelineRun())
    mockOrchestratorRun.mockResolvedValue(defaultStatus)
    mockGetTokenUsageSummary.mockReturnValue([])
    mockDiscoverPendingStoryKeys.mockReturnValue([])

    // Template readable, CLAUDE.md does not exist
    mockReadFile.mockImplementation((path: string) => {
      if (String(path).includes('claude-md-substrate-section')) {
        return Promise.resolve('<!-- substrate:start -->\n## Substrate\n<!-- substrate:end -->\n')
      }
      return Promise.reject(new Error('ENOENT'))
    })
    mockWriteFile.mockResolvedValue(undefined)
    mockRequireResolve.mockReturnValue('/fake/node_modules/bmad-method/package.json')
    mockRequireCall.mockReturnValue({ version: '6.0.3' })

    const mockPrepare = vi.fn().mockReturnValue({
      all: vi.fn().mockReturnValue([]),
      get: vi.fn().mockReturnValue(undefined),
      run: vi.fn(),
    })
    mockDb = { prepare: mockPrepare }
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('runRunAction does NOT call writeFile for CLAUDE.md', async () => {
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true)

    await runRunAction({
      pack: 'bmad',
      stories: '10-1',
      concurrency: 1,
      outputFormat: 'human',
      projectRoot: '/test/project',
      registry: mockRegistry,
    })

    // writeFile should NOT be called for CLAUDE.md in a run scenario
    const claudeMdWriteCalls = mockWriteFile.mock.calls.filter(([path]) =>
      String(path).includes('CLAUDE.md'),
    )
    expect(claudeMdWriteCalls).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// Story 16-7 T2/T4: Heartbeat and stall NDJSON wiring
// ---------------------------------------------------------------------------

describe('Story 16-7: Heartbeat and stall NDJSON event wiring (--events mode)', () => {
  let stdoutChunks: string[]

  beforeEach(() => {
    vi.clearAllMocks()
    resetEventBusListeners()

    stdoutChunks = []
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
      stdoutChunks.push(chunk.toString())
      return true
    })

    mockExistsSync.mockReturnValue(true)
    mockPackLoad.mockResolvedValue(mockPack())
    mockDiscoverAndRegister.mockResolvedValue(undefined)
    mockCreatePipelineRun.mockReturnValue(mockPipelineRun())
    mockOrchestratorRun.mockResolvedValue(defaultStatus)
    mockGetTokenUsageSummary.mockReturnValue([])
    mockDiscoverPendingStoryKeys.mockReturnValue([])

    const mockPrepare = vi.fn().mockReturnValue({
      all: vi.fn().mockReturnValue([]),
      get: vi.fn().mockReturnValue(undefined),
    })
    mockDb = { prepare: mockPrepare }
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('T2: pipeline:heartbeat NDJSON emitted when orchestrator:heartbeat fires', async () => {
    mockOrchestratorRun.mockImplementation(async () => {
      const listeners = eventBusListeners['orchestrator:heartbeat'] ?? []
      for (const listener of listeners) {
        listener({
          runId: 'run-uuid-123',
          activeDispatches: 2,
          completedDispatches: 1,
          queuedDispatches: 0,
        })
      }
      return defaultStatus
    })

    await runRunAction({
      pack: 'bmad',
      stories: '10-1',
      concurrency: 1,
      outputFormat: 'human',
      projectRoot: '/test/project',
      events: true,
      registry: mockRegistry,
    })

    const allOutput = stdoutChunks.join('')
    const lines = allOutput.split('\n').filter((l) => l.trim().startsWith('{'))
    const heartbeatEvents = lines
      .map((l) => JSON.parse(l) as {
        type: string
        run_id?: string
        active_dispatches?: number
        completed_dispatches?: number
        queued_dispatches?: number
      })
      .filter((e) => e.type === 'pipeline:heartbeat')

    expect(heartbeatEvents.length).toBeGreaterThanOrEqual(1)
    const hb = heartbeatEvents[0]!
    expect(hb.run_id).toBe('run-uuid-123')
    expect(hb.active_dispatches).toBe(2)
    expect(hb.completed_dispatches).toBe(1)
    expect(hb.queued_dispatches).toBe(0)
  })

  it('T4: story:stall NDJSON emitted when orchestrator:stall fires', async () => {
    mockOrchestratorRun.mockImplementation(async () => {
      const listeners = eventBusListeners['orchestrator:stall'] ?? []
      for (const listener of listeners) {
        listener({
          runId: 'run-uuid-123',
          storyKey: '16-2',
          phase: 'IN_DEV',
          elapsedMs: 660_000,
          childPids: [],
          childActive: false,
        })
      }
      return defaultStatus
    })

    await runRunAction({
      pack: 'bmad',
      stories: '10-1',
      concurrency: 1,
      outputFormat: 'human',
      projectRoot: '/test/project',
      events: true,
      registry: mockRegistry,
    })

    const allOutput = stdoutChunks.join('')
    const lines = allOutput.split('\n').filter((l) => l.trim().startsWith('{'))
    const stallEvents = lines
      .map((l) => JSON.parse(l) as {
        type: string
        run_id?: string
        story_key?: string
        phase?: string
        elapsed_ms?: number
      })
      .filter((e) => e.type === 'story:stall')

    expect(stallEvents.length).toBeGreaterThanOrEqual(1)
    const stall = stallEvents[0]!
    expect(stall.run_id).toBe('run-uuid-123')
    expect(stall.story_key).toBe('16-2')
    expect(stall.phase).toBe('IN_DEV')
    expect(stall.elapsed_ms).toBe(660_000)
  })

  it('T2/T4: heartbeat and stall events are NOT emitted when --events flag is false', async () => {
    mockOrchestratorRun.mockImplementation(async () => {
      // Fire both events
      const heartbeatListeners = eventBusListeners['orchestrator:heartbeat'] ?? []
      for (const listener of heartbeatListeners) {
        listener({ runId: 'run-uuid-123', activeDispatches: 1, completedDispatches: 0, queuedDispatches: 0 })
      }
      const stallListeners = eventBusListeners['orchestrator:stall'] ?? []
      for (const listener of stallListeners) {
        listener({ runId: 'run-uuid-123', storyKey: '10-1', phase: 'IN_DEV', elapsedMs: 660_000, childPids: [], childActive: false })
      }
      return defaultStatus
    })

    // Note: NOT passing events: true
    await runRunAction({
      pack: 'bmad',
      stories: '10-1',
      concurrency: 1,
      outputFormat: 'human',
      projectRoot: '/test/project',
      registry: mockRegistry,
    })

    const allOutput = stdoutChunks.join('')
    const lines = allOutput.split('\n').filter((l) => l.trim().startsWith('{'))
    const jsonEvents = lines.map((l) => {
      try { return JSON.parse(l) as { type: string } } catch { return null }
    }).filter(Boolean)

    const heartbeatEvents = jsonEvents.filter((e) => e!.type === 'pipeline:heartbeat')
    const stallEvents = jsonEvents.filter((e) => e!.type === 'story:stall')
    expect(heartbeatEvents.length).toBe(0)
    expect(stallEvents.length).toBe(0)
  })
})
