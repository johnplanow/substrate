/**
 * End-to-end integration test for the Sprint 2 (28-4/28-5/28-6) routing pipeline.
 *
 * Wires REAL instances of:
 *   RoutingResolver → Dispatcher → EventBus → RoutingTokenAccumulator → FileStateStore
 *
 * Verifies the full chain:
 *  1. Config YAML loaded → RoutingResolver resolves model per task type
 *  2. Dispatcher consults resolver and emits `routing:model-selected` event
 *  3. RoutingTokenAccumulator receives events via EventBus subscription
 *  4. On `agent:completed`, tokens are attributed to the correct phase bucket
 *  5. flush() persists PhaseTokenBreakdown to StateStore
 *  6. StateStore.getMetric() returns the breakdown with correct structure
 *
 * Also covers:
 *  - `agent:completed` event includes inputTokens/outputTokens fields
 *  - Fallback mode (no routing config) — dispatcher works, no routing events emitted
 *  - RoutingTelemetry emits spans when telemetry persistence is available
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import type { ChildProcess } from 'node:child_process'

import { createEventBus } from '../core/event-bus.js'
import type { TypedEventBus } from '../core/event-bus.js'
import { RoutingResolver } from '../modules/routing/model-routing-resolver.js'
import { RoutingTokenAccumulator } from '../modules/routing/routing-token-accumulator.js'
import { RoutingTelemetry } from '../modules/routing/routing-telemetry.js'
import { loadModelRoutingConfig } from '../modules/routing/model-routing-config.js'
import type { ModelRoutingConfig } from '../modules/routing/model-routing-config.js'
import { FileStateStore } from '../modules/state/file-store.js'
import { createDispatcher } from '../modules/agent-dispatch/dispatcher-impl.js'
import type { AdapterRegistry } from '../adapters/adapter-registry.js'
import type { WorkerAdapter } from '../adapters/worker-adapter.js'
import type { SpawnCommand, AdapterOptions, TaskResult } from '../adapters/types.js'
import type { PhaseTokenBreakdown } from '../modules/routing/types.js'

// ---------------------------------------------------------------------------
// Mock child_process — no real subprocesses
// ---------------------------------------------------------------------------

type FakeProcess = {
  proc: ChildProcess
  stdout: PassThrough
  emitClose: (code: number) => void
}

function createFakeProcess(): FakeProcess {
  const emitter = new EventEmitter()
  const stdin = new PassThrough()
  const stdout = new PassThrough()
  const stderr = new PassThrough()
  const proc = Object.assign(emitter, {
    stdin,
    stdout,
    stderr,
    kill: vi.fn(),
    pid: 99999,
  }) as unknown as ChildProcess
  const emitClose = (code: number) => emitter.emit('close', code)
  return { proc, stdout, emitClose }
}

const fakeProcesses: FakeProcess[] = []
let nextFakeProcessIndex = 0

vi.mock('node:child_process', () => ({
  spawn: vi.fn(() => {
    const fp = fakeProcesses[nextFakeProcessIndex++]
    return fp ? fp.proc : createFakeProcess().proc
  }),
  execSync: vi.fn(),
}))

// Report abundant free memory so memory-pressure gate never blocks
vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof import('node:os')>('node:os')
  return { ...actual, freemem: vi.fn(() => 4 * 1024 * 1024 * 1024), platform: vi.fn(() => 'linux') }
})

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

function createMockLogger() {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
    trace: vi.fn(),
    silent: vi.fn(),
    child: vi.fn().mockReturnThis(),
    level: 'debug',
  } as never
}

function createMockAdapter(id = 'claude-code'): WorkerAdapter {
  return {
    id,
    displayName: 'Claude Code',
    adapterVersion: '1.0.0',
    buildCommand: vi.fn((_prompt: string, _options: AdapterOptions): SpawnCommand => ({
      binary: 'claude',
      args: ['--print'],
      cwd: _options.worktreePath,
    })),
    parseOutput: vi.fn((_stdout: string, _stderr: string, _exitCode: number): TaskResult => ({
      success: _exitCode === 0,
      output: _stdout,
      exitCode: _exitCode,
    })),
    buildPlanningCommand: vi.fn(),
    parsePlanOutput: vi.fn(),
    estimateTokens: vi.fn(() => ({ input: 10, output: 5, total: 15 })),
    healthCheck: vi.fn(async () => ({ healthy: true, supportsHeadless: true })),
    getCapabilities: vi.fn(() => ({
      supportsJsonOutput: false,
      supportsStreaming: false,
      supportsSubscriptionBilling: true,
      supportsApiBilling: false,
      supportsPlanGeneration: false,
      maxContextTokens: 100_000,
      supportedTaskTypes: ['dev-story', 'code-review', 'create-story', 'explore'],
      supportedLanguages: ['*'],
    })),
  }
}

function createMockRegistry(adapters: WorkerAdapter[] = []): AdapterRegistry {
  const map = new Map<string, WorkerAdapter>(adapters.map((a) => [a.id, a]))
  return {
    get: vi.fn((id: string) => map.get(id)),
    register: vi.fn(),
    getAll: vi.fn(() => Array.from(map.values())),
    getPlanningCapable: vi.fn(() => []),
    discoverAndRegister: vi.fn(async () => ({
      registeredCount: 0,
      failedCount: 0,
      results: [],
    })),
  } as unknown as AdapterRegistry
}

// ---------------------------------------------------------------------------
// Fixture: write a real substrate.routing.yml to a temp dir
// ---------------------------------------------------------------------------

const ROUTING_YAML = `
version: 1
baseline_model: claude-sonnet-4-5
phases:
  explore:
    model: claude-haiku-4-5
  generate:
    model: claude-sonnet-4-5
    max_tokens: 8192
  review:
    model: claude-sonnet-4-5
overrides:
  dev-story:
    model: claude-opus-4-6
`

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Routing Pipeline E2E — Config → Resolver → Dispatcher → Accumulator → StateStore', () => {
  let tmpDir: string
  let configPath: string
  let routingConfig: ModelRoutingConfig

  beforeEach(() => {
    fakeProcesses.length = 0
    nextFakeProcessIndex = 0
    vi.clearAllMocks()

    // Write real config YAML to temp dir
    tmpDir = join(tmpdir(), `substrate-routing-e2e-${randomUUID()}`)
    mkdirSync(tmpDir, { recursive: true })
    configPath = join(tmpDir, 'substrate.routing.yml')
    writeFileSync(configPath, ROUTING_YAML, 'utf-8')
    routingConfig = loadModelRoutingConfig(configPath)
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('full pipeline: dispatch → routing event → accumulator → flush → StateStore', async () => {
    // --- Wire all components with REAL EventBus ---
    const eventBus = createEventBus()
    const logger = createMockLogger()
    const adapter = createMockAdapter()
    const registry = createMockRegistry([adapter])
    const stateStore = new FileStateStore()

    // Create resolver from the real config
    const resolver = new RoutingResolver(routingConfig, logger)

    // Create accumulator and subscribe to EventBus
    const accumulator = new RoutingTokenAccumulator(routingConfig, stateStore, logger)
    eventBus.on('routing:model-selected', (payload) => {
      accumulator.onRoutingSelected({
        dispatchId: payload.dispatchId,
        phase: payload.phase,
        model: payload.model,
      })
    })
    eventBus.on('agent:completed', (payload) => {
      accumulator.onAgentCompleted({
        dispatchId: payload.dispatchId,
        inputTokens: payload.inputTokens ?? 0,
        outputTokens: payload.outputTokens ?? 0,
      })
    })

    // Create dispatcher with real resolver
    const dispatcher = createDispatcher({
      eventBus,
      adapterRegistry: registry,
      config: { routingResolver: resolver },
    })

    // --- Dispatch a dev-story task ---
    const fp = createFakeProcess()
    fakeProcesses.push(fp)

    const handle = dispatcher.dispatch({
      prompt: 'Implement feature X',
      agent: 'claude-code',
      taskType: 'dev-story',
    })

    await flushMicrotasks()
    fp.emitClose(0)
    await handle.result

    // --- Flush accumulator ---
    const runId = 'run-e2e-test-1'
    await accumulator.flush(runId)

    // --- Verify StateStore has the breakdown ---
    const raw = await stateStore.getMetric(runId, 'phase_token_breakdown')
    expect(raw).toBeDefined()

    const breakdown = raw as PhaseTokenBreakdown
    expect(breakdown.runId).toBe(runId)
    expect(breakdown.baselineModel).toBe('claude-sonnet-4-5')
    expect(breakdown.entries).toHaveLength(1)

    // dev-story should resolve via the override → claude-opus-4-6
    const entry = breakdown.entries[0]
    expect(entry.phase).toBe('generate')
    expect(entry.model).toBe('claude-opus-4-6')
    expect(entry.dispatchCount).toBe(1)
    expect(entry.inputTokens).toBeGreaterThanOrEqual(0)
    expect(entry.outputTokens).toBeGreaterThanOrEqual(0)
  })

  it('multiple dispatches across phases aggregate correctly', async () => {
    const eventBus = createEventBus()
    const logger = createMockLogger()
    const adapter = createMockAdapter()
    const registry = createMockRegistry([adapter])
    const stateStore = new FileStateStore()
    const resolver = new RoutingResolver(routingConfig, logger)
    const accumulator = new RoutingTokenAccumulator(routingConfig, stateStore, logger)

    eventBus.on('routing:model-selected', (payload) => {
      accumulator.onRoutingSelected({
        dispatchId: payload.dispatchId,
        phase: payload.phase,
        model: payload.model,
      })
    })
    eventBus.on('agent:completed', (payload) => {
      accumulator.onAgentCompleted({
        dispatchId: payload.dispatchId,
        inputTokens: payload.inputTokens ?? 0,
        outputTokens: payload.outputTokens ?? 0,
      })
    })

    const dispatcher = createDispatcher({
      eventBus,
      adapterRegistry: registry,
      config: { routingResolver: resolver },
    })

    // Dispatch 1: code-review → review phase → claude-sonnet-4-5
    const fp1 = createFakeProcess()
    fakeProcesses.push(fp1)
    const h1 = dispatcher.dispatch({
      prompt: 'Review code',
      agent: 'claude-code',
      taskType: 'code-review',
    })
    await flushMicrotasks()
    fp1.emitClose(0)
    await h1.result

    // Dispatch 2: dev-story → override → claude-opus-4-6
    const fp2 = createFakeProcess()
    fakeProcesses.push(fp2)
    const h2 = dispatcher.dispatch({
      prompt: 'Implement feature Y',
      agent: 'claude-code',
      taskType: 'dev-story',
    })
    await flushMicrotasks()
    fp2.emitClose(0)
    await h2.result

    // Dispatch 3: another dev-story → same bucket as dispatch 2
    const fp3 = createFakeProcess()
    fakeProcesses.push(fp3)
    const h3 = dispatcher.dispatch({
      prompt: 'Implement feature Z',
      agent: 'claude-code',
      taskType: 'dev-story',
    })
    await flushMicrotasks()
    fp3.emitClose(0)
    await h3.result

    const runId = 'run-multi-phase'
    await accumulator.flush(runId)

    const raw = await stateStore.getMetric(runId, 'phase_token_breakdown')
    const breakdown = raw as PhaseTokenBreakdown

    expect(breakdown.entries.length).toBe(2) // review + generate(override)
    const phases = breakdown.entries.map(e => `${e.phase}::${e.model}`).sort()
    expect(phases).toEqual(['generate::claude-opus-4-6', 'review::claude-sonnet-4-5'])

    // dev-story dispatched twice → dispatchCount should be 2
    const genEntry = breakdown.entries.find(e => e.phase === 'generate')!
    expect(genEntry.dispatchCount).toBe(2)

    // code-review dispatched once
    const reviewEntry = breakdown.entries.find(e => e.phase === 'review')!
    expect(reviewEntry.dispatchCount).toBe(1)
  })

  it('agent:completed event includes inputTokens and outputTokens fields', async () => {
    const eventBus = createEventBus()
    const logger = createMockLogger()
    const adapter = createMockAdapter()
    const registry = createMockRegistry([adapter])
    const resolver = new RoutingResolver(routingConfig, logger)

    const dispatcher = createDispatcher({
      eventBus,
      adapterRegistry: registry,
      config: { routingResolver: resolver },
    })

    // Capture agent:completed events
    const completedEvents: Array<Record<string, unknown>> = []
    eventBus.on('agent:completed', (payload) => {
      completedEvents.push(payload as unknown as Record<string, unknown>)
    })

    const fp = createFakeProcess()
    fakeProcesses.push(fp)

    const handle = dispatcher.dispatch({
      prompt: 'Test',
      agent: 'claude-code',
      taskType: 'dev-story',
    })

    await flushMicrotasks()
    fp.emitClose(0)
    await handle.result

    expect(completedEvents).toHaveLength(1)
    expect(completedEvents[0]).toHaveProperty('dispatchId')
    expect(completedEvents[0]).toHaveProperty('inputTokens')
    expect(completedEvents[0]).toHaveProperty('outputTokens')
    expect(typeof completedEvents[0].inputTokens).toBe('number')
    expect(typeof completedEvents[0].outputTokens).toBe('number')
  })

  it('routing:model-selected event carries correct phase and model for override', async () => {
    const eventBus = createEventBus()
    const logger = createMockLogger()
    const adapter = createMockAdapter()
    const registry = createMockRegistry([adapter])
    const resolver = new RoutingResolver(routingConfig, logger)

    const dispatcher = createDispatcher({
      eventBus,
      adapterRegistry: registry,
      config: { routingResolver: resolver },
    })

    const routingEvents: Array<Record<string, unknown>> = []
    eventBus.on('routing:model-selected', (payload) => {
      routingEvents.push(payload as unknown as Record<string, unknown>)
    })

    const fp = createFakeProcess()
    fakeProcesses.push(fp)
    dispatcher.dispatch({ prompt: 'Go', agent: 'claude-code', taskType: 'dev-story' })
    await flushMicrotasks()
    fp.emitClose(0)

    expect(routingEvents).toHaveLength(1)
    expect(routingEvents[0].model).toBe('claude-opus-4-6')
    expect(routingEvents[0].phase).toBe('generate')
    expect(routingEvents[0].source).toBe('override')
    expect(routingEvents[0].taskType).toBe('dev-story')
    expect(routingEvents[0].dispatchId).toBeDefined()
  })

  it('RoutingTelemetry emits OTEL span on routing:model-selected', async () => {
    const eventBus = createEventBus()
    const logger = createMockLogger()
    const adapter = createMockAdapter()
    const registry = createMockRegistry([adapter])
    const resolver = new RoutingResolver(routingConfig, logger)

    // Mock telemetry persistence
    const mockTelemetryPersistence = { recordSpan: vi.fn() }
    const routingTelemetry = new RoutingTelemetry(
      mockTelemetryPersistence as never,
      logger,
    )

    // Wire telemetry to event bus (mirrors run.ts wiring)
    eventBus.on('routing:model-selected', (payload) => {
      routingTelemetry.recordModelResolved({
        dispatchId: payload.dispatchId,
        taskType: payload.taskType,
        phase: payload.phase,
        model: payload.model,
        source: payload.source,
        latencyMs: 0,
      })
    })

    const dispatcher = createDispatcher({
      eventBus,
      adapterRegistry: registry,
      config: { routingResolver: resolver },
    })

    const fp = createFakeProcess()
    fakeProcesses.push(fp)
    dispatcher.dispatch({ prompt: 'Go', agent: 'claude-code', taskType: 'code-review' })
    await flushMicrotasks()
    fp.emitClose(0)

    expect(mockTelemetryPersistence.recordSpan).toHaveBeenCalledOnce()
    expect(mockTelemetryPersistence.recordSpan).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'routing.model_resolved',
        attributes: expect.objectContaining({
          taskType: 'code-review',
          phase: 'review',
          model: 'claude-sonnet-4-5',
          source: 'phase',
        }),
      }),
    )
  })
})

describe('Routing Pipeline E2E — Fallback mode (no config)', () => {
  beforeEach(() => {
    fakeProcesses.length = 0
    nextFakeProcessIndex = 0
    vi.clearAllMocks()
  })

  it('dispatcher works without resolver — no routing events, no crash', async () => {
    const eventBus = createEventBus()
    const adapter = createMockAdapter()
    const registry = createMockRegistry([adapter])

    // No resolver provided — fallback mode
    const dispatcher = createDispatcher({
      eventBus,
      adapterRegistry: registry,
    })

    const routingEvents: unknown[] = []
    eventBus.on('routing:model-selected', (payload) => routingEvents.push(payload))

    const fp = createFakeProcess()
    fakeProcesses.push(fp)

    const handle = dispatcher.dispatch({
      prompt: 'Hello',
      agent: 'claude-code',
      taskType: 'dev-story',
    })

    await flushMicrotasks()
    fp.emitClose(0)
    await handle.result

    // No routing events should be emitted
    expect(routingEvents).toHaveLength(0)
  })

  it('resolver in fallback mode (missing config) returns null — dispatcher uses adapter default', async () => {
    const logger = createMockLogger()
    // createWithFallback on a non-existent path → fallback resolver
    const resolver = RoutingResolver.createWithFallback('/nonexistent/routing.yml', logger)

    const eventBus = createEventBus()
    const adapter = createMockAdapter()
    const registry = createMockRegistry([adapter])

    const dispatcher = createDispatcher({
      eventBus,
      adapterRegistry: registry,
      config: { routingResolver: resolver },
    })

    const routingEvents: unknown[] = []
    eventBus.on('routing:model-selected', (payload) => routingEvents.push(payload))

    const fp = createFakeProcess()
    fakeProcesses.push(fp)

    const handle = dispatcher.dispatch({
      prompt: 'Hello',
      agent: 'claude-code',
      taskType: 'dev-story',
    })

    await flushMicrotasks()
    fp.emitClose(0)
    await handle.result

    // Resolver returned null → no routing event emitted
    expect(routingEvents).toHaveLength(0)

    // buildCommand should have been called without a model key
    const callArgs = vi.mocked(adapter.buildCommand).mock.calls[0] as [string, AdapterOptions]
    expect(callArgs[1]).not.toHaveProperty('model')
  })

  it('accumulator gracefully handles flush with no routing events (empty breakdown)', async () => {
    const logger = createMockLogger()
    const stateStore = new FileStateStore()
    const config: ModelRoutingConfig = {
      version: 1,
      phases: {},
      baseline_model: '',
    }
    const accumulator = new RoutingTokenAccumulator(config, stateStore, logger)

    await accumulator.flush('run-empty')

    const raw = await stateStore.getMetric('run-empty', 'phase_token_breakdown')
    const breakdown = raw as PhaseTokenBreakdown
    expect(breakdown.entries).toHaveLength(0)
    expect(breakdown.runId).toBe('run-empty')
  })
})

describe('Routing Pipeline E2E — FileStateStore kv-metrics persistence', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = join(tmpdir(), `substrate-kv-e2e-${randomUUID()}`)
    mkdirSync(tmpDir, { recursive: true })
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('phase_token_breakdown persists to kv-metrics.json and survives new FileStateStore instance', async () => {
    const logger = createMockLogger()
    const config: ModelRoutingConfig = {
      version: 1,
      phases: { generate: { model: 'claude-sonnet-4-5' } },
      baseline_model: 'claude-sonnet-4-5',
    }

    // Store 1: write breakdown
    const store1 = new FileStateStore({ basePath: tmpDir })
    const accumulator = new RoutingTokenAccumulator(config, store1, logger)
    accumulator.onRoutingSelected({ dispatchId: 'd1', phase: 'generate', model: 'claude-sonnet-4-5' })
    accumulator.onAgentCompleted({ dispatchId: 'd1', inputTokens: 500, outputTokens: 200 })
    await accumulator.flush('run-persist')

    // Store 2: new instance reading from same basePath
    const store2 = new FileStateStore({ basePath: tmpDir })
    const raw = await store2.getMetric('run-persist', 'phase_token_breakdown')

    expect(raw).toBeDefined()
    const breakdown = raw as PhaseTokenBreakdown
    expect(breakdown.runId).toBe('run-persist')
    expect(breakdown.entries).toHaveLength(1)
    expect(breakdown.entries[0].inputTokens).toBe(500)
    expect(breakdown.entries[0].outputTokens).toBe(200)
  })
})
