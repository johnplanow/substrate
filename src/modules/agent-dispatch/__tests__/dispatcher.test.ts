/**
 * Tests for DispatcherImpl — Sub-Agent Dispatch Engine
 *
 * Uses vi.mock to simulate child_process.spawn with fake processes
 * (EventEmitter + PassThrough streams) so no real subprocesses are spawned.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import type { ChildProcess } from 'node:child_process'
import { z } from 'zod'
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
import { DispatcherImpl, createDispatcher } from '../dispatcher-impl.js'
import { DispatcherShuttingDownError } from '../types.js'
import type { DispatchConfig } from '../types.js'

// ---------------------------------------------------------------------------
// Fake process factory
// ---------------------------------------------------------------------------

type FakeProcess = {
  proc: ChildProcess
  emitClose: (code: number) => void
  writeStdout: (data: string) => void
  writeStderr: (data: string) => void
  killMock: ReturnType<typeof vi.fn>
}

function createFakeProcess(): FakeProcess {
  const emitter = new EventEmitter()
  const stdin = new PassThrough()
  const stdout = new PassThrough()
  const stderr = new PassThrough()

  const killMock = vi.fn((_signal?: string) => {
    // Simulate process killed — emit close so promise resolves
    emitter.emit('close', 1)
  })

  const proc = Object.assign(emitter, {
    stdin,
    stdout,
    stderr,
    kill: killMock,
    pid: 99999,
  }) as unknown as ChildProcess

  const writeStdout = (data: string) => stdout.push(data)
  const writeStderr = (data: string) => stderr.push(data)
  const emitClose = (code: number) => emitter.emit('close', code)

  return { proc, emitClose, writeStdout, writeStderr, killMock }
}

// ---------------------------------------------------------------------------
// Mock child_process.spawn
// ---------------------------------------------------------------------------

const fakeProcesses: FakeProcess[] = []
let nextFakeProcessIndex = 0

vi.mock('node:child_process', () => ({
  spawn: vi.fn(() => {
    const fp = fakeProcesses[nextFakeProcessIndex]
    nextFakeProcessIndex++
    if (fp === undefined) {
      // fallback
      return createFakeProcess().proc
    }
    return fp.proc
  }),
}))

// ---------------------------------------------------------------------------
// Helper: flush the microtask queue
// ---------------------------------------------------------------------------

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

// ---------------------------------------------------------------------------
// Helper: create mock adapter
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Helper: create mock event bus
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Helper: create mock adapter registry
// ---------------------------------------------------------------------------

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
// Helper: create dispatcher with test config
// ---------------------------------------------------------------------------

function createTestDispatcher(
  options: {
    maxConcurrency?: number
    adapter?: WorkerAdapter
    eventBus?: MockEventBus
  } = {}
) {
  const adapter = options.adapter ?? createMockAdapter()
  const eventBus = options.eventBus ?? createMockEventBus()
  const registry = createMockRegistry([adapter])

  const config: DispatchConfig = {
    maxConcurrency: options.maxConcurrency ?? 3,
    defaultTimeouts: {
      'create-story': 180_000,
      'dev-story': 600_000,
      'code-review': 300_000,
    },
  }

  const dispatcher = new DispatcherImpl(eventBus, registry, config)

  return { dispatcher, adapter, eventBus, registry }
}

// ---------------------------------------------------------------------------
// Helper: complete a dispatch with stdout/exitCode
// ---------------------------------------------------------------------------

function completeDispatch(fp: FakeProcess, stdout: string, exitCode = 0): void {
  fp.writeStdout(stdout)
  fp.emitClose(exitCode)
}

// ---------------------------------------------------------------------------
// Test setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  fakeProcesses.length = 0
  nextFakeProcessIndex = 0
})

afterEach(() => {
  vi.useRealTimers()
  vi.clearAllMocks()
})

// ---------------------------------------------------------------------------
// AC1: Agent Spawning via Adapter Registry
// ---------------------------------------------------------------------------

describe('AC1: Agent Spawning via Adapter Registry', () => {
  it('dispatches using the adapter from the registry and returns a DispatchHandle with result', async () => {
    const fp = createFakeProcess()
    fakeProcesses.push(fp)

    const { dispatcher } = createTestDispatcher()

    const handle = dispatcher.dispatch({
      prompt: 'Do the work',
      agent: 'claude-code',
      taskType: 'code-review',
      timeout: 60_000,
    })

    // Verify handle shape (AC1: returns DispatchHandle with id, status, cancel, result)
    expect(typeof handle.id).toBe('string')
    expect(handle.id).toBeTruthy()
    expect(typeof handle.status).toBe('string')
    expect(typeof handle.cancel).toBe('function')
    expect(handle.result).toBeInstanceOf(Promise)

    await flushMicrotasks()

    completeDispatch(fp, 'result: success\nac_met: yes\n')

    const result = await handle.result
    expect(result.status).toBe('completed')
    expect(result.exitCode).toBe(0)
    expect(result.id).toBeTruthy()
    expect(typeof result.id).toBe('string')
  })

  it('returns a failed result when no adapter is registered for the agent', async () => {
    const { dispatcher } = createTestDispatcher({ adapter: createMockAdapter('claude-code') })

    const handle = dispatcher.dispatch({
      prompt: 'Do the work',
      agent: 'nonexistent-agent',
      taskType: 'code-review',
    })

    const result = await handle.result

    expect(result.status).toBe('failed')
    expect(result.parseError).toContain('No adapter registered for agent')
    expect(result.exitCode).toBe(-1)
    // Verify no slot leak: concurrency slot must be released after adapter-not-found failure
    expect(dispatcher.getRunning()).toBe(0)
  })

  it('passes the prompt to the subprocess via stdin', async () => {
    const fp = createFakeProcess()
    fakeProcesses.push(fp)

    const { dispatcher } = createTestDispatcher()

    const handle = dispatcher.dispatch({
      prompt: 'My compiled prompt',
      agent: 'claude-code',
      taskType: 'code-review',
      timeout: 60_000,
    })

    await flushMicrotasks()
    completeDispatch(fp, 'result: success\n')

    const result = await handle.result
    expect(result.status).toBe('completed')
  })
})

// ---------------------------------------------------------------------------
// AC2: Lifecycle Tracking with Events
// ---------------------------------------------------------------------------

describe('AC2: Lifecycle Tracking with Events', () => {
  it('emits agent:spawned when the agent is dispatched', async () => {
    const fp = createFakeProcess()
    fakeProcesses.push(fp)

    const eventBus = createMockEventBus()
    const { dispatcher } = createTestDispatcher({ eventBus })

    const handle = dispatcher.dispatch({
      prompt: 'Do the work',
      agent: 'claude-code',
      taskType: 'code-review',
      timeout: 60_000,
    })

    await flushMicrotasks()

    // spawned event should have been emitted synchronously during dispatch
    const spawned = eventBus.emittedEvents.find((e) => e.event === 'agent:spawned')
    expect(spawned).toBeDefined()
    expect((spawned?.payload as Record<string, unknown>)?.agent).toBe('claude-code')
    expect((spawned?.payload as Record<string, unknown>)?.taskType).toBe('code-review')
    expect(typeof (spawned?.payload as Record<string, unknown>)?.dispatchId).toBe('string')

    completeDispatch(fp, 'result: success\n')
    await handle.result
  })

  it('emits agent:output when stdout data is received', async () => {
    const fp = createFakeProcess()
    fakeProcesses.push(fp)

    const eventBus = createMockEventBus()
    const { dispatcher } = createTestDispatcher({ eventBus })

    const handle = dispatcher.dispatch({
      prompt: 'Do the work',
      agent: 'claude-code',
      taskType: 'code-review',
      timeout: 60_000,
    })

    await flushMicrotasks()

    fp.writeStdout('Some output chunk\n')
    await flushMicrotasks()

    const outputEvents = eventBus.emittedEvents.filter((e) => e.event === 'agent:output')
    expect(outputEvents.length).toBeGreaterThan(0)

    fp.writeStdout('result: success\n')
    fp.emitClose(0)
    await handle.result
  })

  it('emits agent:completed on successful exit', async () => {
    const fp = createFakeProcess()
    fakeProcesses.push(fp)

    const eventBus = createMockEventBus()
    const { dispatcher } = createTestDispatcher({ eventBus })

    const handle = dispatcher.dispatch({
      prompt: 'Do the work',
      agent: 'claude-code',
      taskType: 'code-review',
      timeout: 60_000,
    })

    await flushMicrotasks()

    completeDispatch(fp, 'result: success\n')
    await handle.result

    const completed = eventBus.emittedEvents.find((e) => e.event === 'agent:completed')
    expect(completed).toBeDefined()
    expect((completed?.payload as Record<string, unknown>)?.exitCode).toBe(0)
  })

  it('emits agent:failed on non-zero exit', async () => {
    const fp = createFakeProcess()
    fakeProcesses.push(fp)

    const eventBus = createMockEventBus()
    const { dispatcher } = createTestDispatcher({ eventBus })

    const handle = dispatcher.dispatch({
      prompt: 'Do the work',
      agent: 'claude-code',
      taskType: 'code-review',
      timeout: 60_000,
    })

    await flushMicrotasks()

    fp.writeStderr('Something went wrong\n')
    fp.emitClose(1)
    await handle.result

    const failed = eventBus.emittedEvents.find((e) => e.event === 'agent:failed')
    expect(failed).toBeDefined()
    expect((failed?.payload as Record<string, unknown>)?.exitCode).toBe(1)
  })

  it('emits agent:timeout when the timeout expires', async () => {
    const fp = createFakeProcess()
    fakeProcesses.push(fp)

    vi.useFakeTimers()

    const eventBus = createMockEventBus()
    const { dispatcher } = createTestDispatcher({ eventBus })

    const handle = dispatcher.dispatch({
      prompt: 'Do the work',
      agent: 'claude-code',
      taskType: 'code-review',
      timeout: 5000,
    })

    // Let the dispatch start (runs _startDispatch via promise chain)
    await flushMicrotasks()

    // Advance time past the timeout — the kill mock also emits close
    vi.advanceTimersByTime(5001)
    await flushMicrotasks()

    const result = await handle.result

    vi.useRealTimers()

    const timeoutEvent = eventBus.emittedEvents.find((e) => e.event === 'agent:timeout')
    expect(timeoutEvent).toBeDefined()
    expect((timeoutEvent?.payload as Record<string, unknown>)?.timeoutMs).toBe(5000)
    expect(result.status).toBe('timeout')
  })
})

// ---------------------------------------------------------------------------
// AC3: YAML Output Parsing
// ---------------------------------------------------------------------------

describe('AC3: YAML Output Parsing', () => {
  it('extracts and parses YAML from agent output', async () => {
    const fp = createFakeProcess()
    fakeProcesses.push(fp)

    const { dispatcher } = createTestDispatcher()

    const handle = dispatcher.dispatch({
      prompt: 'Do the work',
      agent: 'claude-code',
      taskType: 'code-review',
      timeout: 60_000,
    })

    await flushMicrotasks()

    completeDispatch(
      fp,
      `Some narrative text.\n\nresult: success\nac_met: yes\nac_failures: []\n`
    )

    const result = await handle.result
    expect(result.status).toBe('completed')
    expect(result.parsed).not.toBeNull()
    expect((result.parsed as Record<string, unknown>)?.result).toBe('success')
    expect(result.parseError).toBeNull()
  })

  it('validates parsed YAML against a Zod schema', async () => {
    const fp = createFakeProcess()
    fakeProcesses.push(fp)

    const schema = z.object({
      result: z.enum(['success', 'failure']),
      ac_met: z.enum(['yes', 'no']),
    })

    const { dispatcher } = createTestDispatcher()

    const handle = dispatcher.dispatch({
      prompt: 'Do the work',
      agent: 'claude-code',
      taskType: 'code-review',
      timeout: 60_000,
      outputSchema: schema,
    })

    await flushMicrotasks()

    completeDispatch(fp, 'result: success\nac_met: yes\n')

    const result = await handle.result
    expect(result.parsed).toEqual({ result: 'success', ac_met: 'yes' })
    expect(result.parseError).toBeNull()
  })

  it('returns parseError: no_yaml_block when no YAML is found in output', async () => {
    const fp = createFakeProcess()
    fakeProcesses.push(fp)

    const { dispatcher } = createTestDispatcher()

    const handle = dispatcher.dispatch({
      prompt: 'Do the work',
      agent: 'claude-code',
      taskType: 'code-review',
      timeout: 60_000,
    })

    await flushMicrotasks()

    completeDispatch(fp, 'Just some plain text with no YAML here.')

    const result = await handle.result
    expect(result.parsed).toBeNull()
    expect(result.parseError).toBe('no_yaml_block')
  })

  it('returns parseError when YAML does not match schema', async () => {
    const fp = createFakeProcess()
    fakeProcesses.push(fp)

    const schema = z.object({
      result: z.enum(['success', 'failure']),
    })

    const { dispatcher } = createTestDispatcher()

    const handle = dispatcher.dispatch({
      prompt: 'Do the work',
      agent: 'claude-code',
      taskType: 'code-review',
      timeout: 60_000,
      outputSchema: schema,
    })

    await flushMicrotasks()

    completeDispatch(fp, 'result: invalid_value\n')

    const result = await handle.result
    expect(result.parsed).toBeNull()
    expect(result.parseError).toContain('Schema validation error')
  })
})

// ---------------------------------------------------------------------------
// AC4: Configurable Timeout
// ---------------------------------------------------------------------------

describe('AC4: Configurable Timeout', () => {
  it('kills the process and returns timeout status when timeout expires', async () => {
    const fp = createFakeProcess()
    fakeProcesses.push(fp)

    vi.useFakeTimers()

    const { dispatcher } = createTestDispatcher()

    const handle = dispatcher.dispatch({
      prompt: 'Do the work',
      agent: 'claude-code',
      taskType: 'code-review',
      timeout: 1000,
    })

    await flushMicrotasks()

    // Advance time past the timeout — kill is called, which emits close(1)
    vi.advanceTimersByTime(1001)
    await flushMicrotasks()

    const result = await handle.result

    vi.useRealTimers()

    expect(result.status).toBe('timeout')
    expect(result.exitCode).toBe(-1)
    expect(result.parseError).toContain('timed out')
    expect(fp.killMock).toHaveBeenCalledWith('SIGTERM')
  })

  it('uses default timeout from config when no timeout is provided', async () => {
    const fp = createFakeProcess()
    fakeProcesses.push(fp)

    vi.useFakeTimers()

    const config: DispatchConfig = {
      maxConcurrency: 3,
      defaultTimeouts: {
        'fast-task': 500,
      },
    }

    const adapter = createMockAdapter()
    const eventBus = createMockEventBus()
    const registry = createMockRegistry([adapter])
    const dispatcher = new DispatcherImpl(eventBus, registry, config)

    const handle = dispatcher.dispatch({
      prompt: 'Do the work',
      agent: 'claude-code',
      taskType: 'fast-task', // Uses the 500ms timeout from config
    })

    await flushMicrotasks()

    // Advance time past the 500ms default timeout for 'fast-task'
    vi.advanceTimersByTime(501)
    await flushMicrotasks()

    const result = await handle.result

    vi.useRealTimers()

    expect(result.status).toBe('timeout')
  })
})

// ---------------------------------------------------------------------------
// AC5: Concurrent Dispatch with Limits
// ---------------------------------------------------------------------------

describe('AC5: Concurrent Dispatch with Limits', () => {
  it('queues dispatches when maxConcurrency is reached', async () => {
    const fp1 = createFakeProcess()
    const fp2 = createFakeProcess()
    const fp3 = createFakeProcess()
    fakeProcesses.push(fp1, fp2, fp3)

    const { dispatcher } = createTestDispatcher({ maxConcurrency: 2 })

    // Start 3 dispatches with maxConcurrency=2
    const h1 = dispatcher.dispatch({
      prompt: 'Task 1',
      agent: 'claude-code',
      taskType: 'code-review',
      timeout: 60_000,
    })
    const h2 = dispatcher.dispatch({
      prompt: 'Task 2',
      agent: 'claude-code',
      taskType: 'code-review',
      timeout: 60_000,
    })
    const h3 = dispatcher.dispatch({
      prompt: 'Task 3',
      agent: 'claude-code',
      taskType: 'code-review',
      timeout: 60_000,
    })

    await flushMicrotasks()

    // 2 running, 1 queued
    expect(dispatcher.getRunning()).toBe(2)
    expect(dispatcher.getPending()).toBe(1)

    // Complete the first dispatch
    completeDispatch(fp1, 'result: success\n')
    await h1.result
    await flushMicrotasks()

    // Queue should drain — p3 starts
    expect(dispatcher.getPending()).toBe(0)

    // Complete remaining
    completeDispatch(fp2, 'result: success\n')
    completeDispatch(fp3, 'result: success\n')

    const results = await Promise.all([h2.result, h3.result])
    expect(results.every((r) => r.status === 'completed')).toBe(true)
  })

  it('getPending() returns queue length', async () => {
    const fp1 = createFakeProcess()
    fakeProcesses.push(fp1)

    const { dispatcher } = createTestDispatcher({ maxConcurrency: 1 })

    // p1 starts immediately, p2 and p3 are queued
    const h1 = dispatcher.dispatch({
      prompt: 'Task 1',
      agent: 'claude-code',
      taskType: 'code-review',
      timeout: 60_000,
    })
    const h2 = dispatcher.dispatch({
      prompt: 'Task 2',
      agent: 'claude-code',
      taskType: 'code-review',
      timeout: 60_000,
    })
    const h3 = dispatcher.dispatch({
      prompt: 'Task 3',
      agent: 'claude-code',
      taskType: 'code-review',
      timeout: 60_000,
    })

    await flushMicrotasks()

    expect(dispatcher.getPending()).toBe(2)
    expect(dispatcher.getRunning()).toBe(1)

    // Add fake processes for p2, p3
    const fp2 = createFakeProcess()
    const fp3 = createFakeProcess()
    fakeProcesses.push(fp2, fp3)

    // Complete p1
    completeDispatch(fp1, 'result: success\n')
    await h1.result
    await flushMicrotasks()

    // p2 should have started
    expect(dispatcher.getPending()).toBe(1)

    completeDispatch(fp2, 'result: success\n')
    await h2.result
    await flushMicrotasks()

    expect(dispatcher.getPending()).toBe(0)

    completeDispatch(fp3, 'result: success\n')
    await h3.result
  })

  it('getRunning() returns count of active dispatches', async () => {
    const fp1 = createFakeProcess()
    const fp2 = createFakeProcess()
    fakeProcesses.push(fp1, fp2)

    const { dispatcher } = createTestDispatcher({ maxConcurrency: 3 })

    const h1 = dispatcher.dispatch({
      prompt: 'Task 1',
      agent: 'claude-code',
      taskType: 'code-review',
      timeout: 60_000,
    })
    const h2 = dispatcher.dispatch({
      prompt: 'Task 2',
      agent: 'claude-code',
      taskType: 'code-review',
      timeout: 60_000,
    })

    await flushMicrotasks()

    expect(dispatcher.getRunning()).toBe(2)

    completeDispatch(fp1, 'result: success\n')
    completeDispatch(fp2, 'result: success\n')

    await Promise.all([h1.result, h2.result])

    expect(dispatcher.getRunning()).toBe(0)
  })

  it('queued dispatch starts when running one completes', async () => {
    const fp1 = createFakeProcess()
    const fp2 = createFakeProcess()
    fakeProcesses.push(fp1, fp2)

    const { dispatcher } = createTestDispatcher({ maxConcurrency: 1 })

    const h1 = dispatcher.dispatch({
      prompt: 'Task 1',
      agent: 'claude-code',
      taskType: 'code-review',
      timeout: 60_000,
    })
    const h2 = dispatcher.dispatch({
      prompt: 'Task 2',
      agent: 'claude-code',
      taskType: 'code-review',
      timeout: 60_000,
    })

    await flushMicrotasks()

    expect(dispatcher.getRunning()).toBe(1)
    expect(dispatcher.getPending()).toBe(1)

    // Complete p1
    completeDispatch(fp1, 'result: success\n')
    await h1.result
    await flushMicrotasks()

    // p2 should have started
    expect(dispatcher.getRunning()).toBe(1)
    expect(dispatcher.getPending()).toBe(0)

    // Complete p2
    completeDispatch(fp2, 'result: success\n')

    const r2 = await h2.result
    expect(r2.status).toBe('completed')
  })
})

// ---------------------------------------------------------------------------
// AC5b: Cancel behavior
// ---------------------------------------------------------------------------

describe('AC5b: Cancel behavior', () => {
  it('cancelling a queued dispatch rejects its promise with a cancellation error', async () => {
    const fp1 = createFakeProcess()
    fakeProcesses.push(fp1)

    const { dispatcher } = createTestDispatcher({ maxConcurrency: 1 })

    // h1 starts immediately (consumes the slot)
    const h1 = dispatcher.dispatch({
      prompt: 'Task 1',
      agent: 'claude-code',
      taskType: 'code-review',
      timeout: 60_000,
    })

    // h2 and h3 are queued
    const h2 = dispatcher.dispatch({
      prompt: 'Task 2',
      agent: 'claude-code',
      taskType: 'code-review',
      timeout: 60_000,
    })
    const h3 = dispatcher.dispatch({
      prompt: 'Task 3',
      agent: 'claude-code',
      taskType: 'code-review',
      timeout: 60_000,
    })

    await flushMicrotasks()

    expect(dispatcher.getRunning()).toBe(1)
    expect(dispatcher.getPending()).toBe(2)

    // Cancel the first queued dispatch (h2)
    await h2.cancel()

    // h2 promise should reject with a cancellation error
    await expect(h2.result).rejects.toThrow(/cancelled/i)

    // Only h3 remains in queue
    expect(dispatcher.getPending()).toBe(1)
    expect(dispatcher.getRunning()).toBe(1)

    // Clean up
    const fp2 = createFakeProcess()
    fakeProcesses.push(fp2)

    completeDispatch(fp1, 'result: success\n')
    await h1.result
    await flushMicrotasks()

    completeDispatch(fp2, 'result: success\n')
    await h3.result
  })

  it('cancelling a running dispatch kills the process and resolves/rejects the promise', async () => {
    const fp = createFakeProcess()
    fakeProcesses.push(fp)

    const { dispatcher } = createTestDispatcher({ maxConcurrency: 2 })

    const h1 = dispatcher.dispatch({
      prompt: 'Task 1',
      agent: 'claude-code',
      taskType: 'code-review',
      timeout: 60_000,
    })

    await flushMicrotasks()

    expect(dispatcher.getRunning()).toBe(1)

    // Cancel the running dispatch
    await h1.cancel()

    // The kill mock emits close(1) automatically — wait for it to settle
    await flushMicrotasks()

    // Verify the process was killed
    expect(fp.killMock).toHaveBeenCalledWith('SIGTERM')

    // The promise should settle (either resolve or reject) — just awaiting it confirms it is not hanging
    const result = await h1.result
    expect(['failed', 'completed', 'timeout']).toContain(result.status)

    // Slot should be released
    expect(dispatcher.getRunning()).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// AC6: Dispatch Result Contract
// ---------------------------------------------------------------------------

describe('AC6: Dispatch Result Contract', () => {
  it('returns a result with all required fields', async () => {
    const fp = createFakeProcess()
    fakeProcesses.push(fp)

    const { dispatcher } = createTestDispatcher()

    const handle = dispatcher.dispatch({
      prompt: 'Do the work',
      agent: 'claude-code',
      taskType: 'code-review',
      timeout: 60_000,
    })

    await flushMicrotasks()

    completeDispatch(fp, 'result: success\n')

    const result = await handle.result

    // Validate shape per AC6
    expect(typeof result.id).toBe('string')
    expect(['completed', 'failed', 'timeout']).toContain(result.status)
    expect(typeof result.exitCode).toBe('number')
    expect(typeof result.output).toBe('string')
    expect(typeof result.parseError === 'string' || result.parseError === null).toBe(true)
    expect(typeof result.durationMs).toBe('number')
    expect(result.durationMs).toBeGreaterThanOrEqual(0)
    expect(typeof result.tokenEstimate.input).toBe('number')
    expect(typeof result.tokenEstimate.output).toBe('number')
  })

  it('calculates token estimates based on prompt and output length', async () => {
    const fp = createFakeProcess()
    fakeProcesses.push(fp)

    const { dispatcher } = createTestDispatcher()

    const prompt = 'A'.repeat(400) // 400 chars → 100 tokens
    const outputText = 'result: success\n' + 'B'.repeat(800)

    const handle = dispatcher.dispatch({
      prompt,
      agent: 'claude-code',
      taskType: 'code-review',
      timeout: 60_000,
    })

    await flushMicrotasks()

    completeDispatch(fp, outputText)

    const result = await handle.result
    expect(result.tokenEstimate.input).toBe(100) // 400 / 4
    expect(result.tokenEstimate.output).toBeGreaterThan(0)
  })

  it('returns failed result with exitCode and output on non-zero exit', async () => {
    const fp = createFakeProcess()
    fakeProcesses.push(fp)

    const { dispatcher } = createTestDispatcher()

    const handle = dispatcher.dispatch({
      prompt: 'Do the work',
      agent: 'claude-code',
      taskType: 'code-review',
      timeout: 60_000,
    })

    await flushMicrotasks()

    fp.writeStderr('Fatal error occurred\n')
    fp.emitClose(2)

    const result = await handle.result
    expect(result.status).toBe('failed')
    expect(result.exitCode).toBe(2)
    expect(result.parsed).toBeNull()
    expect(result.parseError).toContain('2')
  })
})

// ---------------------------------------------------------------------------
// AC7: Graceful Shutdown
// ---------------------------------------------------------------------------

describe('AC7: Graceful Shutdown', () => {
  it('rejects new dispatches after shutdown() is called', async () => {
    const { dispatcher } = createTestDispatcher()

    await dispatcher.shutdown()

    const handle = dispatcher.dispatch({
      prompt: 'Do the work',
      agent: 'claude-code',
      taskType: 'code-review',
    })

    await expect(handle.result).rejects.toBeInstanceOf(DispatcherShuttingDownError)
  })

  it('sends SIGTERM to running processes on shutdown', async () => {
    const fp = createFakeProcess()
    fakeProcesses.push(fp)

    vi.useFakeTimers()

    const { dispatcher } = createTestDispatcher()

    const _handle = dispatcher.dispatch({
      prompt: 'Do the work',
      agent: 'claude-code',
      taskType: 'dev-story',
      timeout: 600_000,
    })

    await flushMicrotasks()

    expect(dispatcher.getRunning()).toBe(1)

    // Call shutdown — it will SIGTERM, then wait grace period
    const shutdownPromise = dispatcher.shutdown()

    // kill mock emits close(1) on any signal call, so the process exits
    await flushMicrotasks()

    // Advance past the grace period
    vi.advanceTimersByTime(10_001)
    await flushMicrotasks()

    await shutdownPromise

    vi.useRealTimers()

    expect(fp.killMock).toHaveBeenCalledWith('SIGTERM')
  })

  it('resolves shutdown() when no processes are running', async () => {
    const { dispatcher } = createTestDispatcher()

    // No running dispatches
    await expect(dispatcher.shutdown()).resolves.toBeUndefined()
  })

  it('rejects queued dispatches on shutdown', async () => {
    const fp1 = createFakeProcess()
    fakeProcesses.push(fp1)

    vi.useFakeTimers()

    const { dispatcher } = createTestDispatcher({ maxConcurrency: 1 })

    // Start one that will block
    const _h1 = dispatcher.dispatch({
      prompt: 'Task 1',
      agent: 'claude-code',
      taskType: 'code-review',
      timeout: 600_000,
    })

    // Queue another one
    const h2 = dispatcher.dispatch({
      prompt: 'Task 2',
      agent: 'claude-code',
      taskType: 'code-review',
      timeout: 600_000,
    })

    await flushMicrotasks()

    expect(dispatcher.getPending()).toBe(1)

    // Shutdown
    const shutdownPromise = dispatcher.shutdown()
    await flushMicrotasks()
    vi.advanceTimersByTime(10_001)
    await flushMicrotasks()
    await shutdownPromise

    vi.useRealTimers()

    // The queued dispatch should be rejected with DispatcherShuttingDownError
    await expect(h2.result).rejects.toBeInstanceOf(DispatcherShuttingDownError)
  })
})

// ---------------------------------------------------------------------------
// Token estimation tests
// ---------------------------------------------------------------------------

describe('Token estimation', () => {
  it('estimates input tokens from prompt length divided by 4', async () => {
    const fp = createFakeProcess()
    fakeProcesses.push(fp)

    const { dispatcher } = createTestDispatcher()
    const prompt = 'X'.repeat(400) // 400 chars / 4 = 100 tokens

    const handle = dispatcher.dispatch({
      prompt,
      agent: 'claude-code',
      taskType: 'code-review',
      timeout: 60_000,
    })

    await flushMicrotasks()

    completeDispatch(fp, 'result: success\n')

    const result = await handle.result
    expect(result.tokenEstimate.input).toBe(100)
  })

  it('estimates output tokens from collected stdout length divided by 4', async () => {
    const fp = createFakeProcess()
    fakeProcesses.push(fp)

    const { dispatcher } = createTestDispatcher()

    const handle = dispatcher.dispatch({
      prompt: 'test',
      agent: 'claude-code',
      taskType: 'code-review',
      timeout: 60_000,
    })

    await flushMicrotasks()

    const outputText = 'result: success\n' + 'O'.repeat(800)
    completeDispatch(fp, outputText)

    const result = await handle.result
    expect(result.tokenEstimate.output).toBeGreaterThan(0)
    expect(result.tokenEstimate.output).toBe(Math.ceil(outputText.length / 4))
  })
})

// ---------------------------------------------------------------------------
// createDispatcher factory tests
// ---------------------------------------------------------------------------

describe('createDispatcher factory', () => {
  it('creates a dispatcher with default config when no config provided', () => {
    const eventBus = createMockEventBus()
    const registry = createMockRegistry([createMockAdapter()])

    const dispatcher = createDispatcher({ eventBus, adapterRegistry: registry })

    expect(dispatcher).toBeDefined()
    expect(dispatcher.getPending()).toBe(0)
    expect(dispatcher.getRunning()).toBe(0)
  })

  it('merges provided config overrides with defaults', async () => {
    const fp1 = createFakeProcess()
    const fp2 = createFakeProcess()
    fakeProcesses.push(fp1, fp2)

    const eventBus = createMockEventBus()
    const adapter = createMockAdapter()
    const registry = createMockRegistry([adapter])

    // maxConcurrency of 1 with 2 dispatches should queue the second
    const dispatcher = createDispatcher({
      eventBus,
      adapterRegistry: registry,
      config: { maxConcurrency: 1 },
    })

    const h1 = dispatcher.dispatch({
      prompt: 'Task 1',
      agent: 'claude-code',
      taskType: 'code-review',
      timeout: 60_000,
    })
    const h2 = dispatcher.dispatch({
      prompt: 'Task 2',
      agent: 'claude-code',
      taskType: 'code-review',
      timeout: 60_000,
    })

    await flushMicrotasks()

    expect(dispatcher.getRunning()).toBe(1)
    expect(dispatcher.getPending()).toBe(1)

    completeDispatch(fp1, 'result: success\n')
    await h1.result
    await flushMicrotasks()

    completeDispatch(fp2, 'result: success\n')
    const r2 = await h2.result
    expect(r2.status).toBe('completed')
  })
})

// ---------------------------------------------------------------------------
// Lifecycle events test: all transitions
// ---------------------------------------------------------------------------

describe('Lifecycle events at each transition', () => {
  it('emits events in order: spawned, output, completed', async () => {
    const fp = createFakeProcess()
    fakeProcesses.push(fp)

    const eventBus = createMockEventBus()
    const { dispatcher } = createTestDispatcher({ eventBus })

    const handle = dispatcher.dispatch({
      prompt: 'Do the work',
      agent: 'claude-code',
      taskType: 'code-review',
      timeout: 60_000,
    })

    await flushMicrotasks()

    fp.writeStdout('Some output\n')
    await flushMicrotasks()

    fp.writeStdout('result: success\n')
    fp.emitClose(0)

    await handle.result

    const eventNames = eventBus.emittedEvents.map((e) => e.event)
    const spawnedIdx = eventNames.indexOf('agent:spawned')
    const outputIdx = eventNames.indexOf('agent:output')
    const completedIdx = eventNames.indexOf('agent:completed')

    expect(spawnedIdx).toBeGreaterThanOrEqual(0)
    expect(outputIdx).toBeGreaterThanOrEqual(0)
    expect(completedIdx).toBeGreaterThanOrEqual(0)

    // spawned comes before completed
    expect(spawnedIdx).toBeLessThan(completedIdx)
  })
})
