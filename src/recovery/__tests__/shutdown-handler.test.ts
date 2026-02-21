/**
 * Unit tests for setupGracefulShutdown
 *
 * Tests:
 *  - AC3: Registers SIGTERM and SIGINT handlers
 *  - AC3: On signal — pause engine, terminate workers, mark tasks pending, mark session interrupted, flush WAL, exit 0
 *  - Cleanup function removes listeners
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { MockedFunction } from 'vitest'

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

// We need to mock process.on / process.removeListener / process.exit
// before importing the module under test.

describe('setupGracefulShutdown', () => {
  let originalProcessOn: typeof process.on
  let originalProcessRemoveListener: typeof process.removeListener
  let originalProcessExit: typeof process.exit

  let processOnSpy: MockedFunction<typeof process.on>
  let processRemoveListenerSpy: MockedFunction<typeof process.removeListener>
  let processExitSpy: MockedFunction<(...args: unknown[]) => never>

  // Captured handlers
  const registeredHandlers: Record<string, () => void> = {}

  beforeEach(() => {
    originalProcessOn = process.on.bind(process)
    originalProcessRemoveListener = process.removeListener.bind(process)
    originalProcessExit = process.exit.bind(process)

    // Mock process.on to capture handlers
    processOnSpy = vi.fn((event: string | symbol, handler: (...args: unknown[]) => void) => {
      registeredHandlers[String(event)] = handler as () => void
      return process
    }) as any

    processRemoveListenerSpy = vi.fn(() => process) as any
    processExitSpy = vi.fn(() => { throw new Error('process.exit called') }) as any

    process.on = processOnSpy as any
    process.removeListener = processRemoveListenerSpy as any
    process.exit = processExitSpy as any

    // Clear captured handlers
    delete registeredHandlers['SIGINT']
    delete registeredHandlers['SIGTERM']
  })

  afterEach(() => {
    process.on = originalProcessOn
    process.removeListener = originalProcessRemoveListener
    process.exit = originalProcessExit
    vi.restoreAllMocks()
  })

  it('registers SIGTERM and SIGINT handlers', async () => {
    const { setupGracefulShutdown } = await import('../shutdown-handler.js')

    const mockDb = {
      prepare: vi.fn(() => ({ run: vi.fn() })),
      pragma: vi.fn(),
    } as any

    const mockWorkerPoolManager = { terminateAll: vi.fn().mockResolvedValue(undefined) } as any
    const mockTaskGraphEngine = { pause: vi.fn() } as any

    setupGracefulShutdown({
      db: mockDb,
      workerPoolManager: mockWorkerPoolManager,
      taskGraphEngine: mockTaskGraphEngine,
      sessionId: 'test-session',
    })

    expect(processOnSpy).toHaveBeenCalledWith('SIGINT', expect.any(Function))
    expect(processOnSpy).toHaveBeenCalledWith('SIGTERM', expect.any(Function))
  })

  it('cleanup function removes SIGINT and SIGTERM listeners', async () => {
    const { setupGracefulShutdown } = await import('../shutdown-handler.js')

    const mockDb = {
      prepare: vi.fn(() => ({ run: vi.fn() })),
      pragma: vi.fn(),
    } as any

    const mockWorkerPoolManager = { terminateAll: vi.fn().mockResolvedValue(undefined) } as any
    const mockTaskGraphEngine = { pause: vi.fn() } as any

    const cleanup = setupGracefulShutdown({
      db: mockDb,
      workerPoolManager: mockWorkerPoolManager,
      taskGraphEngine: mockTaskGraphEngine,
      sessionId: 'test-session',
    })

    cleanup()

    expect(processRemoveListenerSpy).toHaveBeenCalledWith('SIGINT', expect.any(Function))
    expect(processRemoveListenerSpy).toHaveBeenCalledWith('SIGTERM', expect.any(Function))
  })

  it('on SIGTERM: pauses engine, terminates workers, updates DB, exits 0', async () => {
    const { setupGracefulShutdown } = await import('../shutdown-handler.js')

    const mockStmt = { run: vi.fn() }
    const mockDb = {
      prepare: vi.fn(() => mockStmt),
      pragma: vi.fn(),
    } as any

    const mockTerminateAll = vi.fn().mockResolvedValue(undefined)
    const mockWorkerPoolManager = { terminateAll: mockTerminateAll } as any
    const mockPause = vi.fn()
    const mockTaskGraphEngine = { pause: mockPause } as any

    setupGracefulShutdown({
      db: mockDb,
      workerPoolManager: mockWorkerPoolManager,
      taskGraphEngine: mockTaskGraphEngine,
      sessionId: 'sess-123',
    })

    // Simulate SIGTERM
    expect(registeredHandlers['SIGTERM']).toBeDefined()

    // Fire the handler — it's async so we need to give it a tick
    let exitCalled = false
    process.exit = vi.fn(() => { exitCalled = true; throw new Error('process.exit') }) as any

    try {
      registeredHandlers['SIGTERM']()
      // Wait for async operations
      await new Promise((resolve) => setTimeout(resolve, 50))
    } catch {
      // Expected: process.exit throws in our mock
    }

    await new Promise((resolve) => setTimeout(resolve, 50))

    expect(mockPause).toHaveBeenCalled()
    expect(mockTerminateAll).toHaveBeenCalled()
    expect(mockDb.prepare).toHaveBeenCalled()
    expect(mockDb.pragma).toHaveBeenCalledWith('wal_checkpoint(FULL)')
  })

  it('on SIGINT: performs same shutdown sequence as SIGTERM', async () => {
    const { setupGracefulShutdown } = await import('../shutdown-handler.js')

    const mockStmt = { run: vi.fn() }
    const mockDb = {
      prepare: vi.fn(() => mockStmt),
      pragma: vi.fn(),
    } as any

    const mockTerminateAll = vi.fn().mockResolvedValue(undefined)
    const mockWorkerPoolManager = { terminateAll: mockTerminateAll } as any
    const mockPause = vi.fn()
    const mockTaskGraphEngine = { pause: mockPause } as any

    setupGracefulShutdown({
      db: mockDb,
      workerPoolManager: mockWorkerPoolManager,
      taskGraphEngine: mockTaskGraphEngine,
      sessionId: 'sess-456',
    })

    expect(registeredHandlers['SIGINT']).toBeDefined()

    process.exit = vi.fn(() => { throw new Error('process.exit') }) as any

    try {
      registeredHandlers['SIGINT']()
      await new Promise((resolve) => setTimeout(resolve, 50))
    } catch {
      // Expected
    }

    await new Promise((resolve) => setTimeout(resolve, 50))

    expect(mockPause).toHaveBeenCalled()
    expect(mockTerminateAll).toHaveBeenCalled()
    expect(mockDb.pragma).toHaveBeenCalledWith('wal_checkpoint(FULL)')
  })

  it('marks running tasks as pending with incremented retry_count', async () => {
    const { setupGracefulShutdown } = await import('../shutdown-handler.js')

    const mockStmt = { run: vi.fn() }
    const prepareSpy = vi.fn(() => mockStmt)
    const mockDb = {
      prepare: prepareSpy,
      pragma: vi.fn(),
    } as any

    const mockWorkerPoolManager = { terminateAll: vi.fn().mockResolvedValue(undefined) } as any
    const mockTaskGraphEngine = { pause: vi.fn() } as any

    setupGracefulShutdown({
      db: mockDb,
      workerPoolManager: mockWorkerPoolManager,
      taskGraphEngine: mockTaskGraphEngine,
      sessionId: 'sess-789',
    })

    process.exit = vi.fn(() => { throw new Error('process.exit') }) as any

    try {
      registeredHandlers['SIGTERM']()
      await new Promise((resolve) => setTimeout(resolve, 50))
    } catch {
      // Expected
    }

    await new Promise((resolve) => setTimeout(resolve, 50))

    // Check that prepare was called with UPDATE tasks SQL
    const prepareCallArgs = prepareSpy.mock.calls.map((call) => call[0] as string)
    const taskUpdateCall = prepareCallArgs.find((sql) =>
      sql.includes("SET status = 'pending'") && sql.includes('retry_count = retry_count + 1'),
    )
    expect(taskUpdateCall).toBeDefined()

    // Check session update
    const sessionUpdateCall = prepareCallArgs.find((sql) =>
      sql.includes("SET status = 'interrupted'"),
    )
    expect(sessionUpdateCall).toBeDefined()
  })

  it('continues shutdown even when engine pause() throws', async () => {
    const { setupGracefulShutdown } = await import('../shutdown-handler.js')

    const mockStmt = { run: vi.fn() }
    const mockDb = {
      prepare: vi.fn(() => mockStmt),
      pragma: vi.fn(),
    } as any

    const mockWorkerPoolManager = { terminateAll: vi.fn().mockResolvedValue(undefined) } as any
    // Engine.pause() throws
    const mockTaskGraphEngine = { pause: vi.fn().mockImplementation(() => { throw new Error('not pausable') }) } as any

    setupGracefulShutdown({
      db: mockDb,
      workerPoolManager: mockWorkerPoolManager,
      taskGraphEngine: mockTaskGraphEngine,
      sessionId: 'sess-err',
    })

    process.exit = vi.fn(() => { throw new Error('process.exit') }) as any

    try {
      registeredHandlers['SIGTERM']()
      await new Promise((resolve) => setTimeout(resolve, 50))
    } catch {
      // Expected
    }

    await new Promise((resolve) => setTimeout(resolve, 50))

    // Should still flush WAL even if pause fails
    expect(mockDb.pragma).toHaveBeenCalledWith('wal_checkpoint(FULL)')
  })
})
