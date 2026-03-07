/**
 * Integration test for Story 24-4 AC8: story:metrics NDJSON event wire format.
 *
 * Verifies that when the 'story:metrics' event is emitted on the event bus,
 * it produces a correctly-structured NDJSON line on stdout in --events mode.
 *
 * Follows the pattern from epic-15-event-flow.integration.test.ts.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// ---------------------------------------------------------------------------
// Mocks — all declared before imports (vitest hoisting)
// ---------------------------------------------------------------------------

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
const mockWriteFileSync = vi.fn()
const mockUnlinkSync = vi.fn()
vi.mock('fs', () => ({
  existsSync: (...args: unknown[]) => mockExistsSync(...args),
  mkdirSync: (...args: unknown[]) => mockMkdirSync(...args),
  writeFileSync: (...args: unknown[]) => mockWriteFileSync(...args),
  unlinkSync: (...args: unknown[]) => mockUnlinkSync(...args),
}))

const mockReadFile = vi.fn()
vi.mock('fs/promises', () => ({
  readFile: (...args: unknown[]) => mockReadFile(...args),
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
  resolveMainRepoRoot: (root: string) => mockResolveMainRepoRoot(root),
}))

vi.mock('../../../modules/stop-after/index.js', () => ({
  VALID_PHASES: ['analysis', 'planning', 'solutioning', 'implementation'],
  createStopAfterGate: vi.fn(() => ({ shouldHalt: () => false })),
  validateStopAfterFromConflict: vi.fn(() => ({ valid: true })),
  formatPhaseCompletionSummary: vi.fn(() => ''),
}))

// ---------------------------------------------------------------------------
// Import module under test AFTER mocks
// ---------------------------------------------------------------------------

import { runRunAction } from '../run.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mockPipelineRun() {
  return {
    id: 'run-uuid-metrics',
    methodology: 'bmad',
    current_phase: 'implementation',
    status: 'running',
    config_json: null,
    token_usage_json: null,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:01:00Z',
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
  stories: { '24-4': { phase: 'COMPLETE', reviewCycles: 1 } },
  startedAt: '2026-01-01T00:00:00Z',
  completedAt: '2026-01-01T00:01:00Z',
  totalDurationMs: 60000,
}

function resetEventBusListeners() {
  for (const key of Object.keys(eventBusListeners)) {
    delete eventBusListeners[key]
  }
}

const mockRegistry = {
  discoverAndRegister: vi.fn().mockResolvedValue({ results: [], failedCount: 0 }),
} as any

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('AC8: story:metrics NDJSON wire format in --events mode', () => {
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

  it('story:metrics NDJSON event is emitted to stdout when orchestrator fires story:metrics', async () => {
    // Arrange: orchestrator fires the story:metrics event during its run
    mockOrchestratorRun.mockImplementation(async () => {
      const listeners = eventBusListeners['story:metrics'] ?? []
      for (const listener of listeners) {
        listener({
          storyKey: '24-4',
          wallClockMs: 42500,
          phaseBreakdown: { dev: 30000, review: 12500 },
          tokens: { input: 5000, output: 2000 },
          reviewCycles: 1,
          dispatches: 2,
        })
      }
      return defaultStatus
    })

    await runRunAction({
      pack: 'bmad',
      stories: '24-4',
      concurrency: 1,
      outputFormat: 'human',
      projectRoot: '/test/project',
      events: true,
      registry: mockRegistry,
    })

    const allOutput = stdoutChunks.join('')
    const lines = allOutput.split('\n').filter((l) => l.trim().startsWith('{'))

    const metricsEvents = lines
      .map((l) => JSON.parse(l) as Record<string, unknown>)
      .filter((e) => e.type === 'story:metrics')

    expect(metricsEvents.length).toBeGreaterThanOrEqual(1)

    const evt = metricsEvents[0]!
    expect(evt.type).toBe('story:metrics')
    expect(evt.storyKey).toBe('24-4')
    expect(evt.wallClockMs).toBe(42500)
    expect(evt.phaseBreakdown).toEqual({ dev: 30000, review: 12500 })
    expect(evt.tokens).toEqual({ input: 5000, output: 2000 })
    expect(evt.reviewCycles).toBe(1)
    expect(evt.dispatches).toBe(2)
    // ts must be a valid ISO timestamp
    expect(typeof evt.ts).toBe('string')
    expect(() => new Date(evt.ts as string).toISOString()).not.toThrow()
  })

  it('story:metrics event is NOT emitted when --events flag is not set', async () => {
    let storyMetricsEmitterFired = false

    mockOrchestratorRun.mockImplementation(async () => {
      // Check if the event listener was registered
      storyMetricsEmitterFired = (eventBusListeners['story:metrics'] ?? []).length > 0
      return defaultStatus
    })

    await runRunAction({
      pack: 'bmad',
      stories: '24-4',
      concurrency: 1,
      outputFormat: 'human',
      projectRoot: '/test/project',
      events: false,
      registry: mockRegistry,
    })

    // Without --events, no NDJSON listener should be registered
    expect(storyMetricsEmitterFired).toBe(false)
  })

  it('story:metrics event fields match StoryMetricsEvent interface', async () => {
    mockOrchestratorRun.mockImplementation(async () => {
      const listeners = eventBusListeners['story:metrics'] ?? []
      for (const listener of listeners) {
        listener({
          storyKey: '24-4',
          wallClockMs: 1000,
          phaseBreakdown: {},
          tokens: { input: 100, output: 50 },
          reviewCycles: 0,
          dispatches: 1,
        })
      }
      return defaultStatus
    })

    await runRunAction({
      pack: 'bmad',
      stories: '24-4',
      concurrency: 1,
      outputFormat: 'human',
      projectRoot: '/test/project',
      events: true,
      registry: mockRegistry,
    })

    const allOutput = stdoutChunks.join('')
    const lines = allOutput.split('\n').filter((l) => l.trim().startsWith('{'))
    const metricsEvents = lines
      .map((l) => JSON.parse(l) as Record<string, unknown>)
      .filter((e) => e.type === 'story:metrics')

    expect(metricsEvents).toHaveLength(1)
    const evt = metricsEvents[0]!

    // All 7 required fields must be present (type, ts, storyKey, wallClockMs,
    // phaseBreakdown, tokens, reviewCycles, dispatches = 8 fields total)
    const fieldNames = Object.keys(evt)
    expect(fieldNames).toContain('type')
    expect(fieldNames).toContain('ts')
    expect(fieldNames).toContain('storyKey')
    expect(fieldNames).toContain('wallClockMs')
    expect(fieldNames).toContain('phaseBreakdown')
    expect(fieldNames).toContain('tokens')
    expect(fieldNames).toContain('reviewCycles')
    expect(fieldNames).toContain('dispatches')
  })
})
