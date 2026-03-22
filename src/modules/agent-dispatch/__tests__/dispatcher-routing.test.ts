/**
 * Tests for RoutingResolver integration in DispatcherImpl (Story 28-5).
 *
 * Verifies that:
 * - AC1: backward compat — dispatcher without resolver works normally
 * - AC2: resolver is consulted and resolved model is passed to buildCommand
 * - AC3: explicit request.model overrides the resolver
 * - AC4: resolver returning null → buildCommand called without model
 * - AC5: routing:model-selected event emitted when resolver returns non-null
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import type { ChildProcess } from 'node:child_process'
import type { TypedEventBus } from '../../../core/event-bus.js'
import type { AdapterRegistry } from '../../../adapters/adapter-registry.js'
import type { WorkerAdapter } from '../../../adapters/worker-adapter.js'
import type {
  SpawnCommand,
  AdapterOptions,
  AdapterCapabilities,
  AdapterHealthResult,
  TaskResult,
  TokenEstimate,
  PlanRequest,
  PlanParseResult,
} from '../../../adapters/types.js'
import { createDispatcher } from '../dispatcher-impl.js'

// ---------------------------------------------------------------------------
// Mock child_process.spawn so no real subprocesses are spawned
// ---------------------------------------------------------------------------

type FakeProcess = {
  proc: ChildProcess
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
  return { proc, emitClose }
}

const fakeProcesses: FakeProcess[] = []
let nextFakeProcessIndex = 0

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return {
    ...actual,
    spawn: vi.fn(() => {
      const fp = fakeProcesses[nextFakeProcessIndex]
      nextFakeProcessIndex++
      if (fp === undefined) {
        return createFakeProcess().proc
      }
      return fp.proc
    }),
    execSync: vi.fn(),
  }
})

// Report abundant free memory so memory-pressure circuit breaker never blocks
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

type MockEventBus = TypedEventBus & {
  emittedEvents: Array<{ event: string; payload: unknown }>
}

function createMockEventBus(): MockEventBus {
  const emittedEvents: Array<{ event: string; payload: unknown }> = []
  return {
    emittedEvents,
    emit: vi.fn((event: string, payload: unknown) => {
      emittedEvents.push({ event, payload })
    }) as TypedEventBus['emit'],
    on: vi.fn() as TypedEventBus['on'],
    off: vi.fn() as TypedEventBus['off'],
  }
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
    buildPlanningCommand: vi.fn(
      (_request: PlanRequest, _options: AdapterOptions): SpawnCommand => ({
        binary: 'claude',
        args: ['--print', _request.goal],
        cwd: _options.worktreePath,
      })
    ),
    parsePlanOutput: vi.fn(
      (_stdout: string, _stderr: string, _exitCode: number): PlanParseResult => ({
        success: true,
        tasks: [],
      })
    ),
    estimateTokens: vi.fn(
      (_prompt: string): TokenEstimate => ({ input: 10, output: 5, total: 15 })
    ),
    healthCheck: vi.fn(
      async (): Promise<AdapterHealthResult> => ({ healthy: true, supportsHeadless: true })
    ),
    getCapabilities: vi.fn(
      (): AdapterCapabilities => ({
        supportsJsonOutput: false,
        supportsStreaming: false,
        supportsSubscriptionBilling: true,
        supportsApiBilling: false,
        supportsPlanGeneration: false,
        maxContextTokens: 100_000,
        supportedTaskTypes: ['dev-story', 'code-review'],
        supportedLanguages: ['*'],
      })
    ),
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
// Tests
// ---------------------------------------------------------------------------

describe('DispatcherImpl — RoutingResolver integration (Story 28-5)', () => {
  beforeEach(() => {
    fakeProcesses.length = 0
    nextFakeProcessIndex = 0
    vi.clearAllMocks()
  })

  it('AC1: backward compat — dispatcher without resolver dispatches without error and no routing event', async () => {
    const fp = createFakeProcess()
    fakeProcesses.push(fp)

    const eventBus = createMockEventBus()
    const adapter = createMockAdapter()
    const registry = createMockRegistry([adapter])

    // No routingResolver provided
    const dispatcher = createDispatcher({ eventBus, adapterRegistry: registry })

    const handle = dispatcher.dispatch({
      prompt: 'Hello',
      agent: 'claude-code',
      taskType: 'dev-story',
    })

    await flushMicrotasks()
    fp.emitClose(0)

    await handle.result

    // No routing:model-selected event should be emitted
    const routingEvents = eventBus.emittedEvents.filter((e) => e.event === 'routing:model-selected')
    expect(routingEvents).toHaveLength(0)

    // Dispatcher should still have dispatched (agent:spawned emitted)
    const spawnedEvents = eventBus.emittedEvents.filter((e) => e.event === 'agent:spawned')
    expect(spawnedEvents).toHaveLength(1)
  })

  it('AC2: resolver configured for dev-story — resolved model passed to buildCommand', async () => {
    const fp = createFakeProcess()
    fakeProcesses.push(fp)

    const eventBus = createMockEventBus()
    const adapter = createMockAdapter()
    const registry = createMockRegistry([adapter])

    const stubResolver = {
      resolveModel: vi.fn(() => ({
        model: 'claude-haiku-3-5',
        phase: 'generate',
        source: 'phase' as const,
      })),
    }

    const dispatcher = createDispatcher({
      eventBus,
      adapterRegistry: registry,
      config: { routingResolver: stubResolver as never },
    })

    dispatcher.dispatch({
      prompt: 'Hello',
      agent: 'claude-code',
      taskType: 'dev-story',
    })

    await flushMicrotasks()
    fp.emitClose(0)

    // Verify resolveModel was called with taskType
    expect(stubResolver.resolveModel).toHaveBeenCalledWith('dev-story')

    // Verify buildCommand received the resolved model
    expect(adapter.buildCommand).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ model: 'claude-haiku-3-5' })
    )
  })

  it('AC3: explicit request.model overrides resolver — resolver NOT called', async () => {
    const fp = createFakeProcess()
    fakeProcesses.push(fp)

    const eventBus = createMockEventBus()
    const adapter = createMockAdapter()
    const registry = createMockRegistry([adapter])

    const stubResolver = {
      resolveModel: vi.fn(() => ({
        model: 'claude-haiku-3-5',
        phase: 'generate',
        source: 'phase' as const,
      })),
    }

    const dispatcher = createDispatcher({
      eventBus,
      adapterRegistry: registry,
      config: { routingResolver: stubResolver as never },
    })

    dispatcher.dispatch({
      prompt: 'Hello',
      agent: 'claude-code',
      taskType: 'dev-story',
      model: 'override-model',
    })

    await flushMicrotasks()
    fp.emitClose(0)

    // resolveModel should NOT be called because explicit model was set
    expect(stubResolver.resolveModel).not.toHaveBeenCalled()

    // buildCommand should receive the override model
    expect(adapter.buildCommand).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ model: 'override-model' })
    )
  })

  it('AC4: resolver returning null — buildCommand called without model key', async () => {
    const fp = createFakeProcess()
    fakeProcesses.push(fp)

    const eventBus = createMockEventBus()
    const adapter = createMockAdapter()
    const registry = createMockRegistry([adapter])

    const stubResolver = {
      resolveModel: vi.fn(() => null),
    }

    const dispatcher = createDispatcher({
      eventBus,
      adapterRegistry: registry,
      config: { routingResolver: stubResolver as never },
    })

    dispatcher.dispatch({
      prompt: 'Hello',
      agent: 'claude-code',
      taskType: 'dev-story',
    })

    await flushMicrotasks()
    fp.emitClose(0)

    // resolveModel should have been called
    expect(stubResolver.resolveModel).toHaveBeenCalledWith('dev-story')

    // buildCommand should NOT receive a model key
    const callArgs = (adapter.buildCommand as ReturnType<typeof vi.fn>).mock.calls[0] as [string, AdapterOptions]
    expect(callArgs[1]).not.toHaveProperty('model')
  })

  it('AC5: routing:model-selected emitted when resolver returns non-null; NOT emitted on fallback', async () => {
    // First dispatch: resolver returns a model → event emitted
    const fp1 = createFakeProcess()
    fakeProcesses.push(fp1)

    const eventBus = createMockEventBus()
    const adapter = createMockAdapter()
    const registry = createMockRegistry([adapter])

    const stubResolver = {
      resolveModel: vi.fn(() => ({
        model: 'claude-haiku-3-5',
        phase: 'generate',
        source: 'phase' as const,
      })),
    }

    const dispatcher = createDispatcher({
      eventBus,
      adapterRegistry: registry,
      config: { routingResolver: stubResolver as never },
    })

    const handle1 = dispatcher.dispatch({
      prompt: 'Hello',
      agent: 'claude-code',
      taskType: 'dev-story',
    })

    await flushMicrotasks()
    fp1.emitClose(0)
    await handle1.result

    const routingEvents = eventBus.emittedEvents.filter((e) => e.event === 'routing:model-selected')
    expect(routingEvents).toHaveLength(1)
    expect(routingEvents[0]?.payload).toMatchObject({
      taskType: 'dev-story',
      model: 'claude-haiku-3-5',
      phase: 'generate',
      source: 'phase',
    })
    expect((routingEvents[0]?.payload as Record<string, unknown>)['dispatchId']).toBeDefined()
  })

  it('AC5: routing:model-selected NOT emitted when resolver returns null (fallback)', async () => {
    const fp = createFakeProcess()
    fakeProcesses.push(fp)

    const eventBus = createMockEventBus()
    const adapter = createMockAdapter()
    const registry = createMockRegistry([adapter])

    const stubResolver = {
      resolveModel: vi.fn(() => null),
    }

    const dispatcher = createDispatcher({
      eventBus,
      adapterRegistry: registry,
      config: { routingResolver: stubResolver as never },
    })

    const handle = dispatcher.dispatch({
      prompt: 'Hello',
      agent: 'claude-code',
      taskType: 'dev-story',
    })

    await flushMicrotasks()
    fp.emitClose(0)
    await handle.result

    const routingEvents = eventBus.emittedEvents.filter((e) => e.event === 'routing:model-selected')
    expect(routingEvents).toHaveLength(0)
  })

  it('AC5: routing:model-selected NOT emitted when explicit model override is used', async () => {
    const fp = createFakeProcess()
    fakeProcesses.push(fp)

    const eventBus = createMockEventBus()
    const adapter = createMockAdapter()
    const registry = createMockRegistry([adapter])

    const stubResolver = {
      resolveModel: vi.fn(() => ({
        model: 'claude-haiku-3-5',
        phase: 'generate',
        source: 'phase' as const,
      })),
    }

    const dispatcher = createDispatcher({
      eventBus,
      adapterRegistry: registry,
      config: { routingResolver: stubResolver as never },
    })

    const handle = dispatcher.dispatch({
      prompt: 'Hello',
      agent: 'claude-code',
      taskType: 'dev-story',
      model: 'override-model',
    })

    await flushMicrotasks()
    fp.emitClose(0)
    await handle.result

    const routingEvents = eventBus.emittedEvents.filter((e) => e.event === 'routing:model-selected')
    expect(routingEvents).toHaveLength(0)
  })
})
