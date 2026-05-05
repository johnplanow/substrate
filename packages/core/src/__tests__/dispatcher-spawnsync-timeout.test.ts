/**
 * Unit tests for `dispatch:spawnsync-timeout` event emission in DispatcherImpl.
 *
 * Story 66-4 (AC4, AC5): asserts the event is emitted with correct fields when
 * a dispatch times out, and that backward-compatible pre-existing tests are
 * unaffected. Tests both attemptNumber: 1 (initial dispatch) and
 * attemptNumber: 2 (retry dispatch) paths.
 *
 * obs_2026-05-04_023 fix #3.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { EventEmitter } from 'node:events'

// ---------------------------------------------------------------------------
// Mock node:child_process before importing the module under test.
// Use vi.hoisted so the mocks are available inside the vi.mock factory.
// ---------------------------------------------------------------------------

const { mockSpawn, mockExecSync } = vi.hoisted(() => ({
  mockSpawn: vi.fn(),
  // execSync is called by getAvailableMemory() on macOS (sysctl + vm_stat).
  // Throw to make the macOS code fall back to freemem() for all calls.
  mockExecSync: vi.fn().mockImplementation(() => {
    throw new Error('mock: execSync not available in test environment')
  }),
}))

vi.mock('node:child_process', () => ({
  spawn: mockSpawn,
  execSync: mockExecSync,
}))

// Mock node:os to ensure freemem() returns a large value so the dispatcher
// never detects memory pressure during tests, regardless of actual system state.
vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof import('node:os')>('node:os')
  return {
    ...actual,
    freemem: vi.fn().mockReturnValue(8 * 1024 * 1024 * 1024), // 8 GB — never pressured
  }
})

// Import after mocks are set up
import { DispatcherImpl } from '../dispatch/dispatcher-impl.js'
import type { EventMap, TypedEventBus } from '../events/event-bus.js'
import type { IAdapterRegistry, ICliAdapter, DispatchConfig } from '../dispatch/types.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Create a fake ChildProcess that hangs indefinitely — it never emits 'close'.
 * The dispatcher's timeout handler will fire and kill it via proc.kill('SIGTERM').
 */
function createHangingProcess(pid = 12345) {
  // Use a plain EventEmitter so proc.on('error', ...) and proc.on('close', ...)
  // are properly registered (the real ChildProcess extends EventEmitter).
  const proc = new EventEmitter() as EventEmitter & {
    pid: number
    stdout: EventEmitter
    stderr: EventEmitter
    stdin: { write: ReturnType<typeof vi.fn>; end: ReturnType<typeof vi.fn>; on: ReturnType<typeof vi.fn> }
    kill: ReturnType<typeof vi.fn>
  }
  proc.pid = pid
  proc.stdout = new EventEmitter()
  proc.stderr = new EventEmitter()
  proc.stdin = {
    write: vi.fn(),
    end: vi.fn(),
    on: vi.fn(),
  }
  proc.kill = vi.fn()
  return proc
}

/**
 * Create a minimal mock ICliAdapter that returns a no-op spawn command.
 */
function createMockAdapter(): ICliAdapter {
  return {
    buildCommand: vi.fn().mockReturnValue({
      binary: 'echo',
      args: ['test'],
      cwd: '/tmp',
    }),
    getCapabilities: vi.fn().mockReturnValue({}),
  }
}

/**
 * Create a mock IAdapterRegistry backed by the given adapter.
 */
function createMockRegistry(adapter: ICliAdapter): IAdapterRegistry {
  return {
    get: vi.fn().mockReturnValue(adapter),
  }
}

/**
 * Create a recording event bus that captures all emitted events.
 * Returns the bus (suitable for injection into DispatcherImpl) and the
 * recorded events array for assertions.
 */
function createRecordingEventBus(): {
  eventBus: TypedEventBus<EventMap>
  emittedEvents: Array<{ event: string; payload: unknown }>
} {
  const emittedEvents: Array<{ event: string; payload: unknown }> = []
  const eventBus = {
    emit: vi.fn((event: unknown, payload: unknown) => {
      emittedEvents.push({ event: event as string, payload })
    }),
    on: vi.fn(),
    off: vi.fn(),
  } as unknown as TypedEventBus<EventMap>
  return { eventBus, emittedEvents }
}

/** Silent logger to suppress test output noise. */
const silentLogger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('DispatcherImpl — dispatch:spawnsync-timeout event', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // Re-apply the execSync throw after clearAllMocks resets implementations
    mockExecSync.mockImplementation(() => {
      throw new Error('mock: execSync not available in test environment')
    })
  })

  it('emits dispatch:spawnsync-timeout with attemptNumber: 1 when initial dispatch times out', async () => {
    const testPid = 12345
    const hangingProc = createHangingProcess(testPid)
    mockSpawn.mockReturnValue(hangingProc)

    const { eventBus, emittedEvents } = createRecordingEventBus()
    const adapter = createMockAdapter()
    const registry = createMockRegistry(adapter)

    // Use a very short timeout so the test completes in milliseconds
    const timeoutMs = 20
    const config: DispatchConfig = {
      maxConcurrency: 1,
      defaultTimeouts: { 'probe-author': timeoutMs },
    }

    const dispatcher = new DispatcherImpl(eventBus, registry, config, silentLogger)

    const handle = dispatcher.dispatch({
      prompt: 'test prompt',
      agent: 'claude-code',
      taskType: 'probe-author',
      storyKey: 'test-1',
      attemptNumber: 1,
    })

    const result = await handle.result

    // Dispatch must resolve as timeout
    expect(result.status).toBe('timeout')

    // dispatch:spawnsync-timeout event must be present
    const timeoutEvent = emittedEvents.find((e) => e.event === 'dispatch:spawnsync-timeout')
    expect(timeoutEvent).toBeDefined()

    const payload = timeoutEvent!.payload as Record<string, unknown>

    // AC1 field shape assertions
    expect(payload.type).toBe('dispatch:spawnsync-timeout')
    expect(payload.storyKey).toBe('test-1')
    expect(payload.taskType).toBe('probe-author')
    expect(payload.attemptNumber).toBe(1)
    expect(payload.timeoutMs).toBe(timeoutMs)

    // AC3: elapsedAtKill is a non-negative number measured at kill time
    expect(typeof payload.elapsedAtKill).toBe('number')
    expect(payload.elapsedAtKill as number).toBeGreaterThanOrEqual(0)

    // pid is included when process.pid > 0
    expect(payload.pid).toBe(testPid)

    // occurredAt is a valid ISO 8601 date string
    expect(typeof payload.occurredAt).toBe('string')
    expect(new Date(payload.occurredAt as string).toISOString()).toBe(payload.occurredAt)
  })

  it('emits dispatch:spawnsync-timeout with attemptNumber: 2 when retry dispatch times out', async () => {
    const testPid = 99999
    const hangingProc = createHangingProcess(testPid)
    mockSpawn.mockReturnValue(hangingProc)

    const { eventBus, emittedEvents } = createRecordingEventBus()
    const adapter = createMockAdapter()
    const registry = createMockRegistry(adapter)

    // Retry timeout: explicit 30 ms (≈ 1.5× a hypothetical 20 ms initial)
    const retryTimeoutMs = 30
    const config: DispatchConfig = {
      maxConcurrency: 1,
      defaultTimeouts: {},
    }

    const dispatcher = new DispatcherImpl(eventBus, registry, config, silentLogger)

    const handle = dispatcher.dispatch({
      prompt: 'retry prompt',
      agent: 'claude-code',
      taskType: 'probe-author',
      storyKey: 'test-retry',
      timeout: retryTimeoutMs, // Explicit timeout override for retry dispatch
      attemptNumber: 2,
    })

    const result = await handle.result

    expect(result.status).toBe('timeout')

    const timeoutEvent = emittedEvents.find((e) => e.event === 'dispatch:spawnsync-timeout')
    expect(timeoutEvent).toBeDefined()

    const payload = timeoutEvent!.payload as Record<string, unknown>
    expect(payload.type).toBe('dispatch:spawnsync-timeout')
    expect(payload.storyKey).toBe('test-retry')
    expect(payload.taskType).toBe('probe-author')
    expect(payload.attemptNumber).toBe(2)
    expect(payload.timeoutMs).toBe(retryTimeoutMs)
    expect(typeof payload.elapsedAtKill).toBe('number')
    expect(payload.elapsedAtKill as number).toBeGreaterThanOrEqual(0)
    expect(payload.pid).toBe(testPid)
    expect(typeof payload.occurredAt).toBe('string')
    expect(new Date(payload.occurredAt as string).toISOString()).toBe(payload.occurredAt)
  })

  it('defaults attemptNumber to 1 when not specified in the dispatch request', async () => {
    const hangingProc = createHangingProcess(11111)
    mockSpawn.mockReturnValue(hangingProc)

    const { eventBus, emittedEvents } = createRecordingEventBus()
    const adapter = createMockAdapter()
    const registry = createMockRegistry(adapter)

    const config: DispatchConfig = {
      maxConcurrency: 1,
      defaultTimeouts: { 'dev-story': 20 },
    }

    const dispatcher = new DispatcherImpl(eventBus, registry, config, silentLogger)

    const handle = dispatcher.dispatch({
      prompt: 'no attempt number',
      agent: 'claude-code',
      taskType: 'dev-story',
      storyKey: 'test-default-attempt',
      // attemptNumber intentionally omitted — should default to 1
    })

    await handle.result

    const timeoutEvent = emittedEvents.find((e) => e.event === 'dispatch:spawnsync-timeout')
    expect(timeoutEvent).toBeDefined()

    const payload = timeoutEvent!.payload as Record<string, unknown>
    expect(payload.attemptNumber).toBe(1) // defaults to 1 when not provided
    expect(payload.storyKey).toBe('test-default-attempt')
  })

  it('uses "unknown" as storyKey when storyKey is not provided in the dispatch request', async () => {
    const hangingProc = createHangingProcess(22222)
    mockSpawn.mockReturnValue(hangingProc)

    const { eventBus, emittedEvents } = createRecordingEventBus()
    const adapter = createMockAdapter()
    const registry = createMockRegistry(adapter)

    const config: DispatchConfig = {
      maxConcurrency: 1,
      defaultTimeouts: { 'code-review': 15 },
    }

    const dispatcher = new DispatcherImpl(eventBus, registry, config, silentLogger)

    const handle = dispatcher.dispatch({
      prompt: 'no story key',
      agent: 'claude-code',
      taskType: 'code-review',
      // storyKey intentionally omitted
    })

    await handle.result

    const timeoutEvent = emittedEvents.find((e) => e.event === 'dispatch:spawnsync-timeout')
    expect(timeoutEvent).toBeDefined()

    const payload = timeoutEvent!.payload as Record<string, unknown>
    expect(payload.storyKey).toBe('unknown')
  })

  it('omits pid from event when process pid is 0 (falsy)', async () => {
    const hangingProc = createHangingProcess(0) // pid=0 → falsy, pid should not be included
    mockSpawn.mockReturnValue(hangingProc)

    const { eventBus, emittedEvents } = createRecordingEventBus()
    const adapter = createMockAdapter()
    const registry = createMockRegistry(adapter)

    const config: DispatchConfig = {
      maxConcurrency: 1,
      defaultTimeouts: { 'create-story': 15 },
    }

    const dispatcher = new DispatcherImpl(eventBus, registry, config, silentLogger)

    const handle = dispatcher.dispatch({
      prompt: 'zero pid test',
      agent: 'claude-code',
      taskType: 'create-story',
      storyKey: 'test-no-pid',
    })

    await handle.result

    const timeoutEvent = emittedEvents.find((e) => e.event === 'dispatch:spawnsync-timeout')
    expect(timeoutEvent).toBeDefined()

    const payload = timeoutEvent!.payload as Record<string, unknown>
    // pid must not be present when process.pid is 0 (falsy)
    expect(Object.prototype.hasOwnProperty.call(payload, 'pid')).toBe(false)
    expect(payload.storyKey).toBe('test-no-pid')
  })
})
