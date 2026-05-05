/**
 * Unit tests for tail-window buffer capture in DispatcherImpl.
 *
 * Story 66-5 (AC5, AC6, AC7): asserts that:
 * - stderr output is captured into a bounded tail-window buffer and attached
 *   to the `dispatch:spawnsync-timeout` event when a dispatch times out
 * - tail-window discipline drops leading bytes when the buffer exceeds 64KB,
 *   preserving the most recent bytes
 * - buffers are NOT surfaced when a subprocess exits cleanly (backward-compat)
 *
 * obs_2026-05-04_023 fix #4.
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
 * Create a fake ChildProcess that exits cleanly after the provided callback
 * has been called. The callback is used by the test to inspect the process
 * object before close fires.
 */
function createCleanExitProcess(pid = 54321) {
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

describe('DispatcherImpl — tail-window buffer capture (Story 66-5)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // Re-apply the execSync throw after clearAllMocks resets implementations
    mockExecSync.mockImplementation(() => {
      throw new Error('mock: execSync not available in test environment')
    })
  })

  // -------------------------------------------------------------------------
  // AC5: PROGRESS_MARKER captured in stderrTail on timeout
  // -------------------------------------------------------------------------
  it('captures PROGRESS_MARKER written to stderr before timeout kill (AC5)', async () => {
    const hangingProc = createHangingProcess(11111)
    mockSpawn.mockReturnValue(hangingProc)

    const { eventBus, emittedEvents } = createRecordingEventBus()
    const adapter = createMockAdapter()
    const registry = createMockRegistry(adapter)

    const timeoutMs = 50
    const config: DispatchConfig = {
      maxConcurrency: 1,
      defaultTimeouts: { 'probe-author': timeoutMs },
    }

    const dispatcher = new DispatcherImpl(eventBus, registry, config, silentLogger)

    // Dispatch — this registers the stderr data handler
    const handle = dispatcher.dispatch({
      prompt: 'test prompt',
      agent: 'claude-code',
      taskType: 'probe-author',
      storyKey: 'test-capture-5',
      attemptNumber: 1,
    })

    // Emit PROGRESS_MARKER to stderr before the timeout fires
    hangingProc.stderr.emit('data', Buffer.from('PROGRESS_MARKER\n'))

    // Wait for the timeout to fire and resolve
    const result = await handle.result

    expect(result.status).toBe('timeout')

    // Find the dispatch:spawnsync-timeout event
    const timeoutEvent = emittedEvents.find((e) => e.event === 'dispatch:spawnsync-timeout')
    expect(timeoutEvent).toBeDefined()

    const payload = timeoutEvent!.payload as Record<string, unknown>

    // stderrTail must contain PROGRESS_MARKER
    expect(typeof payload.stderrTail).toBe('string')
    expect(payload.stderrTail as string).toContain('PROGRESS_MARKER')
  })

  // -------------------------------------------------------------------------
  // AC6: tail-window discipline — 200KB → FINAL_MARKER preserved, INITIAL_MARKER dropped
  // -------------------------------------------------------------------------
  it('drops initial bytes and preserves final bytes when stderr exceeds 64KB cap (AC6)', async () => {
    const hangingProc = createHangingProcess(22222)
    mockSpawn.mockReturnValue(hangingProc)

    const { eventBus, emittedEvents } = createRecordingEventBus()
    const adapter = createMockAdapter()
    const registry = createMockRegistry(adapter)

    const timeoutMs = 80
    const config: DispatchConfig = {
      maxConcurrency: 1,
      defaultTimeouts: { 'probe-author': timeoutMs },
    }

    const dispatcher = new DispatcherImpl(eventBus, registry, config, silentLogger)

    // Dispatch — this registers the stderr data handler
    const handle = dispatcher.dispatch({
      prompt: 'test prompt',
      agent: 'claude-code',
      taskType: 'probe-author',
      storyKey: 'test-capture-6',
      attemptNumber: 1,
    })

    // Emit 200 chunks of 1024 bytes each (200KB total) to stderr.
    // First chunk: INITIAL_MARKER padded to 1024 bytes.
    // Middle chunks: 'x' fill.
    // Last chunk: FINAL_MARKER padded to 1024 bytes.
    const CHUNK_SIZE = 1024
    const TOTAL_CHUNKS = 200

    // First chunk: INITIAL_MARKER + fill
    const initialMarker = 'INITIAL_MARKER'
    const firstChunk = Buffer.from(initialMarker + 'x'.repeat(CHUNK_SIZE - initialMarker.length))
    hangingProc.stderr.emit('data', firstChunk)

    // Middle chunks: all 'x'
    for (let i = 1; i < TOTAL_CHUNKS - 1; i++) {
      hangingProc.stderr.emit('data', Buffer.from('x'.repeat(CHUNK_SIZE)))
    }

    // Last chunk: FINAL_MARKER + fill
    const finalMarker = 'FINAL_MARKER'
    const lastChunk = Buffer.from(finalMarker + 'x'.repeat(CHUNK_SIZE - finalMarker.length))
    hangingProc.stderr.emit('data', lastChunk)

    // Wait for the timeout to fire and resolve
    const result = await handle.result

    expect(result.status).toBe('timeout')

    // Find the dispatch:spawnsync-timeout event
    const timeoutEvent = emittedEvents.find((e) => e.event === 'dispatch:spawnsync-timeout')
    expect(timeoutEvent).toBeDefined()

    const payload = timeoutEvent!.payload as Record<string, unknown>
    const stderrTail = payload.stderrTail as string

    // FINAL_MARKER must be present — the final bytes are preserved
    expect(stderrTail).toContain('FINAL_MARKER')

    // INITIAL_MARKER must NOT be present — leading bytes were dropped by tail-window
    expect(stderrTail).not.toContain('INITIAL_MARKER')

    // Buffer cap: tail must be ≤ 64KB + 2KB slack (one chunk of slack)
    const MAX_TAIL_BUFFER = 64 * 1024
    expect(Buffer.byteLength(stderrTail, 'utf8')).toBeLessThanOrEqual(MAX_TAIL_BUFFER + 2048)
  })

  // -------------------------------------------------------------------------
  // AC7: backward-compat — clean exit does not surface stderrTail / stdoutTail
  // -------------------------------------------------------------------------
  it('does not surface stderrTail or stdoutTail when subprocess exits cleanly (AC7)', async () => {
    const cleanProc = createCleanExitProcess(33333)
    mockSpawn.mockReturnValue(cleanProc)

    const { eventBus, emittedEvents } = createRecordingEventBus()
    const adapter = createMockAdapter()
    const registry = createMockRegistry(adapter)

    // Long timeout so the subprocess exits before the timeout fires
    const config: DispatchConfig = {
      maxConcurrency: 1,
      defaultTimeouts: { 'probe-author': 5000 },
    }

    const dispatcher = new DispatcherImpl(eventBus, registry, config, silentLogger)

    const handle = dispatcher.dispatch({
      prompt: 'clean exit test',
      agent: 'claude-code',
      taskType: 'probe-author',
      storyKey: 'test-clean-exit',
      attemptNumber: 1,
    })

    // Emit some stderr output before the process exits
    cleanProc.stderr.emit('data', Buffer.from('some stderr output\n'))

    // Simulate the process writing valid YAML to stdout and exiting cleanly
    // The dispatcher normalizes stdout output; emit exit-code 0 via close
    cleanProc.stdout.emit('data', Buffer.from('result: success\nfiles_modified: []\n'))
    cleanProc.emit('close', 0)

    const result = await handle.result

    // Process exited cleanly — result must NOT be timeout
    expect(result.status).not.toBe('timeout')

    // dispatch:spawnsync-timeout event must NOT be emitted for clean exits
    const timeoutEvent = emittedEvents.find((e) => e.event === 'dispatch:spawnsync-timeout')
    expect(timeoutEvent).toBeUndefined()

    // No event should carry stderrTail or stdoutTail fields
    for (const { payload } of emittedEvents) {
      const p = payload as Record<string, unknown>
      expect(p).not.toHaveProperty('stderrTail')
      expect(p).not.toHaveProperty('stdoutTail')
    }
  })

  // -------------------------------------------------------------------------
  // Additional: stdoutTail is also captured and attached on timeout
  // -------------------------------------------------------------------------
  it('captures stdoutTail from stdout on timeout', async () => {
    const hangingProc = createHangingProcess(44444)
    mockSpawn.mockReturnValue(hangingProc)

    const { eventBus, emittedEvents } = createRecordingEventBus()
    const adapter = createMockAdapter()
    const registry = createMockRegistry(adapter)

    const timeoutMs = 50
    const config: DispatchConfig = {
      maxConcurrency: 1,
      defaultTimeouts: { 'probe-author': timeoutMs },
    }

    const dispatcher = new DispatcherImpl(eventBus, registry, config, silentLogger)

    const handle = dispatcher.dispatch({
      prompt: 'stdout capture test',
      agent: 'claude-code',
      taskType: 'probe-author',
      storyKey: 'test-stdout-capture',
      attemptNumber: 1,
    })

    // Emit a STDOUT_MARKER to stdout before the timeout fires
    hangingProc.stdout.emit('data', Buffer.from('STDOUT_MARKER\n'))

    const result = await handle.result

    expect(result.status).toBe('timeout')

    const timeoutEvent = emittedEvents.find((e) => e.event === 'dispatch:spawnsync-timeout')
    expect(timeoutEvent).toBeDefined()

    const payload = timeoutEvent!.payload as Record<string, unknown>

    // stdoutTail must be present and contain STDOUT_MARKER
    expect(typeof payload.stdoutTail).toBe('string')
    expect(payload.stdoutTail as string).toContain('STDOUT_MARKER')
  })
})
